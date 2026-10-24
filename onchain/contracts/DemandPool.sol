// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DealFactory} from "./DealFactory.sol";
import {SwarmTypes} from "./SwarmTypes.sol";

interface ISettler {
    function creditWithdrawal(address buyer, uint256 amount) external;
}

/// @dev Minimal EIP-3009 surface we need from USDC.
interface IUSDC3009 is IERC20 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @dev Returns true if the nonce has been used (or cancelled) for the given authorizer.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function isBlacklisted(address account) external view returns (bool);
}

contract DemandPool is ReentrancyGuard {
    // Key constraints:
    // - All math in 6-decimal USDC micro-units; no msg.value anywhere
    // - No block.prevrandao (Arc always returns 0); no block.chainid checks
    // - ReentrancyGuard on commit, commitWithAuthorization, withdraw, pullForSettler
    // - Buyers order a quantity (units >= 1). Price tiers count total units ordered.
    // - paidPerUnit[buyer] = priceAt(totalUnits + units) — the price including the buyer's order.
    // - escrowed[dealId][buyer] = paidPerUnit * units
    // - tierCount[dealId][price] tracks buyers at each per-unit price for O(tiers) strand check
    // - WouldStrandBuyer: withdraw refused if any remaining buyer's paidPerUnit < newPrice
    //   where newPrice = priceAt(totalUnits - unitsOf[caller])
    // - One order per buyer; no adding to an existing order in v2
    // - Owner pause() (in factory) halts commit and commitWithAuthorization;
    //   withdraw/settle/refundAll/claim are never halted
    // - Pull payments: withdraw credits Settler.claimable, never transfers USDC directly
    //
    // gasless commit (EIP-3009):
    // - Uses receiveWithAuthorization: the payee check (to == msg.sender) means only
    //   the pool can submit the transfer, binding USDC movement to a commit.
    // - Nonce = keccak256(abi.encode(address(this), dealId, buyer, units, salt)).
    //   Binding units means a relayer cannot change how many units the signature buys.
    // - If authorized > live total (units * priceAfter): credit excess via creditWithdrawal.
    // - If authorized < live total: revert PriceRoseBeyondAuthorization(newTotal).

    DealFactory public immutable factory;
    IUSDC3009 public constant USDC = IUSDC3009(0x3600000000000000000000000000000000000000);

    // Per-deal order book
    mapping(uint256 => address[]) private _buyers;
    mapping(uint256 => mapping(address => uint256)) private _buyerIndex; // 1-based
    mapping(uint256 => uint32) public totalUnits;                        // running sum of units ordered
    mapping(uint256 => mapping(address => uint32)) public unitsOf;       // units ordered by buyer
    mapping(uint256 => mapping(address => uint64)) public paidPerUnit;   // per-unit price at commit
    mapping(uint256 => mapping(address => uint256)) public escrowed;     // paidPerUnit * units
    mapping(uint256 => mapping(uint64 => uint32)) public tierCount;      // buyers at each per-unit price

    address public owner;
    address public settler;
    bool public settlerSet;

    // ── Events ────────────────────────────────────────────────────────────────

    event Committed(
        uint256 indexed dealId,
        address indexed buyer,
        uint32  units,
        uint64  paidPerUnit,
        uint256 escrow,
        uint64  livePrice,
        uint32  totalUnits,
        uint32  buyerCount
    );
    event Withdrawn(
        uint256 indexed dealId,
        address indexed buyer,
        uint256 amountReturned,
        uint64  livePrice,
        uint32  totalUnits,
        uint32  buyerCount
    );
    event TierBroken(uint256 indexed dealId, uint32 newTotalUnits, uint64 newPrice);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SettlerSet(address indexed settler);
    /// @dev Emitted when a gasless commit's authorized amount exceeded the live cost.
    ///      The excess is credited to the buyer's claimable balance via the settler.
    event ExcessCredited(uint256 indexed dealId, address indexed buyer, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────

    error DealNotOpen();
    error DeadlinePassed();
    error AlreadyCommitted();
    error NotCommitted();
    error BuyerCapReached();
    error UnitCapReached();            // totalUnits + units > maxUnits
    error ZeroUnits();                 // units == 0
    error UnitsPerBuyerExceeded();     // units > maxUnitsPerBuyer when set
    error WouldStrandBuyer();
    error SettlerNotConfigured();
    error Unauthorized();
    error InvalidAddress();
    error SettlerAlreadySet();
    error TransferFailed();
    error Paused();
    /// @dev Price rose above authorized amount. `newTotal` is the new required payment = priceAfter * units.
    error PriceRoseBeyondAuthorization(uint256 newTotal);
    error AuthorizationAlreadyUsed();
    error Blocklisted();

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address dealFactory, address _owner) {
        if (dealFactory == address(0) || _owner == address(0)) revert InvalidAddress();
        factory = DealFactory(dealFactory);
        owner = _owner;
    }

    // ── Clearing price ────────────────────────────────────────────────────────

    /// @dev priceAt(units) = pricePerUnit of the highest tier whose minUnits <= units,
    ///      or tiers[0].pricePerUnit if below the first threshold.
    function _priceAt(uint256 dealId, uint256 units) private view returns (uint64) {
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);
        if (deal.tiers.length == 0) return 0;
        for (uint256 i = deal.tiers.length; i > 0; i--) {
            if (units >= deal.tiers[i - 1].minUnits) {
                return deal.tiers[i - 1].pricePerUnit;
            }
        }
        return deal.tiers[0].pricePerUnit;
    }

    /// @dev Live clearing price = priceAt(totalUnits).
    function clearingPrice(uint256 dealId) public view returns (uint64) {
        return _priceAt(dealId, totalUnits[dealId]);
    }

    // ── Shared commit logic ───────────────────────────────────────────────────

    function _checkCommitPreconditions(
        uint256 dealId,
        address buyer,
        uint32  units
    ) private view {
        if (!settlerSet) revert SettlerNotConfigured();
        if (factory.paused()) revert Paused();
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);
        if (deal.state != 0) revert DealNotOpen();
        if (block.timestamp >= deal.deadline) revert DeadlinePassed();
        if (_buyerIndex[dealId][buyer] != 0) revert AlreadyCommitted();
        if (_buyers[dealId].length >= deal.maxBuyers) revert BuyerCapReached();
        if (units == 0) revert ZeroUnits();
        if (deal.maxUnitsPerBuyer != 0 && units > deal.maxUnitsPerBuyer) revert UnitsPerBuyerExceeded();
        if (uint256(totalUnits[dealId]) + uint256(units) > uint256(deal.maxUnits)) revert UnitCapReached();
    }

    /**
     * @dev Core state mutation shared by commit() and commitWithAuthorization().
     *      All preconditions must be checked before calling.
     *      @return priceAfterPerUnit  The per-unit price actually escrowed.
     *      @return escrowAmount       priceAfterPerUnit * units (total USDC to be taken from buyer).
     */
    function _doCommit(
        uint256 dealId,
        address buyer,
        uint32  units
    ) private returns (uint64 priceAfterPerUnit, uint256 escrowAmount) {
        uint64 priceBefore = _priceAt(dealId, totalUnits[dealId]);

        // Add units first so that priceAt reflects the buyer's own contribution.
        totalUnits[dealId] += units;

        priceAfterPerUnit = _priceAt(dealId, totalUnits[dealId]);
        escrowAmount      = uint256(priceAfterPerUnit) * uint256(units);

        _buyers[dealId].push(buyer);
        _buyerIndex[dealId][buyer]  = _buyers[dealId].length;
        unitsOf[dealId][buyer]      = units;
        paidPerUnit[dealId][buyer]  = priceAfterPerUnit;
        escrowed[dealId][buyer]     = escrowAmount;
        tierCount[dealId][priceAfterPerUnit] += 1;

        if (priceAfterPerUnit != priceBefore) {
            emit TierBroken(dealId, totalUnits[dealId], priceAfterPerUnit);
        }

        emit Committed(
            dealId,
            buyer,
            units,
            priceAfterPerUnit,
            escrowAmount,
            priceAfterPerUnit,
            totalUnits[dealId],
            uint32(_buyers[dealId].length)
        );
    }

    // ── commit (standard approve + transferFrom) ──────────────────────────────

    function commit(uint256 dealId, uint32 units) external nonReentrant {
        _checkCommitPreconditions(dealId, msg.sender, units);

        (, uint256 escrowAmount) = _doCommit(dealId, msg.sender, units);

        bool ok = USDC.transferFrom(msg.sender, address(this), escrowAmount);
        if (!ok) revert TransferFailed();
    }

    // ── commitWithAuthorization (EIP-3009 gasless) ────────────────────────────

    /**
     * @dev Derive the EIP-3009 nonce for a gasless commit. Binds this contract,
     *      dealId, buyer, units and a caller-supplied salt into a single bytes32.
     *      Changing any of these values produces a different nonce; a relayer
     *      cannot change how many units the buyer's signature covers.
     */
    function authorizationNonce(
        uint256 dealId,
        address buyer,
        uint32  units,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), dealId, buyer, units, salt));
    }

    /**
     * @dev Gasless commit. The buyer signs a ReceiveWithAuthorization for
     *      `authorizedAmount` USDC to this contract covering `units` units.
     *      A relayer submits and pays gas; the buyer is the signer, never msg.sender.
     *
     *      If authorized > priceAfter * units: escrow the live cost, credit excess.
     *      If authorized < priceAfter * units: revert PriceRoseBeyondAuthorization(newTotal).
     */
    struct AuthParams {
        uint256 dealId;
        address buyer;
        uint32  units;
        uint256 authorizedAmount;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 salt;
        uint8   v;
        bytes32 r;
        bytes32 s;
    }

    function commitWithAuthorization(
        uint256 dealId,
        address buyer,
        uint32  units,
        uint256 authorizedAmount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _commitWithAuth(AuthParams({
            dealId:           dealId,
            buyer:            buyer,
            units:            units,
            authorizedAmount: authorizedAmount,
            validAfter:       validAfter,
            validBefore:      validBefore,
            salt:             salt,
            v:                v,
            r:                r,
            s:                s
        }));
    }

    function _commitWithAuth(AuthParams memory a) private {
        // Screen for blocklisted addresses first.
        if (USDC.isBlacklisted(a.buyer) || USDC.isBlacklisted(msg.sender)) revert Blocklisted();

        // Pre-check nonce before preconditions so replay → AuthorizationAlreadyUsed.
        bytes32 nonce = authorizationNonce(a.dealId, a.buyer, a.units, a.salt);
        if (USDC.authorizationState(a.buyer, nonce)) revert AuthorizationAlreadyUsed();

        _checkCommitPreconditions(a.dealId, a.buyer, a.units);

        // Peek at cost with buyer's units included.
        uint256 requiredTotal = uint256(_priceAt(a.dealId, uint256(totalUnits[a.dealId]) + uint256(a.units))) * uint256(a.units);
        if (a.authorizedAmount < requiredTotal) {
            revert PriceRoseBeyondAuthorization(requiredTotal);
        }

        // Pull exactly authorizedAmount from the buyer.
        USDC.receiveWithAuthorization(
            a.buyer,
            address(this),
            a.authorizedAmount,
            a.validAfter,
            a.validBefore,
            nonce,
            a.v, a.r, a.s
        );

        // Record the commit.
        (, uint256 escrowAmount) = _doCommit(a.dealId, a.buyer, a.units);

        // Credit any excess back to the buyer.
        uint256 excess = a.authorizedAmount - escrowAmount;
        if (excess > 0) {
            ISettler(settler).creditWithdrawal(a.buyer, excess);
            emit ExcessCredited(a.dealId, a.buyer, excess);
        }
    }

    // ── withdraw ──────────────────────────────────────────────────────────────

    /// @dev Returns the lowest paidPerUnit among remaining buyers, excluding the caller's tier.
    function _lowestPaidExcluding(
        uint256 dealId,
        SwarmTypes.Tier[] memory tiers,
        uint64  excludePrice
    ) private view returns (uint64 lowest) {
        for (uint256 i = tiers.length; i > 0; i--) {
            uint64 tp  = tiers[i - 1].pricePerUnit;
            uint32 cnt = tierCount[dealId][tp];
            if (tp == excludePrice && cnt > 0) cnt -= 1;
            if (cnt > 0) return tp;
        }
        return 0;
    }

    function _removeBuyer(uint256 dealId, address buyer, uint256 buyerPos) private returns (uint256) {
        uint256 lastIdx = _buyers[dealId].length - 1;
        uint256 idx     = buyerPos - 1;
        if (idx != lastIdx) {
            address last = _buyers[dealId][lastIdx];
            _buyers[dealId][idx]       = last;
            _buyerIndex[dealId][last]  = idx + 1;
        }
        _buyers[dealId].pop();
        delete _buyerIndex[dealId][buyer];
        return _buyers[dealId].length;
    }

    function withdraw(uint256 dealId) external nonReentrant {
        if (!settlerSet) revert SettlerNotConfigured();

        SwarmTypes.Deal memory deal = factory.getDeal(dealId);
        if (deal.state != 0) revert DealNotOpen();
        if (block.timestamp >= deal.deadline) revert DeadlinePassed();

        uint256 buyerPos = _buyerIndex[dealId][msg.sender];
        if (buyerPos == 0) revert NotCommitted();

        uint32 units   = unitsOf[dealId][msg.sender];
        uint32 newTotal = totalUnits[dealId] - units;
        uint64 newPrice = _priceAt(dealId, newTotal);

        // Strand check: any remaining buyer whose paidPerUnit < newPrice would be undercharged.
        if (_buyers[dealId].length > 1) {
            uint64 lowest = _lowestPaidExcluding(dealId, deal.tiers, paidPerUnit[dealId][msg.sender]);
            if (lowest > 0 && lowest < newPrice) revert WouldStrandBuyer();
        }

        uint256 escrowAmt   = escrowed[dealId][msg.sender];
        uint64  paid        = paidPerUnit[dealId][msg.sender];
        uint64  priceBefore = _priceAt(dealId, totalUnits[dealId]);

        totalUnits[dealId] = newTotal;
        _removeBuyer(dealId, msg.sender, buyerPos);
        tierCount[dealId][paid] -= 1;
        delete escrowed[dealId][msg.sender];
        delete unitsOf[dealId][msg.sender];
        delete paidPerUnit[dealId][msg.sender];

        uint64 priceAfter  = _priceAt(dealId, newTotal);
        uint32 buyerCount  = uint32(_buyers[dealId].length);
        if (priceAfter != priceBefore) {
            emit TierBroken(dealId, newTotal, priceAfter);
        }

        ISettler(settler).creditWithdrawal(msg.sender, escrowAmt);
        emit Withdrawn(dealId, msg.sender, escrowAmt, priceAfter, newTotal, buyerCount);
    }

    // ── settler helpers ───────────────────────────────────────────────────────

    function pullForSettler(address to, uint256 amount) external nonReentrant {
        if (msg.sender != settler) revert Unauthorized();
        bool ok = USDC.transfer(to, amount);
        if (!ok) revert TransferFailed();
    }

    // ── view helpers ──────────────────────────────────────────────────────────

    function getBuyers(uint256 dealId) external view returns (address[] memory) {
        return _buyers[dealId];
    }

    function getBuyerCount(uint256 dealId) external view returns (uint32) {
        return uint32(_buyers[dealId].length);
    }

    // ── admin ─────────────────────────────────────────────────────────────────

    function setSettler(address _settler) external onlyOwner {
        if (settlerSet) revert SettlerAlreadySet();
        if (_settler == address(0)) revert InvalidAddress();
        settler  = _settler;
        settlerSet = true;
        emit SettlerSet(_settler);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
