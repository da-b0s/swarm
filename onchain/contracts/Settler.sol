// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DealFactory} from "./DealFactory.sol";
import {DemandPool} from "./DemandPool.sol";
import {SwarmTypes} from "./SwarmTypes.sol";
import {ISettler} from "./DemandPool.sol";

contract Settler is ReentrancyGuard, ISettler {
    using SafeERC20 for IERC20;
    // Key constraints:
    // - No block.chainid checks; no block.prevrandao
    // - ReentrancyGuard on settle, refundAll, claim, claimGoods
    // - settle and refundAll are mutually exclusive (both check state==0)
    // - Pull payments: claimable[address] for USDC; goodsClaimable[token][address] for ERC-20
    // - claimable accumulates across deals; claim() drains entire balance
    // - claimGoods(token) drains the caller's balance for a specific token
    // - Conservation checked in-transaction with named errors, both assets:
    //     USDC:  Σ escrowed == cp * totalUnits + Σ refunds
    //     Goods: maxUnits * tokensPerUnit == Σ delivered + unsold
    // - creditWithdrawal: callable only by DemandPool; credits claimable
    // - settle and refundAll are never gated by pause

    DealFactory public immutable factory;
    DemandPool  public immutable pool;
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    mapping(address => uint256) public claimable;                        // USDC
    mapping(address => mapping(address => uint256)) public goodsClaimable; // token → owner → amount

    address public owner;

    // ── Events ────────────────────────────────────────────────────────────────

    event Settled(
        uint256 indexed dealId,
        uint64  clearingPrice,
        uint32  totalUnits,
        uint32  buyerCount,
        uint256 totalRefunds,
        uint256 unitsDelivered
    );
    event Refunded(uint256 indexed dealId, address indexed buyer, uint256 usdcAmount);
    event Claimed(address indexed claimant, uint256 amount);
    event GoodsClaimed(address indexed token, address indexed claimant, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────────

    error DealNotOpen();
    error DeadlineNotReached();
    error MinUnitsNotMet();
    error MinUnitsMet();
    error AlreadySettled();
    error NothingToClaim();
    error Unauthorized();
    error InvalidAddress();
    error UsdcConservationViolation();
    error GoodsConservationViolation();

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address dealFactory, address demandPool, address _owner) {
        if (dealFactory == address(0) || demandPool == address(0) || _owner == address(0))
            revert InvalidAddress();
        factory = DealFactory(dealFactory);
        pool    = DemandPool(demandPool);
        owner   = _owner;
    }

    // ── ISettler ──────────────────────────────────────────────────────────────

    function creditWithdrawal(address buyer, uint256 amount) external {
        if (msg.sender != address(pool)) revert Unauthorized();
        claimable[buyer] += amount;
    }

    // ── internal helpers ──────────────────────────────────────────────────────

    function _creditBuyers(
        uint256 dealId,
        address[] memory buyers,
        uint64  cp,
        address goodsToken,
        uint256 tokensPerUnit
    ) private returns (uint256 totalRefunds, uint256 totalEscrowed, uint256 unitsDelivered) {
        for (uint256 i = 0; i < buyers.length; i++) {
            address buyer  = buyers[i];
            uint32  units  = pool.unitsOf(dealId, buyer);
            uint256 escrow = pool.escrowed(dealId, buyer);

            // refund = escrowed - cp * unitsOf
            // This handles multi-lot buyers correctly: each lot was paid at lotPrice >= cp,
            // and paidPerUnit is the minimum across lots, but the escrow already sums
            // (lotPrice_i * units_i) for each lot i. Using escrow - cp*units is exact.
            uint256 refund = escrow - uint256(cp) * uint256(units);
            claimable[buyer] += refund;
            totalRefunds     += refund;
            totalEscrowed    += escrow;

            uint256 goods = uint256(units) * tokensPerUnit;
            goodsClaimable[goodsToken][buyer] += goods;
            unitsDelivered += uint256(units);
        }
    }

    // ── settle ────────────────────────────────────────────────────────────────

    function settle(uint256 dealId) external nonReentrant {
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);

        if (deal.state != 0) revert AlreadySettled();
        if (block.timestamp < deal.deadline) revert DeadlineNotReached();

        address[] memory buyers = pool.getBuyers(dealId);
        uint32 totalUnitsSold = pool.totalUnits(dealId);
        if (totalUnitsSold < deal.minUnits) revert MinUnitsNotMet();

        uint64 cp = pool.clearingPrice(dealId);

        factory.setDealState(dealId, 1);

        // Pull all deposited goods from the factory to this contract so claimGoods can distribute.
        factory.pullGoodsForSettler(dealId);

        (uint256 totalRefunds, uint256 totalEscrowed, uint256 unitsDelivered) =
            _creditBuyers(dealId, buyers, cp, deal.goodsToken, deal.tokensPerUnit);

        // Supplier USDC credit
        uint256 supplierUsdc = uint256(cp) * uint256(totalUnitsSold);
        claimable[deal.supplier] += supplierUsdc;

        // Supplier unsold stock
        uint256 unsoldUnits = uint256(deal.maxUnits) - uint256(totalUnitsSold);
        uint256 unsoldGoods = unsoldUnits * deal.tokensPerUnit;
        if (unsoldGoods > 0) {
            goodsClaimable[deal.goodsToken][deal.supplier] += unsoldGoods;
        }

        // Conservation: USDC
        if (totalEscrowed != supplierUsdc + totalRefunds) revert UsdcConservationViolation();

        // Conservation: goods
        uint256 totalStock     = uint256(deal.maxUnits) * deal.tokensPerUnit;
        uint256 totalDelivered = unitsDelivered * deal.tokensPerUnit;
        if (totalStock != totalDelivered + unsoldGoods) revert GoodsConservationViolation();

        emit Settled(dealId, cp, totalUnitsSold, uint32(buyers.length), totalRefunds, unitsDelivered);
    }

    // ── refundAll ─────────────────────────────────────────────────────────────

    function refundAll(uint256 dealId) external nonReentrant {
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);

        if (deal.state != 0) revert AlreadySettled();
        if (block.timestamp < deal.deadline) revert DeadlineNotReached();

        uint32 totalUnitsSold = pool.totalUnits(dealId);
        if (totalUnitsSold >= deal.minUnits) revert MinUnitsMet();

        factory.setDealState(dealId, 2);

        // Pull all deposited goods back from the factory so the supplier can claimGoods.
        factory.pullGoodsForSettler(dealId);

        address[] memory buyers = pool.getBuyers(dealId);
        uint256 buyerCount = buyers.length;
        for (uint256 i = 0; i < buyerCount; i++) {
            address buyer  = buyers[i];
            uint256 escrow = pool.escrowed(dealId, buyer);
            claimable[buyer] += escrow;
            emit Refunded(dealId, buyer, escrow);
        }

        // Return all stock to supplier
        uint256 stock = uint256(deal.maxUnits) * deal.tokensPerUnit;
        if (stock > 0) {
            goodsClaimable[deal.goodsToken][deal.supplier] += stock;
        }
    }

    // ── claim (USDC) ──────────────────────────────────────────────────────────

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();

        claimable[msg.sender] = 0;
        pool.pullForSettler(msg.sender, amount);

        emit Claimed(msg.sender, amount);
    }

    // ── claimGoods ────────────────────────────────────────────────────────────

    function claimGoods(address token) external nonReentrant {
        uint256 amount = goodsClaimable[token][msg.sender];
        if (amount == 0) revert NothingToClaim();

        goodsClaimable[token][msg.sender] = 0;

        IERC20(token).safeTransfer(msg.sender, amount);

        emit GoodsClaimed(token, msg.sender, amount);
    }

    // ── admin ─────────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
