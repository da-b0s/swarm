// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwarmTypes} from "./SwarmTypes.sol";

contract DealFactory {
    // Key constraints:
    // - All math in 6-decimal USDC micro-units; no msg.value anywhere
    // - No block.prevrandao (Arc always returns 0)
    // - Owner pause() halts postDeal and commit (via DemandPool) ONLY
    // - Tiers: strictly ascending minBuyers, strictly descending pricePerUnit > 0
    // - Cap: tiers[0].pricePerUnit <= 5 USDC, buyers in [1, 100], minBuyers >= 1, minBuyers <= cap
    // - tiers[last].minBuyers <= cap (every tier is reachable)
    // - Deal state machine: 0=Open -> 1=Settled or 0=Open -> 2=Refunded (setDealState, settler-only)
    // - postDeal has no runtime dependency on DemandPool

    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    mapping(uint256 => SwarmTypes.Deal) public deals;
    uint256 public dealCount;

    address public owner;
    bool public paused;

    address public demandPool;
    address public settler;

    event DealPosted(uint256 indexed dealId, address indexed supplier, uint32 minBuyers, uint64 deadline, uint64 startPrice);
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
    error ZeroTierPrice();
    error Paused();
    error Unauthorized();
    error InvalidAddress();
    error AlreadySet();
    error InvalidStateTransition();
    error WrongChain();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _owner) {
        if (block.chainid != 5042002) revert WrongChain();
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
            if (tiers[i].pricePerUnit == 0) revert ZeroTierPrice();
            if (tiers[i].pricePerUnit > 5_000_000) revert PriceCapExceeded();
            if (i > 0) {
                if (tiers[i].minBuyers <= tiers[i - 1].minBuyers) revert TiersNotAscending();
                if (tiers[i].pricePerUnit >= tiers[i - 1].pricePerUnit) revert TiersNotDescending();
            }
        }

        if (tiers[0].minBuyers > minBuyers) revert FirstTierTooHigh();
        if (minBuyers == 0) revert InvalidConfiguration();
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

        emit DealPosted(dealId, msg.sender, minBuyers, deadline, tiers[0].pricePerUnit);
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
