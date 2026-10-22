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
    ///      Exists on the real Arc USDC implementation.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function isBlacklisted(address account) external view returns (bool);
}

contract DemandPool is ReentrancyGuard {
    // Key constraints:
    // - All math in 6-decimal USDC micro-units; no msg.value anywhere
    // - No block.prevrandao (Arc always returns 0)
    // - ReentrancyGuard on commit, commitWithAuthorization, withdraw, pullForSettler
    // - Commit-time escrow: each buyer pays clearingPrice(post-add); stored in escrowed[dealId][buyer]
    // - tierCount[dealId][price] tracks buyers at each price tier for O(tiers) WouldStrandBuyer check
    // - WouldStrandBuyer: withdraw refused if any remaining buyer escrowed less than newPrice
    // - One commit per address per deal; swap-and-pop with index update for removal
    // - Owner pause() (in factory) halts commit and commitWithAuthorization;
    //   withdraw/settle/refundAll/claim are never halted
    // - Pull payments everywhere: withdraw() credits Settler.claimable, never transfers USDC directly
    // - commit() and commitWithAuthorization() revert SettlerNotConfigured if settler not yet wired
    //
    // gasless commit (EIP-3009):
    // - Uses receiveWithAuthorization (NOT transferWithAuthorization): the payee check
    //   (`to == msg.sender`) means only the pool can submit the transfer, binding the
    //   USDC movement to a commit. transferWithAuthorization could be submitted directly
    //   to the USDC contract by anyone, depositing funds with no commit recorded.
    // - The EIP-3009 nonce is keccak256(abi.encode(address(this), dealId, buyer, salt)).
    //   Changing dealId or the pool address changes the nonce, invalidating the signature
    //   for any other deal or contract. A relayer cannot redirect a signed commit.
    // - If authorized amount > live price: escrow live price, credit excess via ISettler.creditWithdrawal.
    // - If authorized amount < live price: revert PriceRoseBeyondAuthorization(newPrice).
    // - A reused nonce hits USDC's replay guard, which we surface as AuthorizationAlreadyUsed.

    DealFactory public immutable factory;
    IUSDC3009 public constant USDC = IUSDC3009(0x3600000000000000000000000000000000000000);

    mapping(uint256 => address[]) private _buyers;
    mapping(uint256 => mapping(address => uint256)) private _buyerIndex; // 1-based
    mapping(uint256 => mapping(address => uint64)) public escrowed; // per-buyer commit price
    mapping(uint256 => mapping(uint64 => uint32)) public tierCount; // buyers escrowed at each price

    address public owner;
    address public settler;
    bool public settlerSet;

    event Committed(
        uint256 indexed dealId,
        address indexed buyer,
        uint64 pricePaid,
        uint64 livePrice,
        uint32 buyerCount
    );
    event Withdrawn(
        uint256 indexed dealId,
        address indexed buyer,
        uint64 amountReturned,
        uint64 livePrice,
        uint32 buyerCount
    );
    event TierBroken(uint256 indexed dealId, uint32 newBuyerCount, uint64 newPrice);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SettlerSet(address indexed settler);
    /// @dev Emitted when a gasless commit's authorized amount exceeded the live
    ///      price. The excess is credited to the buyer's claimable balance via the
    ///      settler so the proof page can account for every dollar received.
    event ExcessCredited(uint256 indexed dealId, address indexed buyer, uint256 amount);

    error DealNotOpen();
    error DeadlinePassed();
    error AlreadyCommitted();
    error NotCommitted();
    error BuyerCapReached();
    error WouldStrandBuyer();
    error SettlerNotConfigured();
    error Unauthorized();
    error InvalidAddress();
    error SettlerAlreadySet();
    error TransferFailed();
    error Paused();
    /// @dev The price rose above the authorized amount between signing and landing.
    ///      The relayer must re-quote, ask the buyer to re-sign, and retry.
    error PriceRoseBeyondAuthorization(uint64 requiredPrice);
    /// @dev The EIP-3009 authorization nonce was already consumed.
    error AuthorizationAlreadyUsed();
    /// @dev One or both addresses involved in the commit are USDC-blocklisted.
    error Blocklisted();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address dealFactory, address _owner) {
        if (dealFactory == address(0) || _owner == address(0)) revert InvalidAddress();
        factory = DealFactory(dealFactory);
        owner = _owner;
    }

    // ── Clearing price ────────────────────────────────────────────────────────

    function _clearingPriceAt(uint256 dealId, uint256 count) private view returns (uint64) {
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);

        if (deal.tiers.length == 0) {
            return 0;
        }

        for (uint256 i = deal.tiers.length; i > 0; i--) {
            if (count >= deal.tiers[i - 1].minBuyers) {
                return deal.tiers[i - 1].pricePerUnit;
            }
        }

        return deal.tiers[0].pricePerUnit;
    }

    function clearingPrice(uint256 dealId) public view returns (uint64) {
        return _clearingPriceAt(dealId, _buyers[dealId].length);
    }

    // ── Shared commit logic ───────────────────────────────────────────────────

    /**
     * @dev Core state mutation shared by commit() and commitWithAuthorization().
     *      All preconditions have been checked before this is called.
     *      Returns the price actually escrowed.
     */
    function _doCommit(uint256 dealId, address buyer) private returns (uint64 priceAfter) {
        uint64 priceBefore = _clearingPriceAt(dealId, _buyers[dealId].length);

        _buyers[dealId].push(buyer);
        _buyerIndex[dealId][buyer] = _buyers[dealId].length;

        priceAfter = _clearingPriceAt(dealId, _buyers[dealId].length);

        escrowed[dealId][buyer] = priceAfter;
        tierCount[dealId][priceAfter] += 1;

        if (priceAfter != priceBefore) {
            emit TierBroken(dealId, uint32(_buyers[dealId].length), priceAfter);
        }

        emit Committed(dealId, buyer, priceAfter, priceAfter, uint32(_buyers[dealId].length));
    }

    function _checkCommitPreconditions(uint256 dealId, address buyer) private view {
        if (!settlerSet) revert SettlerNotConfigured();
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);
        if (deal.state != 0) revert DealNotOpen();
        if (block.timestamp >= deal.deadline) revert DeadlinePassed();
        if (_buyerIndex[dealId][buyer] != 0) revert AlreadyCommitted();
        if (_buyers[dealId].length >= deal.cap) revert BuyerCapReached();
        if (factory.paused()) revert Paused();
    }

    // ── commit (standard approve + transferFrom) ──────────────────────────────

    function commit(uint256 dealId) external nonReentrant {
        _checkCommitPreconditions(dealId, msg.sender);

        uint64 priceAfter = _doCommit(dealId, msg.sender);

        bool ok = USDC.transferFrom(msg.sender, address(this), priceAfter);
        if (!ok) revert TransferFailed();
    }

    // ── commitWithAuthorization (EIP-3009 gasless) ────────────────────────────

    /**
     * @dev Derive the EIP-3009 nonce that a buyer must use when signing for a
     *      specific deal. Commits this contract address, dealId, buyer, and a
     *      caller-supplied salt into a single bytes32.
     *
     *      Binding address(this) and dealId means the same signature cannot be
     *      replayed against a different deal or a different pool contract.
     *      The salt lets the buyer sign multiple times for the same deal (e.g.
     *      after a PriceRoseBeyondAuthorization revert) without nonce collision.
     */
    function authorizationNonce(
        uint256 dealId,
        address buyer,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), dealId, buyer, salt));
    }

    /**
     * @dev Gasless commit. The buyer signs a ReceiveWithAuthorization for
     *      `authorizedAmount` USDC to this contract. A relayer submits this
     *      transaction and pays gas; the buyer is the signer, never msg.sender.
     *
     *      The authorized amount must be at least the live clearing price. If it
     *      is larger (because the price fell between signing and landing), the
     *      excess is credited to the buyer's claimable balance — the buyer pays
     *      only the clearing price, just as with a standard commit.
     *
     *      If the price has risen above authorizedAmount, reverts with
     *      PriceRoseBeyondAuthorization(newPrice) so the relayer can re-quote.
     *
     * @param dealId          The deal to commit to.
     * @param buyer           The signer (their USDC is moved; they are recorded as the committer).
     * @param authorizedAmount The value field in the signed authorization.
     * @param validAfter      EIP-3009 validAfter.
     * @param validBefore     EIP-3009 validBefore.
     * @param salt            Mixed into the nonce; the buyer must use the same salt when signing.
     * @param v,r,s           The buyer's signature over the ReceiveWithAuthorization struct.
     */
    function commitWithAuthorization(
        uint256 dealId,
        address buyer,
        uint256 authorizedAmount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        // Screen for blocklisted addresses before doing anything — a blocklisted
        // address causes the USDC transfer to revert and still burns gas.
        if (USDC.isBlacklisted(buyer) || USDC.isBlacklisted(msg.sender)) revert Blocklisted();

        // Derive the nonce and check for replay BEFORE the commit preconditions
        // (before AlreadyCommitted), so that a relayer replaying a spent nonce gets
        // AuthorizationAlreadyUsed rather than AlreadyCommitted — a cleaner signal.
        bytes32 nonce = authorizationNonce(dealId, buyer, salt);
        if (USDC.authorizationState(buyer, nonce)) revert AuthorizationAlreadyUsed();

        _checkCommitPreconditions(dealId, buyer);

        // We need to know the price before we move state, so peek at
        // what the price will be after adding the buyer.
        uint64 priceAfter = _clearingPriceAt(dealId, _buyers[dealId].length + 1);

        // Revert early if the signed amount won't cover it — before any state change.
        if (authorizedAmount < uint256(priceAfter)) {
            revert PriceRoseBeyondAuthorization(priceAfter);
        }

        // Pull exactly authorizedAmount from the buyer via receiveWithAuthorization.
        USDC.receiveWithAuthorization(
            buyer,
            address(this),
            authorizedAmount,
            validAfter,
            validBefore,
            nonce,
            v, r, s
        );

        // Now record the commit. The price is computed again inside _doCommit
        // from the actual post-add count; it must match what we computed above
        // (same block, count increased by exactly 1).
        uint64 escrowedPrice = _doCommit(dealId, buyer);

        // Credit any excess to the buyer's settler claimable balance.
        uint256 excess = authorizedAmount - uint256(escrowedPrice);
        if (excess > 0) {
            ISettler(settler).creditWithdrawal(buyer, excess);
            emit ExcessCredited(dealId, buyer, excess);
        }
    }

    // ── withdraw ──────────────────────────────────────────────────────────────

    /// Returns the lowest price escrowed by any buyer in the deal EXCLUDING the caller's price.
    function _lowestEscrowedExcluding(
        uint256 dealId,
        SwarmTypes.Tier[] memory tiers,
        uint64 excludePrice
    ) private view returns (uint64 lowest) {
        for (uint256 i = tiers.length; i > 0; i--) {
            uint64 tp = tiers[i - 1].pricePerUnit;
            uint32 cnt = tierCount[dealId][tp];
            if (tp == excludePrice && cnt > 0) cnt -= 1;
            if (cnt > 0) {
                return tp;
            }
        }
        return 0;
    }

    function _removeBuyer(uint256 dealId, address buyer, uint256 buyerPos) private returns (uint256) {
        uint256 lastIdx = _buyers[dealId].length - 1;
        uint256 idx = buyerPos - 1;
        if (idx != lastIdx) {
            address last = _buyers[dealId][lastIdx];
            _buyers[dealId][idx] = last;
            _buyerIndex[dealId][last] = idx + 1;
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

        uint256 newCount = _buyers[dealId].length - 1;
        uint64 newPrice = _clearingPriceAt(dealId, newCount);

        if (newCount > 0) {
            uint64 lowest = _lowestEscrowedExcluding(dealId, deal.tiers, escrowed[dealId][msg.sender]);
            if (lowest > 0 && lowest < newPrice) revert WouldStrandBuyer();
        }

        uint64 amount = escrowed[dealId][msg.sender];
        uint64 priceBefore = _clearingPriceAt(dealId, _buyers[dealId].length);

        _removeBuyer(dealId, msg.sender, buyerPos);
        tierCount[dealId][amount] -= 1;
        delete escrowed[dealId][msg.sender];

        uint64 priceAfter = _clearingPriceAt(dealId, _buyers[dealId].length);
        if (priceAfter != priceBefore) {
            emit TierBroken(dealId, uint32(_buyers[dealId].length), priceAfter);
        }

        ISettler(settler).creditWithdrawal(msg.sender, amount);
        emit Withdrawn(dealId, msg.sender, amount, priceAfter, uint32(_buyers[dealId].length));
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
        settler = _settler;
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
