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
    // - A buyer who already has an order adds a lot rather than reverting.
    // - paidPerUnit[buyer] = min across lots (lowest lot price so far)
    // - escrowed[dealId][buyer] = sum of (lotPrice * lotUnits) across all lots
    // - tierCount[dealId][price] tracks buyers at each per-unit price for O(tiers) strand check
    //   (a buyer moves from old paidPerUnit to new one when a top-up lowers it)
    // - WouldStrandBuyer: withdraw refused if any remaining buyer's paidPerUnit < newPrice
    //   where newPrice = priceAt(totalUnits - units)
    //   For a partial withdrawal the caller is "remaining" and also checked.
    // - Owner pause() (in factory) halts commit and commitWithAuthorization;
    //   withdraw/settle/refundAll/claim are never halted
    // - Withdraw pays out immediately via low-level call; falls back to creditWithdrawal if
    //   the direct transfer fails (e.g. blocklisted address).
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
    mapping(uint256 => mapping(address => uint32)) public unitsOf;       // units ordered by buyer (sum of lots)
    mapping(uint256 => mapping(address => uint64)) public paidPerUnit;   // lowest per-unit price across lots
    mapping(uint256 => mapping(address => uint256)) public escrowed;     // sum of (lotPrice * lotUnits)
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
    /// @dev Emitted on every withdrawal (partial or full).
    ///      paidDirectly=true: USDC sent straight to buyer.
    ///      paidDirectly=false: credited via settler.claimable (e.g. blocklisted address).
    event Withdrawn(
        uint256 indexed dealId,
        address indexed buyer,
        uint32  units,
        uint256 amountReturned,
        bool    paidDirectly,
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
    error NotCommitted();
    error BuyerCapReached();
    error UnitCapReached();            // totalUnits + units > maxUnits
    error ZeroUnits();                 // units == 0
    error UnitsPerBuyerExceeded();     // buyer's total units > maxUnitsPerBuyer when set
    error WithdrawInvalidUnits();      // units == 0 or units > unitsOf[buyer]
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

    /// @dev Checks preconditions common to both new orders and top-ups.
    ///      isTopUp=true skips the maxBuyers check (buyer is already counted).
    function _checkCommitPreconditions(
        uint256 dealId,
        address buyer,
        uint32  units,
        bool    isTopUp
    ) private view {
        if (!settlerSet) revert SettlerNotConfigured();
        if (factory.paused()) revert Paused();
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);
        if (deal.state != 0) revert DealNotOpen();
        if (block.timestamp >= deal.deadline) revert DeadlinePassed();
        if (!isTopUp && _buyers[dealId].length >= deal.maxBuyers) revert BuyerCapReached();
        if (units == 0) revert ZeroUnits();
        // Per-buyer limit applies to the buyer's TOTAL units (existing + new lot)
        uint32 totalBuyerUnits = unitsOf[dealId][buyer] + units;
        if (deal.maxUnitsPerBuyer != 0 && totalBuyerUnits > deal.maxUnitsPerBuyer) revert UnitsPerBuyerExceeded();
        if (uint256(totalUnits[dealId]) + uint256(units) > uint256(deal.maxUnits)) revert UnitCapReached();
    }

    /**
     * @dev Core state mutation shared by commit() and commitWithAuthorization().
     *      All preconditions must be checked before calling.
     *      Handles both new orders (buyer not yet in list) and top-ups (buyer already has an order).
     *
     *      @return lotPricePerUnit  The per-unit price for this lot.
     *      @return lotEscrow        lotPricePerUnit * units (USDC to take from buyer for this lot).
     */
    function _doCommit(
        uint256 dealId,
        address buyer,
        uint32  units
    ) private returns (uint64 lotPricePerUnit, uint256 lotEscrow) {
        uint64 priceBefore = _priceAt(dealId, totalUnits[dealId]);

        // Add units first so that priceAt reflects the buyer's own contribution.
        totalUnits[dealId] += units;

        lotPricePerUnit = _priceAt(dealId, totalUnits[dealId]);
        lotEscrow       = uint256(lotPricePerUnit) * uint256(units);

        if (_buyerIndex[dealId][buyer] == 0) {
            _recordNewBuyer(dealId, buyer, units, lotPricePerUnit, lotEscrow);
        } else {
            _recordTopUp(dealId, buyer, units, lotPricePerUnit, lotEscrow);
        }

        if (lotPricePerUnit != priceBefore) {
            emit TierBroken(dealId, totalUnits[dealId], lotPricePerUnit);
        }

        emit Committed(
            dealId,
            buyer,
            units,
            lotPricePerUnit,
            lotEscrow,
            lotPricePerUnit,
            totalUnits[dealId],
            uint32(_buyers[dealId].length)
        );
    }

    /// @dev Record a brand-new buyer in all mappings.
    function _recordNewBuyer(
        uint256 dealId,
        address buyer,
        uint32  units,
        uint64  lotPrice,
        uint256 lotEscrow
    ) private {
        _buyers[dealId].push(buyer);
        _buyerIndex[dealId][buyer] = _buyers[dealId].length;
        unitsOf[dealId][buyer]     = units;
        paidPerUnit[dealId][buyer] = lotPrice;
        escrowed[dealId][buyer]    = lotEscrow;
        tierCount[dealId][lotPrice] += 1;
    }

    /// @dev Record a top-up lot for an existing buyer.
    ///      Accumulates units and escrow; lowers paidPerUnit if this lot is cheaper.
    function _recordTopUp(
        uint256 dealId,
        address buyer,
        uint32  units,
        uint64  lotPrice,
        uint256 lotEscrow
    ) private {
        uint64 oldPaid = paidPerUnit[dealId][buyer];
        unitsOf[dealId][buyer]  += units;
        escrowed[dealId][buyer] += lotEscrow;

        if (lotPrice < oldPaid) {
            // Move tally entry to the new (lower) price
            tierCount[dealId][oldPaid]  -= 1;
            tierCount[dealId][lotPrice] += 1;
            paidPerUnit[dealId][buyer]   = lotPrice;
        }
        // If lotPrice >= oldPaid the tally entry stays at oldPaid; paidPerUnit unchanged.
    }

    // ── commit (standard approve + transferFrom) ──────────────────────────────

    function commit(uint256 dealId, uint32 units) external nonReentrant {
        bool isTopUp = _buyerIndex[dealId][msg.sender] != 0;
        _checkCommitPreconditions(dealId, msg.sender, units, isTopUp);

        (, uint256 lotEscrow) = _doCommit(dealId, msg.sender, units);

        bool ok = USDC.transferFrom(msg.sender, address(this), lotEscrow);
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
     *
     *      Top-ups are handled the same way as standard commits.
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

        bool isTopUp = _buyerIndex[a.dealId][a.buyer] != 0;
        _checkCommitPreconditions(a.dealId, a.buyer, a.units, isTopUp);

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

        // Record the commit (lot).
        (, uint256 lotEscrow) = _doCommit(a.dealId, a.buyer, a.units);

        // Credit any excess back to the buyer.
        uint256 excess = a.authorizedAmount - lotEscrow;
        if (excess > 0) {
            ISettler(settler).creditWithdrawal(a.buyer, excess);
            emit ExcessCredited(a.dealId, a.buyer, excess);
        }
    }

    // ── withdraw ──────────────────────────────────────────────────────────────

    /// @dev Returns the lowest paidPerUnit among remaining buyers, excluding the
    ///      caller's tier if they are doing a full withdrawal.
    ///      For a partial withdrawal the caller stays in the deal, so we do NOT
    ///      exclude them here — _lowestPaidIncludingAll is used instead.
    function _lowestPaidExcluding(
        uint256 dealId,
        SwarmTypes.Tier[] memory tiers,
        uint64  excludePrice
    ) private view returns (uint64) {
        for (uint256 i = tiers.length; i > 0; i--) {
            uint64 tp  = tiers[i - 1].pricePerUnit;
            uint32 cnt = tierCount[dealId][tp];
            if (tp == excludePrice && cnt > 0) cnt -= 1;
            if (cnt > 0) return tp;
        }
        return 0;
    }

    /// @dev Returns the lowest paidPerUnit among ALL remaining buyers (partial
    ///      withdrawal: the caller stays, so their paidPerUnit is included).
    function _lowestPaidAll(
        uint256 dealId,
        SwarmTypes.Tier[] memory tiers
    ) private view returns (uint64) {
        for (uint256 i = tiers.length; i > 0; i--) {
            uint64 tp  = tiers[i - 1].pricePerUnit;
            if (tierCount[dealId][tp] > 0) return tp;
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

    /**
     * @dev Withdraw `units` from the caller's order in deal `dealId`.
     *
     *      units must be 1..unitsOf[caller].
     *
     *      Full withdrawal (units == unitsOf):
     *        - Removes buyer from the list and clears all their mappings.
     *        - Returns the full escrowed amount.
     *
     *      Partial withdrawal (units < unitsOf):
     *        - returned = escrowed * units / unitsOf  (rounded down)
     *        - Reduces escrowed, unitsOf, totalUnits.
     *        - Leaves paidPerUnit and tierCount unchanged.
     *        - Buyer stays in the deal.
     *
     *      Strand rule: refuses if priceAt(totalUnits - units) would exceed any
     *      remaining buyer's paidPerUnit. For a partial withdrawal "remaining"
     *      includes the caller.
     *
     *      Payment: attempts a direct low-level USDC transfer to the caller.
     *      If that fails (e.g. blocklisted), credits via settler.claimable instead.
     */
    function withdraw(uint256 dealId, uint32 units) external nonReentrant {
        if (!settlerSet) revert SettlerNotConfigured();

        SwarmTypes.Deal memory deal = factory.getDeal(dealId);
        if (deal.state != 0) revert DealNotOpen();
        if (block.timestamp >= deal.deadline) revert DeadlinePassed();

        uint256 buyerPos = _buyerIndex[dealId][msg.sender];
        if (buyerPos == 0) revert NotCommitted();

        uint32 myUnits = unitsOf[dealId][msg.sender];
        if (units == 0 || units > myUnits) revert WithdrawInvalidUnits();

        bool isFull    = (units == myUnits);
        uint32 newTotal = totalUnits[dealId] - units;
        uint64 newPrice = _priceAt(dealId, newTotal);

        uint256 escrowAmt = escrowed[dealId][msg.sender];

        // ── Strand check ──────────────────────────────────────────────────────
        if (_buyers[dealId].length > 1 || !isFull) {
            // For a full withdrawal: check remaining buyers (excluding caller's tally).
            // For a partial withdrawal: check ALL remaining buyers including caller
            //   (caller stays; their paidPerUnit must still be >= newPrice).
            uint64 lowest;
            if (isFull) {
                uint64 paid = paidPerUnit[dealId][msg.sender];
                lowest = _lowestPaidExcluding(dealId, deal.tiers, paid);
            } else {
                lowest = _lowestPaidAll(dealId, deal.tiers);
            }
            if (lowest > 0 && lowest < newPrice) revert WouldStrandBuyer();
        }

        uint64 priceBefore = _priceAt(dealId, totalUnits[dealId]);

        // ── Amount to return ──────────────────────────────────────────────────
        // Full: return entire escrow. Partial: proportional average, rounded down.
        uint256 returned = isFull ? escrowAmt : (escrowAmt * uint256(units)) / uint256(myUnits);

        // ── State update (before transfer, nonReentrant held) ─────────────────
        totalUnits[dealId] = newTotal;

        if (isFull) {
            _removeBuyer(dealId, msg.sender, buyerPos);
            tierCount[dealId][paidPerUnit[dealId][msg.sender]] -= 1;
            delete escrowed[dealId][msg.sender];
            delete unitsOf[dealId][msg.sender];
            delete paidPerUnit[dealId][msg.sender];
        } else {
            escrowed[dealId][msg.sender] -= returned;
            unitsOf[dealId][msg.sender]  -= units;
            // paidPerUnit and tierCount unchanged for partial withdrawal
        }

        uint64 priceAfter = _priceAt(dealId, newTotal);
        uint32 buyerCount = uint32(_buyers[dealId].length);

        if (priceAfter != priceBefore) {
            emit TierBroken(dealId, newTotal, priceAfter);
        }

        // ── Pay out immediately ───────────────────────────────────────────────
        // Try a direct low-level call. The USDC ABI uses transfer(address,uint256) → bool.
        // Check both call success and returned bool; fall back to creditWithdrawal if either fails.
        bool paidDirectly = _tryDirectTransfer(msg.sender, returned);
        if (!paidDirectly) {
            ISettler(settler).creditWithdrawal(msg.sender, returned);
        }

        emit Withdrawn(dealId, msg.sender, units, returned, paidDirectly, priceAfter, newTotal, buyerCount);
    }

    /// @dev Attempt to transfer `amount` USDC directly to `to` with a low-level call.
    ///      Returns true only when call succeeds AND the returned bool is true.
    ///      Never reverts.
    function _tryDirectTransfer(address to, uint256 amount) private returns (bool) {
        if (amount == 0) return true; // nothing to send; trivially "paid"
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, to, amount);
        (bool callOk, bytes memory ret) = address(USDC).call(data);
        if (!callOk) return false;
        // transfer() returns a bool; decode it if present, otherwise treat as true (ERC-20 standard)
        if (ret.length == 0) return true;
        return abi.decode(ret, (bool));
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
