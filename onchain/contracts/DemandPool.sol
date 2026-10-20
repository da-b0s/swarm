// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DealFactory} from "./DealFactory.sol";
import {SwarmTypes} from "./SwarmTypes.sol";

interface ISettler {
    function creditWithdrawal(address buyer, uint256 amount) external;
}

contract DemandPool is ReentrancyGuard {
    // Key constraints:
    // - All math in 6-decimal USDC micro-units; no msg.value anywhere
    // - No block.prevrandao (Arc always returns 0)
    // - ReentrancyGuard on commit, withdraw, pullForSettler
    // - Commit-time escrow: each buyer pays clearingPrice(post-add); stored in escrowed[dealId][buyer]
    // - tierCount[dealId][price] tracks buyers at each price tier for O(tiers) WouldStrandBuyer check
    // - WouldStrandBuyer: withdraw refused if any remaining buyer escrowed less than newPrice
    // - One commit per address per deal; swap-and-pop with index update for removal
    // - Owner pause() (in factory) halts commit; withdraw/settle/refundAll/claim are never halted
    // - Pull payments everywhere: withdraw() credits Settler.claimable, never transfers USDC directly
    // - commit() and withdraw() revert SettlerNotConfigured if settler not yet wired

    DealFactory public immutable factory;
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

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

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address dealFactory, address _owner) {
        if (dealFactory == address(0) || _owner == address(0)) revert InvalidAddress();
        factory = DealFactory(dealFactory);
        owner = _owner;
    }

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

    function commit(uint256 dealId) external nonReentrant {
        if (!settlerSet) revert SettlerNotConfigured();

        SwarmTypes.Deal memory deal = factory.getDeal(dealId);
        if (deal.state != 0) revert DealNotOpen();
        if (block.timestamp >= deal.deadline) revert DeadlinePassed();
        if (_buyerIndex[dealId][msg.sender] != 0) revert AlreadyCommitted();
        if (_buyers[dealId].length >= deal.cap) revert BuyerCapReached();
        if (factory.paused()) revert Paused();

        uint64 priceBefore = _clearingPriceAt(dealId, _buyers[dealId].length);

        _buyers[dealId].push(msg.sender);
        _buyerIndex[dealId][msg.sender] = _buyers[dealId].length;

        uint64 priceAfter = _clearingPriceAt(dealId, _buyers[dealId].length);

        escrowed[dealId][msg.sender] = priceAfter;
        tierCount[dealId][priceAfter] += 1;

        if (priceAfter != priceBefore) {
            emit TierBroken(dealId, uint32(_buyers[dealId].length), priceAfter);
        }

        bool ok = USDC.transferFrom(msg.sender, address(this), priceAfter);
        if (!ok) revert TransferFailed();

        emit Committed(dealId, msg.sender, priceAfter, priceAfter, uint32(_buyers[dealId].length));
    }

    /// Returns the lowest price escrowed by any buyer in the deal EXCLUDING the caller's price.
    /// Tiers are stored with index 0 = highest price, last = lowest price.
    /// Iterates from the cheapest tier upward; stops at the first with a non-zero adjusted count.
    /// Bounded by number of tiers (≤ ~10 in practice).
    function _lowestEscrowedExcluding(
        uint256 dealId,
        SwarmTypes.Tier[] memory tiers,
        uint64 excludePrice
    ) private view returns (uint64 lowest) {
        // Scan from cheapest (last index) toward most expensive (index 0)
        for (uint256 i = tiers.length; i > 0; i--) {
            uint64 tp = tiers[i - 1].pricePerUnit;
            uint32 cnt = tierCount[dealId][tp];
            if (tp == excludePrice && cnt > 0) cnt -= 1;
            if (cnt > 0) {
                // This is the cheapest tier with remaining buyers — return immediately
                return tp;
            }
        }
        // No remaining buyers at any tier (caller was the only buyer — newCount==0 path handles this)
        return 0;
    }

    /// Removes `buyer` from _buyers[dealId] via swap-and-pop. Returns the new length.
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

        // WouldStrandBuyer: refuse if any remaining buyer escrowed less than newPrice
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

    function pullForSettler(address to, uint256 amount) external nonReentrant {
        if (msg.sender != settler) revert Unauthorized();
        bool ok = USDC.transfer(to, amount);
        if (!ok) revert TransferFailed();
    }

    function getBuyers(uint256 dealId) external view returns (address[] memory) {
        return _buyers[dealId];
    }

    function getBuyerCount(uint256 dealId) external view returns (uint32) {
        return uint32(_buyers[dealId].length);
    }

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
