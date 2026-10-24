// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DealFactory} from "../DealFactory.sol";
import {DemandPool} from "../DemandPool.sol";
import {Settler} from "../Settler.sol";
import {SwarmPass} from "../SwarmPass.sol";
import {SwarmTypes} from "../SwarmTypes.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @notice Smoke test for Swarm v2.
///
/// Scenario:
///   - Supplier posts a deal selling Swarm Pass (0 decimals, tokensPerUnit = 1).
///   - Tiers: >=10 units → $1.00/unit, >=20 units → $0.75/unit.
///   - minUnits = 10, maxUnits = 30, maxBuyers = 10.
///   - Buyer A orders 5 units at $1.00  (total 5  → still $1.00 tier)
///   - Buyer B orders 8 units at $1.00  (total 13 → breaks to $0.75... wait: 5+8=13 >= 10 → $0.75)
///     Actually: priceAt(totalUnits + units) BEFORE adding.
///     After A (total=5): priceAt(5+8=13) → 13>=10 → $0.75. B pays $0.75.
///   - Buyer C orders 9 units at $0.75  (total 13+9=22 → 22>=20 → $0.75. C pays $0.75.)
///   Wait — let's restate:
///   - A commits 5: priceAt(0+5=5) = $1.00 (5<10). Escrow = 5 × $1.00 = $5.00.
///   - B commits 8: priceAt(5+8=13) = $1.00... No: 13>=10 so $0.75? No, >=10 means >=10 → $0.75.
///     Wait: tiers[0].minUnits=10 pricePerUnit=$1.00, tiers[1].minUnits=20 pricePerUnit=$0.75.
///     priceAt(13): highest tier whose minUnits<=13 is tier[0] (minUnits=10<=13) → $1.00? No:
///     priceAt iterates from highest to lowest. tier[1].minUnits=20 > 13 → skip.
///     tier[0].minUnits=10 <= 13 → $1.00. So B pays $1.00/unit.
///   Let me use tiers that actually cause a break during ordering:
///   - Tier 0: minUnits=1,  pricePerUnit=$1.00
///   - Tier 1: minUnits=10, pricePerUnit=$0.75
///   - Tier 2: minUnits=20, pricePerUnit=$0.50
///   Then:
///   - A commits 5: priceAt(0+5=5) = $1.00. Escrow = $5.00.
///   - B commits 8: priceAt(5+8=13) = $1.00 (13>=1, <10 threshold for $0.75).
///     Hmm. Need 5+8=13 >= 10? 13>=10 → $0.75? YES, tier[1].minUnits=10<=13. Correct.
///     So B pays $0.75/unit. Escrow = 8 × $0.75 = $6.00. TierBroken emitted.
///   - C commits 9: priceAt(13+9=22) = 22>=20 → $0.50. TierBroken. Escrow = 9×$0.50=$4.50.
///   totalUnits=22, cp=$0.50.
///   Settlement:
///     A refund = (1.00-0.50)*5 = $2.50. A goods = 5 passes.
///     B refund = (0.75-0.50)*8 = $2.00. B goods = 8 passes.
///     C refund = (0.50-0.50)*9 = $0.00. C goods = 9 passes.
///     Supplier USDC = $0.50*22 = $11.00.
///     Supplier unsold passes = (30-22)*1 = 8.
///   USDC conservation: (5+6+4.5) = 15.5 = 11 + (2.5+2+0) = 11+4.5 ✓
///   Goods conservation: 30 = (5+8+9) + 8 = 22 + 8 ✓

contract SwarmV2Smoke is Test {
    DealFactory factory;
    DemandPool  pool;
    Settler     settler;
    SwarmPass   pass;
    MockERC20   usdc;

    address owner    = address(0x1000);
    address supplier = address(0x2000);
    address buyerA   = address(0x3001);
    address buyerB   = address(0x3002);
    address buyerC   = address(0x3003);

    address constant USDC_ADDR = 0x3600000000000000000000000000000000000000;

    uint256 dealId;

    function setUp() public {
        // Deploy mock USDC at the canonical address
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.etch(USDC_ADDR, address(usdc).code);
        // Re-initialise storage (etch copies code only; mint via the original instance)
        usdc = MockERC20(USDC_ADDR);

        // Deploy Swarm Pass (faucet on for testnet feel)
        vm.prank(owner);
        pass = new SwarmPass(true);

        // Deploy contracts
        vm.prank(owner);
        factory = new DealFactory(owner);
        vm.prank(owner);
        pool = new DemandPool(address(factory), owner);
        vm.prank(owner);
        settler = new Settler(address(factory), address(pool), owner);

        // Wire
        vm.prank(owner);
        factory.setDemandPool(address(pool));
        vm.prank(owner);
        factory.setSettler(address(settler));
        vm.prank(owner);
        pool.setSettler(address(settler));

        // Fund supplier with 30 passes and mint USDC for buyers
        vm.prank(owner);
        pass.mint(supplier, 30);

        usdc.mint(buyerA, 10_000_000);
        usdc.mint(buyerB, 10_000_000);
        usdc.mint(buyerC, 10_000_000);

        // Approve pool to pull USDC from buyers
        vm.prank(buyerA); usdc.approve(address(pool), type(uint256).max);
        vm.prank(buyerB); usdc.approve(address(pool), type(uint256).max);
        vm.prank(buyerC); usdc.approve(address(pool), type(uint256).max);

        // Supplier approves factory to pull passes
        vm.prank(supplier); pass.approve(address(factory), type(uint256).max);

        // Build tiers
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](3);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000}); // $1.00
        tiers[1] = SwarmTypes.Tier({minUnits: 10, pricePerUnit: 750_000});   // $0.75
        tiers[2] = SwarmTypes.Tier({minUnits: 20, pricePerUnit: 500_000});   // $0.50

        // Post deal: 30 passes, minUnits=10, maxUnitsPerBuyer=0, maxBuyers=10
        uint64 deadline = uint64(block.timestamp + 2 days);
        vm.prank(supplier);
        dealId = factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         10,
                maxUnits:         30,
                maxUnitsPerBuyer: 0,
                maxBuyers:        10,
                deadline:         deadline,
                title:            "Swarm Pass Sale",
                description:      "Demo deal for Swarm v2 smoke test."
            }),
            tiers
        );

        // Verify stock was pulled
        assertEq(pass.balanceOf(address(factory)), 30, "factory holds stock");
        assertEq(pass.balanceOf(supplier), 0, "supplier balance gone");
    }

    function test_SmokeSettlement() public {
        // ── Commit phase ──────────────────────────────────────────────────────

        // Buyer A: 5 units. priceAt(0+5=5) → tier[0] (minUnits=1<=5, tier[1] minUnits=10>5) → $1.00
        vm.prank(buyerA);
        pool.commit(dealId, 5);
        assertEq(pool.totalUnits(dealId), 5);
        assertEq(pool.escrowed(dealId, buyerA), 5_000_000, "A escrowed $5");
        assertEq(pool.paidPerUnit(dealId, buyerA), 1_000_000, "A paid $1.00/unit");

        // Buyer B: 8 units. priceAt(5+8=13) → tier[1] (minUnits=10<=13) → $0.75. TierBroken.
        vm.prank(buyerB);
        pool.commit(dealId, 8);
        assertEq(pool.totalUnits(dealId), 13);
        assertEq(pool.escrowed(dealId, buyerB), 6_000_000, "B escrowed $6");
        assertEq(pool.paidPerUnit(dealId, buyerB), 750_000, "B paid $0.75/unit");

        // Buyer C: 9 units. priceAt(13+9=22) → tier[2] (minUnits=20<=22) → $0.50. TierBroken.
        vm.prank(buyerC);
        pool.commit(dealId, 9);
        assertEq(pool.totalUnits(dealId), 22);
        assertEq(pool.escrowed(dealId, buyerC), 4_500_000, "C escrowed $4.50");
        assertEq(pool.paidPerUnit(dealId, buyerC), 500_000, "C paid $0.50/unit");

        // Clearing price is now $0.50
        assertEq(pool.clearingPrice(dealId), 500_000, "cp=$0.50");

        // Pool holds all USDC: 5+6+4.5 = $15.50
        assertEq(usdc.balanceOf(address(pool)), 15_500_000, "pool USDC");

        // Factory holds all 30 passes
        assertEq(pass.balanceOf(address(factory)), 30, "factory passes before settle");

        // ── Settle ────────────────────────────────────────────────────────────

        vm.warp(block.timestamp + 2 days + 1);
        settler.settle(dealId);

        // State = Settled
        assertEq(factory.getDeal(dealId).state, 1, "settled");

        // ── USDC claimable ────────────────────────────────────────────────────

        // Buyer A refund: (1.00-0.50)*5 = $2.50
        assertEq(settler.claimable(buyerA), 2_500_000, "A USDC claimable");
        // Buyer B refund: (0.75-0.50)*8 = $2.00
        assertEq(settler.claimable(buyerB), 2_000_000, "B USDC claimable");
        // Buyer C refund: (0.50-0.50)*9 = $0
        assertEq(settler.claimable(buyerC), 0, "C no USDC refund");
        // Supplier USDC: 0.50*22 = $11.00
        assertEq(settler.claimable(supplier), 11_000_000, "supplier USDC claimable");

        // ── Goods claimable ───────────────────────────────────────────────────

        assertEq(settler.goodsClaimable(address(pass), buyerA), 5, "A goods: 5 passes");
        assertEq(settler.goodsClaimable(address(pass), buyerB), 8, "B goods: 8 passes");
        assertEq(settler.goodsClaimable(address(pass), buyerC), 9, "C goods: 9 passes");
        // Supplier unsold: 30-22 = 8 passes
        assertEq(settler.goodsClaimable(address(pass), supplier), 8, "supplier unsold: 8 passes");

        // Settler holds all passes (pulled from factory during postDeal → factory → settler on claim)
        // Actually: factory holds the passes deposited at postDeal. Settler.claimGoods transfers
        // from the contract that holds them — but wait: the Settler credits goodsClaimable but
        // the actual tokens are sitting in the factory. On claimGoods the settler calls
        // IERC20(token).transfer(msg.sender, amount) — but settler doesn't hold the tokens!
        // We need to transfer the goods from the factory to the settler during settlement.
        // This is a design question: the spec says "goods custody is tracked per deal" in the
        // factory. On settle, the factory should release them to settler (or settler should pull
        // them). Let's check: factory.goodsDeposited tracks amount. We need a pullGoodsForSettler
        // function on the factory, or the settler should receive tokens during settle.
        //
        // For the smoke test we'll verify the accounting is correct then test claims after
        // manually moving tokens to match what the settler expects.
        //
        // Actually: the settler's claimGoods calls IERC20(token).transfer — it needs to hold
        // the tokens. The factory holds them. The settler needs to pull them during settle().
        // Let's add that call to Settler.settle() — pull goodsDeposited from factory.
        // We'll assert that settle moved the tokens from factory to settler.
        assertEq(pass.balanceOf(address(settler)), 30, "settler holds all passes after settle");
        assertEq(pass.balanceOf(address(factory)), 0,  "factory released passes");

        // ── Claim USDC ────────────────────────────────────────────────────────

        vm.prank(buyerA); settler.claim();
        assertEq(usdc.balanceOf(buyerA), 10_000_000 - 5_000_000 + 2_500_000, "A USDC after claim");

        vm.prank(buyerB); settler.claim();
        assertEq(usdc.balanceOf(buyerB), 10_000_000 - 6_000_000 + 2_000_000, "B USDC after claim");

        vm.prank(supplier); settler.claim();
        assertEq(usdc.balanceOf(supplier), 11_000_000, "supplier USDC claim");

        // ── Claim Goods ───────────────────────────────────────────────────────

        vm.prank(buyerA); settler.claimGoods(address(pass));
        assertEq(pass.balanceOf(buyerA), 5, "A receives 5 passes");

        vm.prank(buyerB); settler.claimGoods(address(pass));
        assertEq(pass.balanceOf(buyerB), 8, "B receives 8 passes");

        vm.prank(buyerC); settler.claimGoods(address(pass));
        assertEq(pass.balanceOf(buyerC), 9, "C receives 9 passes");

        vm.prank(supplier); settler.claimGoods(address(pass));
        assertEq(pass.balanceOf(supplier), 8, "supplier receives 8 unsold passes");

        // Everything claimed; settler holds nothing
        assertEq(pass.balanceOf(address(settler)), 0, "settler empty");
        assertEq(usdc.balanceOf(address(pool)),    0, "pool empty");
    }
}
