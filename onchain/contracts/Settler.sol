// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DealFactory} from "./DealFactory.sol";
import {DemandPool} from "./DemandPool.sol";
import {SwarmTypes} from "./SwarmTypes.sol";
import {ISettler} from "./DemandPool.sol";

contract Settler is ReentrancyGuard, ISettler {
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
    DemandPool public immutable pool;
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    mapping(address => uint256) public claimable;

    address public owner;

    event Settled(uint256 indexed dealId, uint64 clearingPrice, uint32 buyerCount);
    event Refunded(uint256 indexed dealId, uint32 buyerCount);
    event Claimed(address indexed claimant, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error DealNotOpen();
    error DeadlineNotReached();
    error MinBuyersNotMet();
    error MinBuyersMet();
    error AlreadySettled();
    error NothingToClaim();
    error Unauthorized();
    error InvalidAddress();
    error ConservationViolation();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address dealFactory, address demandPool, address _owner) {
        if (dealFactory == address(0) || demandPool == address(0) || _owner == address(0)) revert InvalidAddress();
        factory = DealFactory(dealFactory);
        pool = DemandPool(demandPool);
        owner = _owner;
    }

    function creditWithdrawal(address buyer, uint256 amount) external {
        if (msg.sender != address(pool)) revert Unauthorized();
        claimable[buyer] += amount;
    }

    function settle(uint256 dealId) external nonReentrant {
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);

        if (deal.state != 0) revert AlreadySettled();
        if (block.timestamp < deal.deadline) revert DeadlineNotReached();

        address[] memory buyers = pool.getBuyers(dealId);
        if (buyers.length < deal.minBuyers) revert MinBuyersNotMet();

        uint64 cp = pool.clearingPrice(dealId);
        uint64 top = pool.collateral(dealId);

        factory.setDealState(dealId, 1);

        uint256 buyerCount = buyers.length;
        uint256 totalRefunds = 0;

        for (uint256 i = 0; i < buyerCount; i++) {
            uint256 refund = uint256(top - cp);
            claimable[buyers[i]] += refund;
            totalRefunds += refund;
        }

        uint256 supplierCredit = uint256(cp) * buyerCount;
        claimable[deal.supplier] += supplierCredit;

        uint256 totalEscrowed = uint256(top) * buyerCount;
        if (totalEscrowed != supplierCredit + totalRefunds) revert ConservationViolation();

        emit Settled(dealId, cp, uint32(buyerCount));
    }

    function refundAll(uint256 dealId) external nonReentrant {
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);

        if (deal.state != 0) revert AlreadySettled();
        if (block.timestamp < deal.deadline) revert DeadlineNotReached();

        address[] memory buyers = pool.getBuyers(dealId);
        if (buyers.length >= deal.minBuyers) revert MinBuyersMet();

        factory.setDealState(dealId, 2);

        uint256 buyerCount = buyers.length;
        uint256 refundAmount = pool.collateral(dealId);
        for (uint256 i = 0; i < buyerCount; i++) {
            claimable[buyers[i]] += refundAmount;
        }

        emit Refunded(dealId, uint32(buyerCount));
    }

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();

        claimable[msg.sender] = 0;
        pool.pullForSettler(msg.sender, amount);

        emit Claimed(msg.sender, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
