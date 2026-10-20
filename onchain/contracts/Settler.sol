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
    // - All math in 6-decimal USDC micro-units; no msg.value anywhere
    // - No block.prevrandao (Arc always returns 0)
    // - ReentrancyGuard on settle, refundAll, claim
    // - settle and refundAll are mutually exclusive; both check state==0 first (AlreadySettled)
    // - Commit-time escrow: refund = escrowed[buyer] - clearingPrice; supplier gets cp * N
    // - Conservation: sum(escrowed) == cp * N + sum(refunds), enforced via ConservationViolation named error
    // - claimable[address] accumulates across deals and is never reset between deals
    // - claim() zeroes claimable[msg.sender] then calls pool.pullForSettler — pull payments only
    // - settle and refundAll are never gated by pause (no pause in Settler)
    // - creditWithdrawal: callable only by DemandPool; credits claimable without moving USDC

    DealFactory public immutable factory;
    DemandPool public immutable pool;
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    mapping(address => uint256) public claimable;

    address public owner;

    event Settled(uint256 indexed dealId, uint64 clearingPrice, uint32 buyerCount, uint256 totalRefunds);
    event Refunded(uint256 indexed dealId, address indexed buyer, uint256 amount);
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
    error WrongChain();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address dealFactory, address demandPool, address _owner) {
        if (block.chainid != 5042002) revert WrongChain();
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

        factory.setDealState(dealId, 1);

        uint256 buyerCount = buyers.length;
        uint256 totalRefunds = 0;
        uint256 totalEscrowed = 0;

        for (uint256 i = 0; i < buyerCount; i++) {
            uint64 paid = pool.escrowed(dealId, buyers[i]);
            uint256 refund = uint256(paid) - uint256(cp);
            claimable[buyers[i]] += refund;
            totalRefunds += refund;
            totalEscrowed += uint256(paid);
        }

        uint256 supplierCredit = uint256(cp) * buyerCount;
        claimable[deal.supplier] += supplierCredit;

        if (totalEscrowed != supplierCredit + totalRefunds) revert ConservationViolation();

        emit Settled(dealId, cp, uint32(buyerCount), totalRefunds);
    }

    function refundAll(uint256 dealId) external nonReentrant {
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);

        if (deal.state != 0) revert AlreadySettled();
        if (block.timestamp < deal.deadline) revert DeadlineNotReached();

        address[] memory buyers = pool.getBuyers(dealId);
        if (buyers.length >= deal.minBuyers) revert MinBuyersMet();

        factory.setDealState(dealId, 2);

        uint256 buyerCount = buyers.length;
        for (uint256 i = 0; i < buyerCount; i++) {
            uint256 amt = uint256(pool.escrowed(dealId, buyers[i]));
            claimable[buyers[i]] += amt;
            emit Refunded(dealId, buyers[i], amt);
        }
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
