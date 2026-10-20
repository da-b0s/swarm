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
    // - ReentrancyGuard on ALL functions that move USDC: commit, withdraw, pullForSettler, claim, settle, refundAll
    // - All math in uint64 / uint256 in 6-decimal USDC micro-units
    // - No msg.value anywhere
    // - No block.prevrandao (Arc returns 0 for it)
    // - block.timestamp used only for deadline comparison
    // - Deal state machine: 0=Open → 1=Settled XOR 0=Open → 2=Refunded, no other transitions
    // - settle and refundAll are mutually exclusive (both check state==0 first)
    // - Owner pause() halts postDeal and commit ONLY — never settle, refundAll, claim
    // - Conservation: assert(totalEscrowed == supplierCredit + totalRefunds) in settle
    // - claimable accumulates across deals (never reset between deals)
    // - One commit per address per deal
    // - Swap-and-pop for buyer removal to avoid gaps or stale indices

    DealFactory public immutable factory;
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    mapping(uint256 => address[]) private _buyers;
    mapping(uint256 => mapping(address => uint256)) private _buyerIndex;

    mapping(uint256 => uint64) public collateral;

    address public owner;
    address public settler;
    bool public settlerSet;

    event Committed(uint256 indexed dealId, address indexed buyer, uint64 livePrice, uint32 buyerCount);
    event Withdrawn(uint256 indexed dealId, address indexed buyer, uint64 livePrice, uint32 buyerCount);
    event TierBroken(uint256 indexed dealId, uint32 newBuyerCount, uint64 newPrice);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SettlerSet(address indexed settler);

    error DealNotOpen();
    error DeadlinePassed();
    error DeadlineNotReached();
    error AlreadyCommitted();
    error NotCommitted();
    error BuyerCapReached();
    error Unauthorized();
    error InvalidAddress();
    error SettlerAlreadySet();
    error SettlerNotConfigured();
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

    function setSettler(address _settler) external onlyOwner {
        if (settlerSet) revert SettlerAlreadySet();
        if (_settler == address(0)) revert InvalidAddress();
        settler = _settler;
        settlerSet = true;
        emit SettlerSet(_settler);
    }

    function clearingPrice(uint256 dealId) public view returns (uint64) {
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);
        uint256 count = _buyers[dealId].length;

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

    function commit(uint256 dealId) external nonReentrant {
        if (!settlerSet) revert SettlerNotConfigured();
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);

        if (deal.state != 0) revert DealNotOpen();
        if (block.timestamp >= deal.deadline) revert DeadlinePassed();
        if (_buyerIndex[dealId][msg.sender] != 0) revert AlreadyCommitted();
        if (_buyers[dealId].length >= deal.cap) revert BuyerCapReached();
        if (factory.paused()) revert Paused();

        uint64 priceBefore = clearingPrice(dealId);

        _buyers[dealId].push(msg.sender);
        _buyerIndex[dealId][msg.sender] = _buyers[dealId].length;

        uint64 priceAfter = clearingPrice(dealId);
        if (priceAfter != priceBefore) {
            emit TierBroken(dealId, uint32(_buyers[dealId].length), priceAfter);
        }

        if (collateral[dealId] == 0) {
            collateral[dealId] = deal.tiers[0].pricePerUnit;
        }

        bool ok = USDC.transferFrom(msg.sender, address(this), collateral[dealId]);
        if (!ok) revert TransferFailed();

        emit Committed(dealId, msg.sender, priceAfter, uint32(_buyers[dealId].length));
    }

    function withdraw(uint256 dealId) external nonReentrant {
        if (!settlerSet) revert SettlerNotConfigured();
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);

        if (deal.state != 0) revert DealNotOpen();
        if (block.timestamp >= deal.deadline) revert DeadlinePassed();

        uint256 buyerPos = _buyerIndex[dealId][msg.sender];
        if (buyerPos == 0) revert NotCommitted();

        uint64 priceBefore = clearingPrice(dealId);

        uint256 idx = buyerPos - 1;
        uint256 lastIndex = _buyers[dealId].length - 1;
        address last = _buyers[dealId][lastIndex];

        _buyers[dealId][idx] = last;
        _buyerIndex[dealId][last] = idx + 1;
        _buyers[dealId].pop();

        delete _buyerIndex[dealId][msg.sender];

        uint64 priceAfter = clearingPrice(dealId);
        if (priceAfter != priceBefore) {
            emit TierBroken(dealId, uint32(_buyers[dealId].length), priceAfter);
        }

        ISettler(settler).creditWithdrawal(msg.sender, collateral[dealId]);

        emit Withdrawn(dealId, msg.sender, priceAfter, uint32(_buyers[dealId].length));
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

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
