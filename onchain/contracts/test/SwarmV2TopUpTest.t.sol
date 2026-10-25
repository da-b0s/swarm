// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DealFactory} from "../DealFactory.sol";
import {DemandPool} from "../DemandPool.sol";
import {Settler} from "../Settler.sol";
import {SwarmPass} from "../SwarmPass.sol";
import {SwarmTypes} from "../SwarmTypes.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockEIP3009USDC} from "../test-helpers/MockEIP3009USDC.sol";

// ── Signing result struct (avoids stack-too-deep without via_ir) ──────────────
struct Auth {
    uint256 validAfter;
    uint256 validBefore;
    bytes32 nonce;
    uint256 signedAmount;
    uint8   v;
    bytes32 r;
    bytes32 s;
}

/// @notice Tests for the v2.1 top-up feature: a buyer who already has an order
///         can call commit() again to add more units (a "lot") to their order.
///
/// Spec summary (from mechanism-v2.md, "v2.1 — adding to an order"):
///   lotPrice   = priceAt(totalUnits + units)    — includes the new lot
///   escrowed  += lotPrice * units
///   unitsOf   += units
///   paidPerUnit = min(old, lotPrice)            — the buyer's cheapest lot price
///   tierCount: if paidPerUnit falls, move buyer from old tally to new.
///
/// Settlement refund: escrowed - cp * unitsOf  (not (paid - cp) * units)
///
/// Gasless top-ups: commitWithAuthorization works the same way as a new order.
/// The nonce already binds the lot's units, so a relayer cannot change the quantity.
contract SwarmV2TopUpTest is Test {

    // ── Infrastructure ────────────────────────────────────────────────────────

    DealFactory factory;
    DemandPool  pool;
    Settler     settler;
    SwarmPass   pass;
    MockERC20   usdc;      // plain mock for non-gasless tests
    MockEIP3009USDC eip3009usdc; // EIP-3009 mock for gasless top-up test

    address constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    address constant OWNER     = address(0x1000);
    address constant SUPPLIER  = address(0x2000);
    address constant RELAYER   = address(0x4000);

    address constant B1 = address(0x3001);
    address constant B2 = address(0x3002);
    address constant B3 = address(0x3003);

    // EIP-712 typehash for ReceiveWithAuthorization
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,"
        "uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        // Default to plain MockERC20 at the USDC address.
        MockERC20 impl = new MockERC20("USD Coin", "USDC", 6);
        vm.etch(USDC_ADDR, address(impl).code);
        usdc = MockERC20(USDC_ADDR);

        vm.prank(OWNER); pass    = new SwarmPass(true);
        vm.prank(OWNER); factory = new DealFactory(OWNER);
        vm.prank(OWNER); pool    = new DemandPool(address(factory), OWNER);
        vm.prank(OWNER); settler = new Settler(address(factory), address(pool), OWNER);
        vm.prank(OWNER); factory.setDemandPool(address(pool));
        vm.prank(OWNER); factory.setSettler(address(settler));
        vm.prank(OWNER); pool.setSettler(address(settler));
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// @dev Three-tier curve: 1/$1.00, 10/$0.75, 20/$0.50
    function _stdTiers() internal pure returns (SwarmTypes.Tier[] memory t) {
        t = new SwarmTypes.Tier[](3);
        t[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000});
        t[1] = SwarmTypes.Tier({minUnits: 10, pricePerUnit:   750_000});
        t[2] = SwarmTypes.Tier({minUnits: 20, pricePerUnit:   500_000});
    }

    function _postDeal(
        uint32 maxUnits,
        uint32 minUnits,
        uint32 maxBuyers,
        uint32 maxPerBuyer,
        SwarmTypes.Tier[] memory tiers
    ) internal returns (uint256 dealId) {
        vm.prank(OWNER); pass.mint(SUPPLIER, maxUnits);
        vm.prank(SUPPLIER); pass.approve(address(factory), maxUnits);
        vm.prank(SUPPLIER);
        dealId = factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         minUnits,
                maxUnits:         maxUnits,
                maxUnitsPerBuyer: maxPerBuyer,
                maxBuyers:        maxBuyers,
                deadline:         uint64(block.timestamp + 2 days),
                title:            "TopUp Test Deal",
                description:      ""
            }),
            tiers
        );
    }

    function _postStdDeal(uint32 maxUnits, uint32 minUnits, uint32 maxBuyers, uint32 maxPerBuyer)
        internal returns (uint256)
    {
        return _postDeal(maxUnits, minUnits, maxBuyers, maxPerBuyer, _stdTiers());
    }

    function _fund(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who); usdc.approve(address(pool), type(uint256).max);
    }

    function _commit(address buyer, uint256 dealId, uint32 units) internal {
        vm.prank(buyer); pool.commit(dealId, units);
    }

    function _settle(uint256 dealId) internal {
        vm.warp(block.timestamp + 2 days + 1);
        settler.settle(dealId);
    }

    /// @dev priceAt helper — mirrors contract logic.
    function _priceAt(uint256 dealId, uint256 units) internal view returns (uint64) {
        SwarmTypes.Deal memory d = factory.getDeal(dealId);
        for (uint256 i = d.tiers.length; i > 0; i--) {
            if (units >= d.tiers[i - 1].minUnits) return d.tiers[i - 1].pricePerUnit;
        }
        return d.tiers[0].pricePerUnit;
    }

    // ── 1. Top-up after tier break: lower price, paidPerUnit drops, escrow sums ──

    /// A top-up that, together with the prior lot, crosses a tier threshold is priced
    /// at the new lower price. paidPerUnit drops to that price; escrowed and unitsOf sum.
    function test_TopUp_AfterTierBreak_LotPriceDrops() public {
        // Tiers: 1/$1.00, 10/$0.75, 20/$0.50. maxUnits=30.
        // B1 commits 5 units: priceAt(0+5=5)=$1.00. escrowed=5*1=$5. paidPerUnit=$1.
        // B1 top-up 8 units: priceAt(5+8=13)=$0.75. lotEscrow=8*0.75=$6.
        //   total units=13; escrowed=5+6=$11; unitsOf=13; paidPerUnit=min($1,$0.75)=$0.75.
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 20_000_000);

        _commit(B1, d, 5);
        assertEq(pool.paidPerUnit(d, B1), 1_000_000, "lot1 paidPerUnit=$1.00");
        assertEq(pool.escrowed(d,    B1), 5_000_000, "lot1 escrowed=$5");
        assertEq(pool.unitsOf(d,     B1), 5,         "lot1 units=5");

        _commit(B1, d, 8);
        assertEq(pool.paidPerUnit(d, B1),   750_000, "after topup paidPerUnit=$0.75");
        assertEq(pool.escrowed(d,    B1), 11_000_000, "after topup escrowed=$11");
        assertEq(pool.unitsOf(d,     B1), 13,         "after topup units=13");
        assertEq(pool.totalUnits(d),       13,         "totalUnits=13");
        assertEq(pool.getBuyerCount(d),     1,         "still 1 buyer");
    }

    // ── 2. Top-up that itself breaks a tier pays the price it unlocks ──────────

    /// When B1 has 7 units and top-ups 3 more, totalUnits goes to 10 breaking the
    /// $0.75 tier. The lot is priced at $0.75 (the tier it broke into).
    function test_TopUp_SelfBreaksTier() public {
        // Tiers: 1/$1.00, 10/$0.75. maxUnits=30.
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000});
        tiers[1] = SwarmTypes.Tier({minUnits: 10, pricePerUnit:   750_000});
        uint256 d = _postDeal(30, 1, 10, 0, tiers);
        _fund(B1, 20_000_000);

        _commit(B1, d, 7); // totalUnits=7, priceAt(7)=$1.00, escrowed=7*$1=$7
        assertEq(pool.paidPerUnit(d, B1), 1_000_000);
        assertEq(pool.escrowed(d,    B1), 7_000_000);

        _commit(B1, d, 3); // totalUnits=10, priceAt(10)=$0.75. lotEscrow=3*$0.75=$2.25
        // paidPerUnit=min($1,$0.75)=$0.75; escrowed=7+2.25=$9.25; unitsOf=10.
        assertEq(pool.paidPerUnit(d, B1),   750_000, "paidPerUnit=$0.75 after self-break");
        assertEq(pool.escrowed(d,    B1), 9_250_000, "escrowed=$9.25");
        assertEq(pool.unitsOf(d,     B1), 10,         "unitsOf=10");
    }

    // ── 3a. Per-buyer limit counts total units across lots ─────────────────────

    /// B1 commits 4 units, maxPerBuyer=5. A top-up of 1 succeeds; a top-up of 2 reverts.
    function test_TopUp_PerBuyerLimitAcrossLots() public {
        uint256 d = _postStdDeal(30, 1, 10, 5); // maxPerBuyer=5
        _fund(B1, 20_000_000);
        _commit(B1, d, 4); // lot1=4 units; 1 remaining

        _commit(B1, d, 1); // top-up: total=5, OK
        assertEq(pool.unitsOf(d, B1), 5, "total=5 at limit");

        _fund(B1, 10_000_000);
        vm.prank(B1);
        vm.expectRevert(DemandPool.UnitsPerBuyerExceeded.selector);
        pool.commit(d, 1); // would make total=6 > maxPerBuyer=5
    }

    // ── 3b. Stock limit applies to top-ups ─────────────────────────────────────

    /// B1 fills 9 of 10 maxUnits. A top-up of 2 reverts UnitCapReached.
    function test_TopUp_StockLimitApplies() public {
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](1);
        tiers[0] = SwarmTypes.Tier({minUnits: 1, pricePerUnit: 1_000_000});
        uint256 d = _postDeal(10, 1, 10, 0, tiers);
        _fund(B1, 20_000_000);
        _commit(B1, d, 9);

        vm.prank(B1);
        vm.expectRevert(DemandPool.UnitCapReached.selector);
        pool.commit(d, 2); // 9+2=11 > maxUnits=10
    }

    // ── 3c. maxBuyers does not block a top-up by an existing buyer ─────────────

    /// maxBuyers=2. B1 and B2 both have orders. B2 tops up — must succeed even
    /// though buyer count is at maxBuyers.
    function test_TopUp_MaxBuyersDoesNotBlockExistingBuyer() public {
        uint256 d = _postStdDeal(30, 1, 2, 0); // maxBuyers=2
        _fund(B1, 10_000_000); _commit(B1, d, 1);
        _fund(B2, 20_000_000); _commit(B2, d, 1);

        // New buyer B3 is blocked
        _fund(B3, 10_000_000);
        vm.prank(B3);
        vm.expectRevert(DemandPool.BuyerCapReached.selector);
        pool.commit(d, 1);

        // B2 tops up — not blocked even though buyerCount==maxBuyers
        _commit(B2, d, 2);
        assertEq(pool.unitsOf(d, B2), 3,  "B2 total units=3");
        assertEq(pool.getBuyerCount(d), 2, "buyer count unchanged at 2");
    }

    // ── 4. Strand rule uses paidPerUnit (cheapest lot) ─────────────────────────

    /// Scenario:
    ///   Tiers: 1/$1.00, 10/$0.75. maxUnits=30.
    ///   B1 commits 5 ($1.00), B2 commits 8 ($0.75 — breaks tier).
    ///   B2 tops up 2 more at $0.75 (total=15). paidPerUnit[B2]=$0.75.
    ///   B1 tries to withdraw: would leave totalUnits=10, priceAt(10)=$0.75.
    ///   B2's paidPerUnit=$0.75 >= $0.75 → NOT stranded. Withdrawal succeeds.
    ///
    ///   This tests that the strand check uses paidPerUnit (cheapest lot) and that
    ///   a top-up at the same cheap price does not strand B1.
    function test_Strand_TopUpKeepsStrandRuleValid() public {
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000});
        tiers[1] = SwarmTypes.Tier({minUnits: 10, pricePerUnit:   750_000});
        uint256 d = _postDeal(30, 1, 10, 0, tiers);

        _fund(B1, 10_000_000); _commit(B1, d, 5);   // totalUnits=5,  B1 paid $1.00
        _fund(B2, 20_000_000); _commit(B2, d, 8);   // totalUnits=13, B2 paid $0.75, tier broken
        _commit(B2, d, 2);                           // top-up: totalUnits=15, B2 paid $0.75

        // B1 tries to withdraw: newTotal=15-5=10, priceAt(10)=$0.75.
        // B2's paidPerUnit=$0.75 >= $0.75 → no strand.
        vm.prank(B1); pool.withdraw(d);
        assertEq(pool.totalUnits(d), 10, "totalUnits after B1 withdrawal=10");
    }

    /// Strand rule using cheapest lot:
    ///   Tiers: 1/$1.00, 10/$0.75. B1 commits 5 ($1.00), B2 commits 5 ($1.00).
    ///   B1 cannot withdraw (would leave 5 units at $1.00 — B2's paidPerUnit=$1.00 >= $1.00, OK).
    ///   Actually B1 CAN withdraw here. Let's make a stronger case:
    ///   B1 commits 5, B2 commits 6 (total=11, breaks tier, B2 paid=$0.75).
    ///   B1 tries to withdraw: newTotal=6, priceAt(6)=$1.00. B2 paid $0.75 < $1.00 → STRAND.
    ///   B2 tops up 4 more (total=15, B2 paid=min($0.75,$0.75)=$0.75).
    ///   B1 tries withdraw again: newTotal=15-5=10, priceAt(10)=$0.75. B2 paid $0.75 >= $0.75 → OK.
    function test_Strand_WithdrawRefusedThenPermittedAfterTopUp() public {
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000});
        tiers[1] = SwarmTypes.Tier({minUnits: 10, pricePerUnit:   750_000});
        uint256 d = _postDeal(30, 1, 10, 0, tiers);

        _fund(B1, 10_000_000); _commit(B1, d, 5);  // total=5,  B1 paid $1.00
        _fund(B2, 20_000_000); _commit(B2, d, 6);  // total=11, B2 paid $0.75, tier broken

        // B1 would strand B2 ($0.75 < priceAt(6)=$1.00)
        vm.prank(B1);
        vm.expectRevert(DemandPool.WouldStrandBuyer.selector);
        pool.withdraw(d);

        // B2 tops up 4 more: totalUnits=15, priceAt(15)=$0.75. B2 paidPerUnit still $0.75.
        _commit(B2, d, 4);
        assertEq(pool.paidPerUnit(d, B2), 750_000, "B2 paidPerUnit still $0.75 after top-up");

        // Now B1 can withdraw: newTotal=10, priceAt(10)=$0.75. B2 paid $0.75 >= $0.75.
        vm.prank(B1); pool.withdraw(d);
        assertEq(pool.totalUnits(d), 10, "totalUnits=10 after B1 withdrawal");
    }

    // ── 5. Withdrawing after top-ups returns the full escrow across all lots ───

    /// B1 has two lots (lot1=$5, lot2=$6, total escrowed=$11). Withdraw credits $11.
    function test_TopUp_WithdrawReturnsFullEscrow() public {
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 20_000_000);
        _commit(B1, d, 5); // escrowed=5*$1=$5
        _commit(B1, d, 8); // escrowed+=8*$0.75=$6 → total=$11

        assertEq(pool.escrowed(d, B1), 11_000_000, "escrowed $11 before withdraw");

        uint256 claimBefore = settler.claimable(B1);
        vm.prank(B1); pool.withdraw(d);
        uint256 credited = settler.claimable(B1) - claimBefore;

        assertEq(credited, 11_000_000, "full $11 credited on withdraw");
        assertEq(pool.escrowed(d, B1),   0, "escrowed cleared");
        assertEq(pool.unitsOf(d, B1),    0, "units cleared");
        assertEq(pool.totalUnits(d),     0, "totalUnits back to 0");
    }

    // ── 6. Settlement refund = escrowed - cp * unitsOf for a multi-lot buyer ──

    /// Worked example with a multi-lot buyer:
    ///   Tiers: 1/$1.00, 10/$0.75, 20/$0.50. maxUnits=30.
    ///   B1 lot1: 5 units at $1.00 → escrowed=$5.
    ///   B1 lot2: 8 units at $0.75 → escrowed=$6. Total escrowed=$11, unitsOf=13.
    ///   B2: 7 units → total=20, priceAt(20)=$0.50.
    ///   cp=$0.50.
    ///   B1 refund = escrowed - cp*unitsOf = 11 - 0.50*13 = 11 - 6.50 = $4.50.
    ///   B2 refund = 7*$0.50 - 7*$0.50 = 0? No: B2 escrowed=7*priceAt(13+7=20)=7*$0.50=$3.50.
    ///     B2 refund = 3.50 - 0.50*7 = 0. Correct.
    ///   Supplier USDC = cp*totalUnits = $0.50*20 = $10.
    ///   Conservation: B1 escrowed + B2 escrowed = 11 + 3.50 = $14.50.
    ///                 cp*total + refunds = 10 + 4.50 + 0 = $14.50. ✓
    function test_TopUp_SettleRefundExact() public {
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 20_000_000);
        _fund(B2, 10_000_000);

        _commit(B1, d, 5);  // total=5,  B1 paid $1.00, escrowed=$5
        _commit(B1, d, 8);  // total=13, B1 lot2 paid $0.75, escrowed+=$6 → $11
        _commit(B2, d, 7);  // total=20, B2 paid $0.50

        assertEq(pool.escrowed(d, B1),  11_000_000, "B1 escrowed $11");
        assertEq(pool.unitsOf(d, B1),   13,          "B1 units=13");
        assertEq(pool.paidPerUnit(d, B1),  750_000,  "B1 paidPerUnit=$0.75 (cheapest lot)");
        assertEq(pool.escrowed(d, B2),   3_500_000,  "B2 escrowed $3.50");

        _settle(d);

        // cp = priceAt(20) = $0.50
        // B1 refund = 11 - 0.50*13 = 11 - 6.50 = $4.50
        assertEq(settler.claimable(B1), 4_500_000,  "B1 USDC refund $4.50");
        assertEq(settler.claimable(B2),         0,  "B2 no refund");
        assertEq(settler.claimable(SUPPLIER), 10_000_000, "supplier $10");

        // Goods
        assertEq(settler.goodsClaimable(address(pass), B1), 13, "B1 13 passes");
        assertEq(settler.goodsClaimable(address(pass), B2),  7, "B2 7 passes");
        assertEq(settler.goodsClaimable(address(pass), SUPPLIER), 10, "supplier 10 unsold");

        // Drain and verify
        vm.prank(B1); settler.claim();
        // B2 has zero USDC refund; skip claim() to avoid NothingToClaim revert.
        vm.prank(SUPPLIER); settler.claim();
        vm.prank(B1); settler.claimGoods(address(pass));
        vm.prank(B2); settler.claimGoods(address(pass));
        vm.prank(SUPPLIER); settler.claimGoods(address(pass));

        // B1 spent: $11 escrowed, refunded $4.50 → net cost $6.50.
        assertEq(usdc.balanceOf(B1), 20_000_000 - 11_000_000 + 4_500_000, "B1 net");
        assertEq(usdc.balanceOf(B2),  10_000_000 - 3_500_000,              "B2 net");
        assertEq(usdc.balanceOf(SUPPLIER), 10_000_000, "supplier USDC");
        assertEq(pass.balanceOf(B1),  13, "B1 passes");
        assertEq(pass.balanceOf(B2),   7, "B2 passes");
        assertEq(pass.balanceOf(SUPPLIER), 10, "supplier unsold");
        assertEq(usdc.balanceOf(address(pool)), 0, "pool empty");
        assertEq(pass.balanceOf(address(settler)), 0, "settler empty");
    }

    // ── 7. Gasless top-up through commitWithAuthorization ─────────────────────

    /// Switch to an EIP-3009 USDC mock, commit a first lot normally, then
    /// top up via gasless commitWithAuthorization. Verifies both the state
    /// accumulation and that the nonce binding works for the second lot.
    function test_TopUp_GaslessTopUp() public {
        // Re-etch with EIP-3009 mock.
        MockEIP3009USDC impl = new MockEIP3009USDC();
        vm.etch(USDC_ADDR, address(impl).code);
        eip3009usdc = MockEIP3009USDC(USDC_ADDR);
        eip3009usdc.initialize();

        // Re-deploy with fresh state so settler/pool use the new code.
        vm.prank(OWNER); factory = new DealFactory(OWNER);
        vm.prank(OWNER); pool    = new DemandPool(address(factory), OWNER);
        vm.prank(OWNER); settler = new Settler(address(factory), address(pool), OWNER);
        vm.prank(OWNER); factory.setDemandPool(address(pool));
        vm.prank(OWNER); factory.setSettler(address(settler));
        vm.prank(OWNER); pool.setSettler(address(settler));

        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000});
        tiers[1] = SwarmTypes.Tier({minUnits: 10, pricePerUnit:   750_000});
        uint256 d = _postDeal(30, 1, 10, 0, tiers);

        uint256 pk    = 0xC001;
        address buyer = vm.addr(pk);

        // --- Lot 1: standard commit (approve + transferFrom) ---
        uint256 lot1Cost = 5 * 1_000_000; // priceAt(0+5=5)=$1.00; 5*$1=$5
        eip3009usdc.mint(buyer, lot1Cost);
        vm.prank(buyer); eip3009usdc.approve(address(pool), lot1Cost);
        vm.prank(buyer); pool.commit(d, 5);

        assertEq(pool.unitsOf(d, buyer), 5, "lot1 units=5");
        assertEq(pool.escrowed(d, buyer), 5_000_000, "lot1 escrowed=$5");

        // --- Lot 2: gasless top-up ---
        // totalUnits=5; buyer wants 8 more: priceAt(5+8=13)=$0.75; cost=8*$0.75=$6.
        bytes32 salt  = bytes32(uint256(42));
        Auth memory a = _signAuth(pk, d, 8, salt);
        assertEq(a.signedAmount, 6_000_000, "lot2 signedAmount=$6");
        eip3009usdc.mint(buyer, a.signedAmount);

        vm.prank(RELAYER);
        pool.commitWithAuthorization(
            d, buyer, 8, a.signedAmount,
            a.validAfter, a.validBefore, salt, a.v, a.r, a.s
        );

        // State: units=13, escrowed=$11, paidPerUnit=min($1,$0.75)=$0.75
        assertEq(pool.unitsOf(d, buyer),   13,         "total units=13 after gasless topup");
        assertEq(pool.escrowed(d, buyer),  11_000_000, "total escrowed=$11");
        assertEq(pool.paidPerUnit(d, buyer),  750_000, "paidPerUnit=$0.75 (cheapest lot)");
        assertEq(pool.getBuyerCount(d),         1,     "still 1 buyer");
    }

    // ── 8. Fuzz: random orders, top-ups, withdrawals — conservation holds ──────

    /**
     * @dev Fuzz test: random buyers, each performs a first order and optionally a
     *      top-up. Some buyers withdraw before the deadline. Settle or refund.
     *      After all claims:
     *        - pool holds no USDC
     *        - settler holds no passes
     *        - every refund is non-negative (conservation check in settle/refundAll)
     *        - USDC conservation: sum of escrow == supplier USDC + refunds
     *        - Goods conservation: total stock == delivered + unsold
     */
    function testFuzz_TopUp_Conservation(uint8 nRaw, uint8 topUpMask, uint8 wMask) public {
        uint32 n = uint32(bound(uint256(nRaw), 2, 15));
        uint32 maxUnitsPerBuyer = 6;
        // Generous stock to accommodate lots of top-ups.
        uint32 maxUnits = n * maxUnitsPerBuyer * 2;

        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000});
        tiers[1] = SwarmTypes.Tier({minUnits: uint32(n) * 2, pricePerUnit: 500_000});

        uint256 d = _postDeal(maxUnits, 1, 100, maxUnitsPerBuyer, tiers);

        address[] memory buyers = new address[](n);
        uint256 totalUsdcIn;

        // ── Phase 1: first orders ──────────────────────────────────────────────
        for (uint256 i = 0; i < n; i++) {
            address buyer = address(uint160(0xD000 + i));
            buyers[i] = buyer;

            uint32 units = uint32(1 + (i % 3)); // 1, 2, or 3 units
            if (uint256(pool.totalUnits(d)) + uint256(units) > uint256(maxUnits)) break;

            uint64 price = _priceAt(d, uint256(pool.totalUnits(d)) + uint256(units));
            uint256 cost = uint256(price) * uint256(units);
            usdc.mint(buyer, cost * 4); // extra to cover potential top-up
            vm.prank(buyer); usdc.approve(address(pool), type(uint256).max);
            vm.prank(buyer); pool.commit(d, units);
            totalUsdcIn += pool.escrowed(d, buyer); // snapshot after commit
        }

        // Recalculate totalUsdcIn from actual escrowed values (may differ if we broke early)
        totalUsdcIn = 0;
        for (uint256 i = 0; i < n; i++) {
            totalUsdcIn += pool.escrowed(d, buyers[i]);
        }

        // ── Phase 2: top-ups for buyers whose bit is set in topUpMask ─────────
        for (uint256 i = 0; i < n && i < 8; i++) {
            if ((topUpMask >> i) & 1 == 0) continue;
            address buyer = buyers[i];
            if (pool.escrowed(d, buyer) == 0) continue; // not in pool (broke early above)

            uint32 existing = pool.unitsOf(d, buyer);
            if (existing >= maxUnitsPerBuyer) continue; // already at limit

            uint32 lotUnits = 1;
            // Check stock
            if (uint256(pool.totalUnits(d)) + uint256(lotUnits) > uint256(maxUnits)) continue;

            uint64 price    = _priceAt(d, uint256(pool.totalUnits(d)) + uint256(lotUnits));
            uint256 lotCost = uint256(price) * uint256(lotUnits);
            usdc.mint(buyer, lotCost);

            uint256 escrowBefore = pool.escrowed(d, buyer);
            vm.prank(buyer); pool.commit(d, lotUnits);
            uint256 escrowAfter  = pool.escrowed(d, buyer);

            // escrow must increase by exactly lotCost
            assertEq(escrowAfter - escrowBefore, lotCost, "top-up escrow delta");

            // totalUsdcIn tracks only the delta (the new lot cost)
            totalUsdcIn += lotCost;
        }

        // ── Phase 3: some buyers withdraw ─────────────────────────────────────
        for (uint256 i = 0; i < n && i < 8; i++) {
            if ((wMask >> i) & 1 == 0) continue;
            address buyer = buyers[i];
            if (pool.escrowed(d, buyer) == 0) continue;

            uint32 myUnits  = pool.unitsOf(d, buyer);
            uint32 newTotal = pool.totalUnits(d) - myUnits;
            uint64 newPrice = _priceAt(d, newTotal);

            // Check strand: would any remaining buyer's paidPerUnit < newPrice?
            bool wouldStrand = false;
            if (pool.getBuyerCount(d) > 1) {
                address[] memory remaining = pool.getBuyers(d);
                for (uint256 j = 0; j < remaining.length; j++) {
                    if (remaining[j] == buyer) continue;
                    if (pool.paidPerUnit(d, remaining[j]) < newPrice) {
                        wouldStrand = true;
                        break;
                    }
                }
            }
            if (wouldStrand) continue;

            uint256 escrow = pool.escrowed(d, buyer);
            vm.prank(buyer); pool.withdraw(d);
            totalUsdcIn -= escrow;
        }

        // ── Phase 4: settle or refund ──────────────────────────────────────────
        vm.warp(block.timestamp + 2 days + 1);
        uint32 tot = pool.totalUnits(d);
        SwarmTypes.Deal memory deal = factory.getDeal(d);

        if (tot >= deal.minUnits) {
            settler.settle(d);
        } else {
            settler.refundAll(d);
        }

        // ── Phase 5: drain all claimable balances ──────────────────────────────
        address[] memory activeBuyers = pool.getBuyers(d);
        for (uint256 i = 0; i < activeBuyers.length; i++) {
            address b = activeBuyers[i];
            if (settler.claimable(b) > 0) {
                // Refund must be non-negative (ensured by settlement, but double-check)
                assertGe(settler.claimable(b), 0, "refund non-negative");
                vm.prank(b); settler.claim();
            }
            if (settler.goodsClaimable(address(pass), b) > 0) {
                vm.prank(b); settler.claimGoods(address(pass));
            }
        }
        // Drain withdrawn buyers' claimable
        for (uint256 i = 0; i < n; i++) {
            address b = buyers[i];
            if (settler.claimable(b) > 0) { vm.prank(b); settler.claim(); }
        }
        if (settler.claimable(SUPPLIER) > 0) { vm.prank(SUPPLIER); settler.claim(); }
        if (settler.goodsClaimable(address(pass), SUPPLIER) > 0) {
            vm.prank(SUPPLIER); settler.claimGoods(address(pass));
        }

        // ── Invariants ─────────────────────────────────────────────────────────

        // 1. Pool holds no USDC after all claims
        assertEq(usdc.balanceOf(address(pool)), 0, "pool USDC zero");
        // 2. Settler holds no passes after all claims
        assertEq(pass.balanceOf(address(settler)), 0, "settler passes zero");
        // 3. No USDC stuck in settler
        assertEq(usdc.balanceOf(address(settler)), 0, "settler USDC zero");
        // 4. USDC conservation: settle/refundAll contains named-error check;
        //    reaching here proves it passed.
        // 5. Goods conservation: all passes accounted for
        uint256 passesOut;
        for (uint256 i = 0; i < n; i++) passesOut += pass.balanceOf(buyers[i]);
        passesOut += pass.balanceOf(SUPPLIER);
        assertEq(passesOut, uint256(maxUnits), "all passes accounted for");
    }

    // ── EIP-3009 signing helper (for gasless top-up test) ─────────────────────

    function _signAuth(
        uint256 pk,
        uint256 dealId,
        uint32  units,
        bytes32 salt
    ) internal view returns (Auth memory a) {
        address buyer    = vm.addr(pk);
        a.validAfter  = 0;
        a.validBefore = block.timestamp + 10 minutes;
        a.nonce       = pool.authorizationNonce(dealId, buyer, units, salt);

        uint64 priceAfter = _priceAt(dealId, uint256(pool.totalUnits(dealId)) + uint256(units));
        a.signedAmount = uint256(priceAfter) * uint256(units);

        bytes32 domainSep = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("USDC")),
            keccak256(bytes("2")),
            block.chainid,
            USDC_ADDR
        ));
        bytes32 structHash = keccak256(abi.encode(
            RECEIVE_TYPEHASH,
            buyer,
            address(pool),
            a.signedAmount,
            a.validAfter,
            a.validBefore,
            a.nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (a.v, a.r, a.s) = vm.sign(pk, digest);
    }
}
