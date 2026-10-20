// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwarmTypes} from "./SwarmTypes.sol";

contract DealFactory {
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

    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    mapping(uint256 => SwarmTypes.Deal) public deals;
    uint256 public dealCount;

    address public owner;
    bool public paused;

    address public demandPool;
    address public settler;

    event DealPosted(uint256 indexed dealId, address indexed supplier, uint32 minBuyers, uint64 deadline);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PausedContract(address indexed account);
    event UnpausedContract(address indexed account);
    event DemandPoolSet(address indexed demandPool);
    event SettlerSet(address indexed settler);

    error InvalidTierCount();
    error TiersNotAscending();
    error TiersNotDescending();
    error FirstTierTooHigh();
    error DeadlineNotFuture();
    error PriceCapExceeded();
    error BuyerCapExceeded();
    error InvalidConfiguration();
    error Paused();
    error Unauthorized();
    error InvalidAddress();
    error AlreadySet();
    error InvalidStateTransition();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _owner) {
        if (_owner == address(0)) revert InvalidAddress();
        owner = _owner;
    }

    function postDeal(
        SwarmTypes.Tier[] calldata tiers,
        uint32 minBuyers,
        uint64 deadline,
        uint32 cap
    ) external returns (uint256 dealId) {
        if (paused) revert Paused();
        if (tiers.length == 0) revert InvalidTierCount();

        for (uint256 i = 0; i < tiers.length; i++) {
            if (tiers[i].pricePerUnit > 5_000_000) revert PriceCapExceeded();
            if (i > 0) {
                if (tiers[i].minBuyers <= tiers[i - 1].minBuyers) revert TiersNotAscending();
                if (tiers[i].pricePerUnit >= tiers[i - 1].pricePerUnit) revert TiersNotDescending();
            }
        }

        if (tiers[0].minBuyers > minBuyers) revert FirstTierTooHigh();
        if (deadline <= block.timestamp) revert DeadlineNotFuture();
        if (cap == 0) revert BuyerCapExceeded();
        if (cap > 100) revert BuyerCapExceeded();
        if (minBuyers > cap) revert InvalidConfiguration();
        if (tiers[tiers.length - 1].minBuyers > cap) revert InvalidConfiguration();

        dealId = ++dealCount;

        SwarmTypes.Deal storage deal = deals[dealId];
        deal.supplier = msg.sender;
        deal.minBuyers = minBuyers;
        deal.deadline = deadline;
        deal.cap = cap;
        deal.state = 0;

        for (uint256 i = 0; i < tiers.length; i++) {
            deal.tiers.push(tiers[i]);
        }

        emit DealPosted(dealId, msg.sender, minBuyers, deadline);
    }

    function pause() external onlyOwner {
        paused = true;
        emit PausedContract(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit UnpausedContract(msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setDemandPool(address _demandPool) external onlyOwner {
        if (_demandPool == address(0)) revert InvalidAddress();
        if (demandPool != address(0)) revert AlreadySet();
        demandPool = _demandPool;
        emit DemandPoolSet(_demandPool);
    }

    function setSettler(address _settler) external onlyOwner {
        if (_settler == address(0)) revert InvalidAddress();
        if (settler != address(0)) revert AlreadySet();
        settler = _settler;
        emit SettlerSet(_settler);
    }

    function setDealState(uint256 dealId, uint8 newState) external {
        if (msg.sender != settler) revert Unauthorized();
        if (newState != 1 && newState != 2) revert InvalidStateTransition();

        SwarmTypes.Deal storage deal = deals[dealId];
        if (deal.state != 0) revert InvalidStateTransition();

        deal.state = newState;
    }

    function getDeal(uint256 dealId) external view returns (SwarmTypes.Deal memory) {
        return deals[dealId];
    }
}
