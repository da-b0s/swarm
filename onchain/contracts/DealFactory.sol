// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwarmTypes} from "./SwarmTypes.sol";

contract DealFactory {
    // Key constraints:
    // - All math in 6-decimal USDC micro-units; no msg.value anywhere
    // - No block.prevrandao (Arc always returns 0)
    // - No block.chainid checks (deployment-configuration concern)
    // - Owner pause() halts postDeal and commit (via DemandPool) ONLY
    // - Tiers: strictly ascending minUnits, strictly descending pricePerUnit > 0
    // - pricePerUnit <= 5 USDC on every tier; maxBuyers in [1, 100]
    // - tiers[0].minUnits <= minUnits; minUnits >= 1; minUnits <= maxUnits
    // - tiers[last].minUnits <= maxUnits (every tier is reachable)
    // - goodsToken != address(0) && goodsToken != USDC
    // - Stock deposit: maxUnits * tokensPerUnit pulled via transferFrom; balance-delta checked
    // - Deal state machine: 0=Open -> 1=Settled or 0=Open -> 2=Refunded (setDealState, settler-only)
    // - postDeal has no runtime dependency on DemandPool

    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    mapping(uint256 => SwarmTypes.Deal) public deals;
    // Goods held in escrow per deal: dealId → amount of goodsToken deposited
    mapping(uint256 => uint256) public goodsDeposited;
    uint256 public dealCount;

    address public owner;
    bool public paused;

    address public demandPool;
    address public settler;

    // ── Events ────────────────────────────────────────────────────────────────

    event DealPosted(
        uint256 indexed dealId,
        address indexed supplier,
        address indexed goodsToken,
        uint32 minUnits,
        uint32 maxUnits,
        uint64 deadline,
        uint64 startPrice
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PausedContract(address indexed account);
    event UnpausedContract(address indexed account);
    event DemandPoolSet(address indexed demandPool);
    event SettlerSet(address indexed settler);

    // ── Errors ────────────────────────────────────────────────────────────────

    error InvalidTierCount();
    error TiersNotAscending();
    error TiersNotDescending();
    error ZeroTierPrice();
    error PriceCapExceeded();
    error TierMinUnitsExceedsMin();   // tiers[0].minUnits > minUnits
    error MinUnitsZero();
    error MinUnitsExceedsMax();       // minUnits > maxUnits
    error LastTierExceedsMax();       // tiers[last].minUnits > maxUnits
    error MaxBuyersOutOfRange();
    error MaxUnitsPerBuyerInvalid();  // > 0 but > maxUnits
    error MaxUnitsZero();
    error ZeroTokensPerUnit();
    error InvalidGoodsToken();        // zero address or USDC
    error DeadlineNotFuture();
    error TitleEmpty();
    error TitleTooLong();
    error DescriptionTooLong();
    error UnsupportedToken();         // fee-on-transfer or rebasing token
    error TransferFailed();
    error Paused();
    error Unauthorized();
    error InvalidAddress();
    error AlreadySet();
    error InvalidStateTransition();

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _owner) {
        if (_owner == address(0)) revert InvalidAddress();
        owner = _owner;
    }

    // ── postDeal ──────────────────────────────────────────────────────────────

    /// @dev Calldata struct for postDeal scalar parameters (avoids stack-too-deep from 10 args).
    struct PostParams {
        address goodsToken;
        uint256 tokensPerUnit;
        uint32  minUnits;
        uint32  maxUnits;
        uint32  maxUnitsPerBuyer;
        uint32  maxBuyers;
        uint64  deadline;
        string  title;
        string  description;
    }

    function postDeal(
        PostParams calldata p,
        SwarmTypes.Tier[] calldata tiers
    ) external returns (uint256 dealId) {
        if (paused) revert Paused();

        _validateDeal(p, tiers);

        // ── Stock deposit ─────────────────────────────────────────────────────
        uint256 stockAmount = uint256(p.maxUnits) * p.tokensPerUnit;
        {
            IERC20 token = IERC20(p.goodsToken);
            uint256 balBefore = token.balanceOf(address(this));
            bool ok = token.transferFrom(msg.sender, address(this), stockAmount);
            if (!ok) revert TransferFailed();
            if (token.balanceOf(address(this)) - balBefore != stockAmount) revert UnsupportedToken();
        }

        // ── Store deal ────────────────────────────────────────────────────────
        dealId = ++dealCount;
        _storeDeal(dealId, p, tiers);
        goodsDeposited[dealId] = stockAmount;

        emit DealPosted(dealId, msg.sender, p.goodsToken, p.minUnits, p.maxUnits, p.deadline, tiers[0].pricePerUnit);
    }

    function _validateDeal(
        PostParams calldata p,
        SwarmTypes.Tier[] calldata tiers
    ) private view {
        if (tiers.length == 0 || tiers.length > 10) revert InvalidTierCount();
        for (uint256 i = 0; i < tiers.length; i++) {
            if (tiers[i].pricePerUnit == 0) revert ZeroTierPrice();
            if (tiers[i].pricePerUnit > 5_000_000) revert PriceCapExceeded();
            if (i > 0) {
                if (tiers[i].minUnits <= tiers[i - 1].minUnits) revert TiersNotAscending();
                if (tiers[i].pricePerUnit >= tiers[i - 1].pricePerUnit) revert TiersNotDescending();
            }
        }
        if (tiers[0].minUnits > p.minUnits) revert TierMinUnitsExceedsMin();
        if (p.minUnits == 0) revert MinUnitsZero();
        if (p.maxUnits == 0) revert MaxUnitsZero();
        if (p.minUnits > p.maxUnits) revert MinUnitsExceedsMax();
        if (tiers[tiers.length - 1].minUnits > p.maxUnits) revert LastTierExceedsMax();
        if (p.maxBuyers == 0 || p.maxBuyers > 100) revert MaxBuyersOutOfRange();
        if (p.maxUnitsPerBuyer != 0 && p.maxUnitsPerBuyer > p.maxUnits) revert MaxUnitsPerBuyerInvalid();
        if (p.tokensPerUnit == 0) revert ZeroTokensPerUnit();
        if (p.goodsToken == address(0) || p.goodsToken == address(USDC)) revert InvalidGoodsToken();
        if (p.deadline <= block.timestamp) revert DeadlineNotFuture();
        if (bytes(p.title).length == 0) revert TitleEmpty();
        if (bytes(p.title).length > 80) revert TitleTooLong();
        if (bytes(p.description).length > 500) revert DescriptionTooLong();
    }

    function _storeDeal(
        uint256 dealId,
        PostParams calldata p,
        SwarmTypes.Tier[] calldata tiers
    ) private {
        SwarmTypes.Deal storage deal = deals[dealId];
        deal.supplier         = msg.sender;
        deal.goodsToken       = p.goodsToken;
        deal.tokensPerUnit    = p.tokensPerUnit;
        deal.minUnits         = p.minUnits;
        deal.maxUnits         = p.maxUnits;
        deal.maxUnitsPerBuyer = p.maxUnitsPerBuyer;
        deal.maxBuyers        = p.maxBuyers;
        deal.deadline         = p.deadline;
        deal.state            = 0;
        deal.title            = p.title;
        deal.description      = p.description;
        for (uint256 i = 0; i < tiers.length; i++) {
            deal.tiers.push(tiers[i]);
        }
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

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

    // ── View ──────────────────────────────────────────────────────────────────

    function getDeal(uint256 dealId) external view returns (SwarmTypes.Deal memory) {
        return deals[dealId];
    }

    /// @notice Called by the Settler during settle/refundAll to transfer all deposited goods
    ///         to the settler contract, which then distributes them via claimGoods.
    function pullGoodsForSettler(uint256 dealId) external {
        if (msg.sender != settler) revert Unauthorized();
        SwarmTypes.Deal storage deal = deals[dealId];
        uint256 amount = goodsDeposited[dealId];
        if (amount == 0) return;
        goodsDeposited[dealId] = 0;
        bool ok = IERC20(deal.goodsToken).transfer(settler, amount);
        if (!ok) revert TransferFailed();
    }
}
