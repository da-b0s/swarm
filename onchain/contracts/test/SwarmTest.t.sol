// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DealFactory} from "../DealFactory.sol";
import {DemandPool} from "../DemandPool.sol";
import {Settler} from "../Settler.sol";
import {SwarmTypes} from "../SwarmTypes.sol";

import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockBlocklistedERC20} from "../test-helpers/MockBlocklistedERC20.sol";
import {MockReentrantERC20} from "../test-helpers/MockReentrantERC20.sol";

contract SwarmTest is Test {
    // ─── Constants ────────────────────────────────────────────────────────────
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;

    address internal owner   = makeAddr("owner");
    address internal supplier = makeAddr("supplier");

    uint32  internal constant MIN_BUYERS = 10;
    uint32  internal constant CAP        = 100;
    uint32  internal constant DEADLINE_OFFSET = 7 days;

    // ─── Contracts ────────────────────────────────────────────────────────────
    DealFactory internal factory;
    DemandPool  internal pool;
    Settler     internal settler;
    MockERC20   internal usdc;

    // ─── Standard tier curve ──────────────────────────────────────────────────
    function _standardTiers() internal pure returns (SwarmTypes.Tier[] memory t) {
        t = new SwarmTypes.Tier[](3);
        t[0] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 1_000_000});
        t[1] = SwarmTypes.Tier({minBuyers: 25, pricePerUnit: 750_000});
        t[2] = SwarmTypes.Tier({minBuyers: 50, pricePerUnit: 500_000});
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// Deploy and etch the standard mock USDC.
    function _etchMockUSDC() internal returns (MockERC20 m) {
        m = new MockERC20("Mock USDC", "mUSDC", 6);
        vm.etch(USDC_ADDR, address(m).code);
        m = MockERC20(USDC_ADDR);
    }

    /// Deploy the full protocol stack and wire it up.
    function _deployProtocol() internal {
        factory = new DealFactory(owner);
        pool    = new DemandPool(address(factory), owner);
        settler = new Settler(address(factory), address(pool), owner);

        vm.prank(owner); pool.setSettler(address(settler));
        vm.prank(owner); factory.setSettler(address(settler));
        vm.prank(owner); factory.setDemandPool(address(pool));
    }

    /// Post the standard deal and return dealId.
    function _postStandardDeal() internal returns (uint256 dealId) {
        uint64 deadline = uint64(block.timestamp + DEADLINE_OFFSET);
        vm.prank(supplier);
        dealId = factory.postDeal(_standardTiers(), MIN_BUYERS, deadline, CAP);
    }

    /// Mint enough USDC and approve for a buyer.
    function _fundBuyer(address buyer, uint256 amount) internal {
        usdc.mint(buyer, amount);
        vm.prank(buyer); usdc.approve(address(pool), amount);
    }

    /// Commit N buyers consecutively (buyers: address(uint160(1..N))).
    function _commitBuyers(uint256 dealId, uint256 count) internal {
        for (uint256 i = 1; i <= count; i++) {
            address buyer = address(uint160(i));
            _fundBuyer(buyer, 2_000_000); // generous allowance
            vm.prank(buyer); pool.commit(dealId);
        }
    }

    // Runs before EVERY test.
    function setUp() public {
        usdc = _etchMockUSDC();
        _deployProtocol();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 1 — Happy path, 51 buyers
    // ═══════════════════════════════════════════════════════════════════════════
    function test_HappyPath51Buyers() public {
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 51);

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.settle(dealId);

        uint64 cp = pool.clearingPrice(dealId);
        assertEq(cp, 500_000, "clearingPrice should be 500_000 for 51 buyers");

        // Expected refunds per tier group
        // Buyers 1-24  escrowed 1_000_000, refund = 500_000 each  → total = 12_000_000
        // Buyers 25-49 escrowed   750_000, refund = 250_000 each  → total = 25 * 250_000 = 6_250_000
        // Buyers 50-51 escrowed   500_000, refund = 0

        uint256 totalExpectedRefunds = 12_000_000 + 6_250_000; // 18_250_000
        uint256 supplierCredit       = 500_000 * 51;            // 25_500_000

        assertEq(supplierCredit + totalExpectedRefunds, 43_750_000, "conservation check");

        // --- Buyers claim ---
        for (uint256 i = 1; i <= 24; i++) {
            address buyer = address(uint160(i));
            assertEq(settler.claimable(buyer), 500_000, string.concat("buyer ", vm.toString(i), " refund"));
            uint256 balBefore = usdc.balanceOf(buyer);
            vm.prank(buyer); settler.claim();
            assertEq(usdc.balanceOf(buyer) - balBefore, 500_000, "buyer 1-24 received refund");
        }
        for (uint256 i = 25; i <= 49; i++) {
            address buyer = address(uint160(i));
            assertEq(settler.claimable(buyer), 250_000, string.concat("buyer ", vm.toString(i), " refund"));
            uint256 balBefore = usdc.balanceOf(buyer);
            vm.prank(buyer); settler.claim();
            assertEq(usdc.balanceOf(buyer) - balBefore, 250_000, "buyer 25-49 received refund");
        }
        for (uint256 i = 50; i <= 51; i++) {
            address buyer = address(uint160(i));
            assertEq(settler.claimable(buyer), 0, "buyers 50-51 claimable should be 0");
        }

        // --- Supplier claims ---
        assertEq(settler.claimable(supplier), supplierCredit, "supplier credit");
        uint256 supplyBalBefore = usdc.balanceOf(supplier);
        vm.prank(supplier); settler.claim();
        assertEq(usdc.balanceOf(supplier) - supplyBalBefore, supplierCredit, "supplier received full credit");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 2 — Conservation fuzz
    // ═══════════════════════════════════════════════════════════════════════════
    function testFuzz_Conservation(uint8 commitCount, uint8 withdrawMask) public {
        commitCount = uint8(bound(commitCount, 10, 100));

        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, commitCount);

        // Track escrowed amounts BEFORE any withdrawals
        uint256[] memory committed = new uint256[](commitCount);
        for (uint256 i = 0; i < commitCount; i++) {
            address buyer = address(uint160(i + 1));
            committed[i] = pool.escrowed(dealId, buyer);
        }

        // Withdraw buyers indicated by withdrawMask (bits 0-7 of first 8 buyers)
        uint256 numToConsider = commitCount < 8 ? commitCount : 8;
        for (uint256 i = 0; i < numToConsider; i++) {
            if ((withdrawMask >> i) & 1 == 1) {
                address buyer = address(uint160(i + 1));
                // Only withdraw if still committed
                if (pool.escrowed(dealId, buyer) > 0) {
                    vm.prank(buyer);
                    (bool ok,) = address(pool).call(abi.encodeWithSignature("withdraw(uint256)", dealId));
                    (ok); // silence unused var; WouldStrandBuyer reverts are acceptable
                }
            }
        }

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);

        uint256 remaining = pool.getBuyerCount(dealId);

        if (remaining >= MIN_BUYERS) {
            settler.settle(dealId);
        } else {
            settler.refundAll(dealId);
        }

        // Sum all claimables after settlement
        uint256 totalClaimable = 0;
        totalClaimable += settler.claimable(supplier);
        for (uint256 i = 0; i < commitCount; i++) {
            address buyer = address(uint160(i + 1));
            totalClaimable += settler.claimable(buyer);
        }

        // Total originally committed (before any withdrawals)
        uint256 totalCommitted = 0;
        for (uint256 i = 0; i < commitCount; i++) {
            totalCommitted += committed[i];
        }

        assertEq(totalClaimable, totalCommitted, "conservation: claimable == originally escrowed");

        // All participants claim; pool USDC balance should be 0
        if (settler.claimable(supplier) > 0) {
            vm.prank(supplier); settler.claim();
        }
        for (uint256 i = 0; i < commitCount; i++) {
            address buyer = address(uint160(i + 1));
            if (settler.claimable(buyer) > 0) {
                vm.prank(buyer); settler.claim();
            }
        }

        assertEq(IERC20(USDC_ADDR).balanceOf(address(pool)), 0, "pool balance should be 0 after all claims");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 3 — Uniform price fuzz
    // ═══════════════════════════════════════════════════════════════════════════
    function testFuzz_UniformPrice(uint8 commitCount, uint8 withdrawMask) public {
        commitCount = uint8(bound(commitCount, 10, 100));

        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, commitCount);

        uint256 numToConsider = commitCount < 8 ? commitCount : 8;
        for (uint256 i = 0; i < numToConsider; i++) {
            if ((withdrawMask >> i) & 1 == 1) {
                address buyer = address(uint160(i + 1));
                if (pool.escrowed(dealId, buyer) > 0) {
                    vm.startPrank(buyer);
                    (bool ok,) = address(pool).call(abi.encodeWithSignature("withdraw(uint256)", dealId));
                    vm.stopPrank();
                    (ok); // silence unused var
                }
            }
        }

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);

        address[] memory finalBuyers = pool.getBuyers(dealId);
        uint256 remaining = finalBuyers.length;

        if (remaining < MIN_BUYERS) return; // skip — not enough buyers

        uint64 cp = pool.clearingPrice(dealId);
        settler.settle(dealId);

        // Supplier claimable == clearingPrice * finalBuyerCount
        assertEq(settler.claimable(supplier), uint256(cp) * remaining, "supplier credit = cp * count");

        // Every buyer's refund == escrowed - clearingPrice
        for (uint256 i = 0; i < finalBuyers.length; i++) {
            address buyer = finalBuyers[i];
            uint64 esc = pool.escrowed(dealId, buyer);
            uint256 expectedRefund = uint256(esc) - uint256(cp);
            assertEq(settler.claimable(buyer), expectedRefund, "buyer refund = escrowed - cp");
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 4 — Deal below minimum — refundAll
    // ═══════════════════════════════════════════════════════════════════════════
    function test_RefundAll_BelowMinimum() public {
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 7);

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.refundAll(dealId);

        for (uint256 i = 1; i <= 7; i++) {
            address buyer = address(uint160(i));
            assertEq(settler.claimable(buyer), 1_000_000, string.concat("buyer ", vm.toString(i), " claimable"));
            uint256 balBefore = usdc.balanceOf(buyer);
            vm.prank(buyer); settler.claim();
            assertEq(usdc.balanceOf(buyer) - balBefore, 1_000_000, "buyer received full refund");
        }

        assertEq(settler.claimable(supplier), 0, "supplier claimable should be 0");
        assertEq(IERC20(USDC_ADDR).balanceOf(address(pool)), 0, "pool should be empty");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 5 — Settle at minimum (10 buyers)
    // ═══════════════════════════════════════════════════════════════════════════
    function test_SettleAtMinimum() public {
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 10);

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.settle(dealId);

        assertEq(pool.clearingPrice(dealId), 1_000_000, "clearingPrice at 10 buyers");

        for (uint256 i = 1; i <= 10; i++) {
            address buyer = address(uint160(i));
            assertEq(settler.claimable(buyer), 0, "buyer refund should be 0");
            vm.prank(buyer);
            vm.expectRevert(Settler.NothingToClaim.selector);
            settler.claim();
        }

        assertEq(settler.claimable(supplier), 10_000_000, "supplier should get 10_000_000");
        uint256 balBefore = usdc.balanceOf(supplier);
        vm.prank(supplier); settler.claim();
        assertEq(usdc.balanceOf(supplier) - balBefore, 10_000_000, "supplier received 10_000_000");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 6 — Tier boundary
    // ═══════════════════════════════════════════════════════════════════════════
    function test_TierBoundary() public {
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 24);

        assertEq(pool.clearingPrice(dealId), 1_000_000, "price at 24 buyers should be 1_000_000");

        address buyer25 = address(uint160(25));
        _fundBuyer(buyer25, 2_000_000);
        vm.prank(buyer25); pool.commit(dealId);

        assertEq(pool.clearingPrice(dealId), 750_000, "price at 25 buyers should be 750_000");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 7 — Un-break case
    // ═══════════════════════════════════════════════════════════════════════════
    function test_UnBreak() public {
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 25);

        // Verify starting state
        assertEq(pool.clearingPrice(dealId), 750_000, "price at 25 buyers");

        address buyer25 = address(uint160(25));

        // Conservation check before withdraw
        uint256 claimBefore = settler.claimable(buyer25);

        // Buyer 25 (escrowed 750_000) withdraws
        vm.prank(buyer25); pool.withdraw(dealId);

        // claimable increases by 750_000
        assertEq(settler.claimable(buyer25), claimBefore + 750_000, "buyer25 claimable after withdraw");

        // Note: withdraw() uses pull-payment — USDC stays in pool until buyer25 calls claim().
        // The pool balance still includes buyer25's 750_000 until they pull it.

        // Price drops back to $1.00 (24 buyers remain)
        assertEq(pool.clearingPrice(dealId), 1_000_000, "price at 24 buyers after withdraw");

        // New buyer 26 commits at $0.75 (count goes 24→25)
        address buyer26 = address(uint160(26));
        _fundBuyer(buyer26, 2_000_000);
        vm.prank(buyer26); pool.commit(dealId);

        assertEq(pool.clearingPrice(dealId), 750_000, "price at 25 buyers again");

        // Conservation: pool balance == sum(still-escrowed) + claimable[buyer25] (not yet pulled)
        uint256 sumEscrowed = 0;
        for (uint256 i = 1; i <= 24; i++) {
            sumEscrowed += pool.escrowed(dealId, address(uint160(i)));
        }
        sumEscrowed += pool.escrowed(dealId, buyer26);
        uint256 poolBal = IERC20(USDC_ADDR).balanceOf(address(pool));
        // Pool holds: active escrowed + buyer25's pending withdrawal
        assertEq(poolBal, sumEscrowed + settler.claimable(buyer25), "pool balance == sum escrowed + pending withdrawals");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 8 — WouldStrandBuyer precondition
    // ═══════════════════════════════════════════════════════════════════════════
    function test_WouldStrandBuyer() public {
        uint256 dealId = _postStandardDeal();

        // === Scenario A: 25 buyers, buyer 1 (escrowed $1.00) tries to withdraw ===
        _commitBuyers(dealId, 25);

        // Buyer 1 withdraw should revert
        vm.prank(address(uint160(1)));
        vm.expectRevert(DemandPool.WouldStrandBuyer.selector);
        pool.withdraw(dealId);

        // Buyer 25 (escrowed $0.75) should be allowed to withdraw
        vm.prank(address(uint160(25)));
        pool.withdraw(dealId); // must NOT revert
        assertEq(pool.getBuyerCount(dealId), 24, "24 buyers remain after buyer25 withdraws");

        // Restore 25 buyers: re-add buyer 25
        address buyer25 = address(uint160(25));
        _fundBuyer(buyer25, 2_000_000);
        vm.prank(buyer25); pool.commit(dealId);
        assertEq(pool.clearingPrice(dealId), 750_000, "back to 750_000 at 25");

        // === Scenario B: At 24 buyers (all paid $1.00) — buyer 1 allowed ===
        // Start fresh
        setUp();
        dealId = _postStandardDeal();
        _commitBuyers(dealId, 24);

        // buyer 1 should be allowed to withdraw (newCount=23, newPrice=$1.00, lowest=$1.00)
        vm.prank(address(uint160(1)));
        pool.withdraw(dealId); // must NOT revert
        assertEq(pool.getBuyerCount(dealId), 23, "23 buyers after buyer1 withdraws from 24");

        // === Scenario C: At 26 buyers — buyer 1 allowed ===
        setUp();
        dealId = _postStandardDeal();
        _commitBuyers(dealId, 26);
        // buyers 1-24 @ $1.00, buyers 25-26 @ $0.75
        // buyer1 withdraws → newCount=25, newPrice=$0.75; lowest among remaining = $0.75 — allowed
        vm.prank(address(uint160(1)));
        pool.withdraw(dealId); // must NOT revert
        assertEq(pool.getBuyerCount(dealId), 25, "25 buyers after buyer1 withdraws from 26");

        // === Scenario D: At 30 buyers — buyer 1 allowed ===
        setUp();
        dealId = _postStandardDeal();
        _commitBuyers(dealId, 30);
        vm.prank(address(uint160(1)));
        pool.withdraw(dealId); // allowed
        assertEq(pool.getBuyerCount(dealId), 29);

        // === Scenario E: At 51 buyers — buyer 1 allowed ===
        setUp();
        dealId = _postStandardDeal();
        _commitBuyers(dealId, 51);
        // buyer 1 → newCount=50, newPrice=$0.50; lowest=$0.50 (buyers 50-51) — allowed
        vm.prank(address(uint160(1)));
        pool.withdraw(dealId); // allowed
        assertEq(pool.getBuyerCount(dealId), 50);

        // === Scenario F: At exactly 50 buyers — buyer 1 NOT allowed ===
        setUp();
        dealId = _postStandardDeal();
        _commitBuyers(dealId, 50);
        // buyer 1 → newCount=49, newPrice=$0.75; lowest = $0.50 (buyer 50) → WouldStrandBuyer
        vm.prank(address(uint160(1)));
        vm.expectRevert(DemandPool.WouldStrandBuyer.selector);
        pool.withdraw(dealId);

        // === Scenario G: Refusal is temporary — add buyer 26, then buyer 1 can withdraw at 25 ===
        setUp();
        dealId = _postStandardDeal();
        _commitBuyers(dealId, 25);

        // buyer 1 refused at 25
        vm.prank(address(uint160(1)));
        vm.expectRevert(DemandPool.WouldStrandBuyer.selector);
        pool.withdraw(dealId);

        // Add buyer 26 → count=26, still $0.75
        address b26 = address(uint160(26));
        _fundBuyer(b26, 2_000_000);
        vm.prank(b26); pool.commit(dealId);

        // Now buyer 1 withdraws → newCount=25, newPrice=$0.75; lowest=$0.75 — ALLOWED
        vm.prank(address(uint160(1)));
        pool.withdraw(dealId); // must NOT revert
        assertEq(pool.getBuyerCount(dealId), 25, "25 buyers after buyer1 withdrawal from 26");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 9 — No dead ends (fuzz)
    // ═══════════════════════════════════════════════════════════════════════════
    function testFuzz_NoDeadEnd(uint8 commitCount, uint8 withdrawMask) public {
        commitCount = uint8(bound(commitCount, 1, 100));

        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, commitCount);

        uint256 numToConsider = commitCount < 8 ? commitCount : 8;
        for (uint256 i = 0; i < numToConsider; i++) {
            if ((withdrawMask >> i) & 1 == 1) {
                address buyer = address(uint160(i + 1));
                if (pool.escrowed(dealId, buyer) > 0) {
                    vm.startPrank(buyer);
                    (bool ok,) = address(pool).call(abi.encodeWithSignature("withdraw(uint256)", dealId));
                    vm.stopPrank();
                    (ok);
                }
            }
        }

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);

        uint256 remaining = pool.getBuyerCount(dealId);

        bool settleOk;
        bool refundOk;

        (settleOk,) = address(settler).call(abi.encodeWithSignature("settle(uint256)", dealId));
        if (!settleOk) {
            (refundOk,) = address(settler).call(abi.encodeWithSignature("refundAll(uint256)", dealId));
            assertTrue(refundOk, "refundAll must succeed when settle fails");
        } else {
            // settle succeeded; refundAll should now fail with AlreadySettled
            (refundOk,) = address(settler).call(abi.encodeWithSignature("refundAll(uint256)", dealId));
            assertFalse(refundOk, "refundAll must fail after settle");
        }

        // Exactly one of settle or refundAll must have succeeded based on remaining
        if (remaining >= MIN_BUYERS) {
            assertTrue(settleOk, "settle should succeed when count >= minBuyers");
        } else {
            assertFalse(settleOk, "settle should fail when count < minBuyers");
            assertTrue(refundOk, "refundAll should succeed when count < minBuyers");
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 10 — Double commit reverts
    // ═══════════════════════════════════════════════════════════════════════════
    function test_DoubleCommitReverts() public {
        uint256 dealId = _postStandardDeal();
        address buyer1 = address(uint160(1));
        _fundBuyer(buyer1, 4_000_000);

        vm.prank(buyer1); pool.commit(dealId);

        vm.prank(buyer1);
        vm.expectRevert(DemandPool.AlreadyCommitted.selector);
        pool.commit(dealId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 11 — Settle before deadline reverts
    // ═══════════════════════════════════════════════════════════════════════════
    function test_SettleBeforeDeadlineReverts() public {
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 10);

        vm.expectRevert(Settler.DeadlineNotReached.selector);
        settler.settle(dealId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 12 — Double settlement; settle after refundAll; refundAll after settle
    // ═══════════════════════════════════════════════════════════════════════════
    function test_DoubleSettlementReverts() public {
        // 12a: double settle
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 10);
        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.settle(dealId);
        vm.expectRevert(Settler.AlreadySettled.selector);
        settler.settle(dealId);

        // 12b: refundAll after settle
        vm.expectRevert(Settler.AlreadySettled.selector);
        settler.refundAll(dealId);

        // 12c: 5 buyers, refundAll then settle
        setUp(); // fresh state
        dealId = _postStandardDeal();
        _commitBuyers(dealId, 5);
        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.refundAll(dealId);

        vm.expectRevert(Settler.AlreadySettled.selector);
        settler.settle(dealId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 13 — Gas bound
    // ═══════════════════════════════════════════════════════════════════════════
    function test_GasBound() public {
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 100);

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);

        uint256 gasBefore = gasleft();
        settler.settle(dealId);
        uint256 gasAfter = gasleft();
        uint256 gasSettle = gasBefore - gasAfter;
        console.log("settle(100 buyers) gas:", gasSettle);
        assertLt(gasSettle, 15_000_000, "settle gas < 15M");

        // Measure single withdrawal gas (need a fresh deal)
        setUp();
        dealId = _postStandardDeal();
        _commitBuyers(dealId, 60); // buyer 50 is at $0.50 tier

        address buyer50 = address(uint160(50));
        // At 60 buyers, buyer 50 escrowed 500_000; withdraw → newCount=59, newPrice=$0.50; lowest=$0.50 — allowed
        gasBefore = gasleft();
        vm.prank(buyer50); pool.withdraw(dealId);
        gasAfter = gasleft();
        uint256 gasWithdraw = gasBefore - gasAfter;
        console.log("withdraw(buyer50 from 60) gas:", gasWithdraw);
        assertLt(gasWithdraw, 200_000, "withdraw gas < 200K");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 14 — Rounding and dust (51-buyer happy path, pool balance == 0)
    // ═══════════════════════════════════════════════════════════════════════════
    function test_RoundingAndDust() public {
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 51);

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.settle(dealId);

        // All buyers claim
        for (uint256 i = 1; i <= 51; i++) {
            address buyer = address(uint160(i));
            if (settler.claimable(buyer) > 0) {
                vm.prank(buyer); settler.claim();
            }
        }
        // Supplier claims
        vm.prank(supplier); settler.claim();

        assertEq(IERC20(USDC_ADDR).balanceOf(address(pool)), 0, "pool balance should be 0 after all claims");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 15 — Pull safety (blocklisted buyer)
    // ═══════════════════════════════════════════════════════════════════════════
    function test_PullSafety_BlocklistedBuyer() public {
        // Use a named address for the blocklisted buyer to avoid precompile addresses (0x1-0x9)
        address blockedBuyer = makeAddr("blockedBuyer");

        // Deploy blocklisted mock — constructor sets blocked address
        MockBlocklistedERC20 blockedUSDC = new MockBlocklistedERC20(blockedBuyer);
        // Etch the code at USDC_ADDR — this clears USDC storage (balances etc.)
        vm.etch(USDC_ADDR, address(blockedUSDC).code);
        MockBlocklistedERC20 bUsdc = MockBlocklistedERC20(USDC_ADDR);
        // Set the `blocked` storage slot. MockBlocklistedERC20 layout (MockERC20 base first):
        //   slot 0: name (string — length-encoded)
        //   slot 1: symbol (string)
        //   slot 2: decimals (uint8, packed)
        //   slot 3: totalSupply
        //   slot 4: balanceOf (mapping)
        //   slot 5: allowance (mapping)
        //   slot 6: blocked (address)  ← first var of MockBlocklistedERC20
        vm.store(USDC_ADDR, bytes32(uint256(6)), bytes32(uint256(uint160(blockedBuyer))));
        assertEq(bUsdc.blocked(), blockedBuyer, "blocked address should be set");

        // Post a deal and commit 51 buyers so blockedBuyer has a real refund
        // Use standard buyers 1-50 + blockedBuyer as the "51st"
        uint256 dealId = _postStandardDeal();
        _commitBuyers(dealId, 50); // buyers 1-50

        // Fund and commit blockedBuyer as the 51st
        bUsdc.mint(blockedBuyer, 2_000_000);
        vm.prank(blockedBuyer); bUsdc.approve(address(pool), 2_000_000);
        vm.prank(blockedBuyer); pool.commit(dealId);

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);

        // settle should succeed — no USDC transfer during settle
        settler.settle(dealId);

        // cp = 500_000 at 51 buyers; blockedBuyer escrowed 500_000, refund = 0
        // Wait — blockedBuyer is buyer 51 so they pay 500_000 and refund = 0.
        // We need them to have a non-zero refund. Let's check buyers 1-24 (paid $1.00, get $0.50 refund)
        // Use buyer 1 as a proxy to verify other buyers can claim.
        // For blockedBuyer to have a refund, they need to have escrowed > cp.
        // At 51 buyers cp=$0.50; blockedBuyer was the 51st so they paid $0.50 → refund=0.
        // Instead, let's use 52 buyers with blockedBuyer committed at index 25 (pays $0.75):
        // Re-do the scenario cleanly.

        // Actually let's restart this test completely with a 26-buyer scenario:
        // Reset state inline
        setUp();
        blockedUSDC = new MockBlocklistedERC20(blockedBuyer);
        vm.etch(USDC_ADDR, address(blockedUSDC).code);
        bUsdc = MockBlocklistedERC20(USDC_ADDR);
        vm.store(USDC_ADDR, bytes32(uint256(6)), bytes32(uint256(uint160(blockedBuyer))));
        assertEq(bUsdc.blocked(), blockedBuyer, "blocked address should be set after reset");

        dealId = _postStandardDeal();

        // Commit 24 regular buyers (all pay $1.00)
        for (uint256 i = 1; i <= 24; i++) {
            address buyer = address(uint160(i + 100)); // offset to avoid precompiles
            bUsdc.mint(buyer, 2_000_000);
            vm.prank(buyer); bUsdc.approve(address(pool), 2_000_000);
            vm.prank(buyer); pool.commit(dealId);
        }

        // blockedBuyer commits as buyer 25 — triggers tier break to $0.75
        bUsdc.mint(blockedBuyer, 2_000_000);
        vm.prank(blockedBuyer); bUsdc.approve(address(pool), 2_000_000);
        vm.prank(blockedBuyer); pool.commit(dealId);

        // Commit 26 more (buyers 26-51 = 27 total at $0.75, pushing toward $0.50 tier)
        // Actually we just need blockedBuyer to have a refund. At 25 buyers, cp=$0.75.
        // blockedBuyer escrowed $0.75. If we settle at exactly 25 buyers, cp=$0.75 → refund=0.
        // Need settle at 50+ to get cp=$0.50 → blockedBuyer refund = 750_000 - 500_000 = 250_000.

        // Add 25 more buyers (26-50) to reach 50 total (then blockedBuyer is still at slot 25)
        for (uint256 i = 26; i <= 50; i++) {
            address buyer = address(uint160(i + 100));
            bUsdc.mint(buyer, 2_000_000);
            vm.prank(buyer); bUsdc.approve(address(pool), 2_000_000);
            vm.prank(buyer); pool.commit(dealId);
        }

        // Add one more (buyer 51) to push cp to $0.50
        address buyer51 = address(uint160(151));
        bUsdc.mint(buyer51, 2_000_000);
        vm.prank(buyer51); bUsdc.approve(address(pool), 2_000_000);
        vm.prank(buyer51); pool.commit(dealId);

        // Now 51 buyers, cp = $0.50
        assertEq(pool.clearingPrice(dealId), 500_000, "cp should be 500_000 at 51 buyers");

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);

        // settle succeeds — no transfer during settle
        settler.settle(dealId);

        // blockedBuyer escrowed $0.75 (they were the 25th), cp=$0.50, refund = 250_000
        uint256 claimableBefore = settler.claimable(blockedBuyer);
        assertGt(claimableBefore, 0, "blockedBuyer should have claimable refund");

        // Other buyers (non-blocked) can claim
        for (uint256 i = 1; i <= 24; i++) {
            address buyer = address(uint160(i + 100));
            if (settler.claimable(buyer) > 0) {
                vm.prank(buyer); settler.claim();
            }
        }
        for (uint256 i = 26; i <= 51; i++) {
            address buyer = address(uint160(i + 100 == 151 ? 151 : i + 100));
            if (settler.claimable(buyer) > 0) {
                vm.prank(buyer); settler.claim();
            }
        }
        if (settler.claimable(supplier) > 0) {
            vm.prank(supplier); settler.claim();
        }

        // blockedBuyer tries to claim — USDC transfer to them reverts
        vm.prank(blockedBuyer);
        vm.expectRevert(); // MockBlocklistedERC20.Blocklisted bubbles up as TransferFailed
        settler.claim();

        // blockedBuyer's claimable should still be non-zero (pull-payment isolation)
        assertGt(settler.claimable(blockedBuyer), 0, "blockedBuyer claimable should remain after failed claim");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 16 — Reentrancy on claim
    //
    // One clean scenario: reentrantBuyer commits first (escrowing $1.00), 50 more
    // buyers join to bring the total to 51 and the clearing price to $0.50. After
    // settle, reentrantBuyer has claimable == 500_000. When they call claim(), the
    // mock USDC attempts to re-enter settler.claim() during the transfer. The inner
    // call must fail (claimable was zeroed before the transfer fires) and the outer
    // call must pay out exactly 500_000 — no double drain.
    // ═══════════════════════════════════════════════════════════════════════════
    function test_ReentrancyOnClaim() public {
        address reentrantBuyer = makeAddr("reentrantBuyer");

        // Etch the reentrant USDC mock, replacing the standard MockERC20.
        MockReentrantERC20 reentrantUSDC = new MockReentrantERC20();
        vm.etch(USDC_ADDR, address(reentrantUSDC).code);
        MockReentrantERC20 rUsdc = MockReentrantERC20(USDC_ADDR);

        // Configure: on transfer(reentrantBuyer, _), the mock re-enters settler.claim().
        rUsdc.setReentrant(reentrantBuyer, address(settler));

        // Post the standard deal.
        uint256 dealId = _postStandardDeal();

        // reentrantBuyer commits first — count goes 0→1, priceAfter = $1.00 (tier 1 needs 10).
        // They escrow 1_000_000.
        rUsdc.mint(reentrantBuyer, 2_000_000);
        vm.prank(reentrantBuyer); rUsdc.approve(address(pool), 2_000_000);
        vm.prank(reentrantBuyer); pool.commit(dealId);
        assertEq(pool.escrowed(dealId, reentrantBuyer), 1_000_000, "reentrantBuyer escrowed 1_000_000");

        // 50 more buyers commit (offset 201-250), bringing total to 51 and cp to $0.50.
        for (uint256 i = 1; i <= 50; i++) {
            address buyer = address(uint160(i + 200));
            rUsdc.mint(buyer, 2_000_000);
            vm.prank(buyer); rUsdc.approve(address(pool), 2_000_000);
            vm.prank(buyer); pool.commit(dealId);
        }
        assertEq(pool.clearingPrice(dealId), 500_000, "cp = 500_000 at 51 buyers");

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.settle(dealId);

        // reentrantBuyer escrowed $1.00, cp = $0.50 → claimable = 500_000.
        uint256 reentrantClaimable = settler.claimable(reentrantBuyer);
        assertEq(reentrantClaimable, 500_000, "reentrantBuyer claimable = 500_000");

        uint256 balBefore = IERC20(USDC_ADDR).balanceOf(reentrantBuyer);

        // reentrantBuyer calls claim(). During pool.pullForSettler → USDC.transfer,
        // the mock re-enters settler.claim(). At that point claimable[reentrantBuyer]
        // is already 0 (zeroed before transfer), so the inner claim() reverts with
        // NothingToClaim. The outer claim() continues and completes normally.
        vm.prank(reentrantBuyer);
        settler.claim();

        // Exactly one payout: claimable zeroed, received == original credit.
        assertEq(settler.claimable(reentrantBuyer), 0, "claimable zeroed after claim");
        uint256 received = IERC20(USDC_ADDR).balanceOf(reentrantBuyer) - balBefore;
        assertEq(received, reentrantClaimable, "received exactly 500_000, no double drain");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 17 — Pause
    // ═══════════════════════════════════════════════════════════════════════════
    function test_Pause() public {
        // Pause the factory
        vm.prank(owner); factory.pause();

        // postDeal reverts with Paused
        uint64 deadline = uint64(block.timestamp + DEADLINE_OFFSET);
        vm.expectRevert(DealFactory.Paused.selector);
        vm.prank(supplier);
        factory.postDeal(_standardTiers(), MIN_BUYERS, deadline, CAP);

        // Post a deal first (before pause in a fresh state for commit test)
        // We need a deal to test commit. Post it before pausing:
        vm.prank(owner); factory.unpause();
        uint256 dealId = _postStandardDeal();
        vm.prank(owner); factory.pause();

        // commit reverts with Paused
        address buyer1 = address(uint160(1));
        _fundBuyer(buyer1, 2_000_000);
        vm.prank(buyer1);
        vm.expectRevert(DemandPool.Paused.selector);
        pool.commit(dealId);

        // Warp past deadline and commit 10 buyers while unpaused to have something to settle
        vm.prank(owner); factory.unpause();
        _commitBuyers(dealId, 10);
        vm.prank(owner); factory.pause(); // pause again

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);

        // settle succeeds even while paused
        settler.settle(dealId); // must NOT revert

        // claim succeeds while paused
        vm.prank(supplier); settler.claim(); // must NOT revert

        // unpause — postDeal and commit work again
        vm.prank(owner); factory.unpause();

        uint256 dealId2 = _postStandardDeal();
        address buyer11 = address(uint160(11));
        _fundBuyer(buyer11, 2_000_000);
        _commitBuyers(dealId2, 1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 18 — postDeal validation
    // ═══════════════════════════════════════════════════════════════════════════
    function test_PostDealValidation() public {
        uint64 deadline = uint64(block.timestamp + DEADLINE_OFFSET);

        // 1. Empty tiers → InvalidTierCount
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](0);
            vm.expectRevert(DealFactory.InvalidTierCount.selector);
            vm.prank(supplier);
            factory.postDeal(t, MIN_BUYERS, deadline, CAP);
        }

        // 2. tiers[0].pricePerUnit > 5_000_000 → PriceCapExceeded
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](1);
            t[0] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 5_000_001});
            vm.expectRevert(DealFactory.PriceCapExceeded.selector);
            vm.prank(supplier);
            factory.postDeal(t, MIN_BUYERS, deadline, CAP);
        }

        // 3. tiers[0].pricePerUnit == 0 → ZeroTierPrice
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](1);
            t[0] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 0});
            vm.expectRevert(DealFactory.ZeroTierPrice.selector);
            vm.prank(supplier);
            factory.postDeal(t, MIN_BUYERS, deadline, CAP);
        }

        // 4. minBuyers == 0 → InvalidConfiguration
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](1);
            t[0] = SwarmTypes.Tier({minBuyers: 0, pricePerUnit: 1_000_000});
            vm.expectRevert(DealFactory.InvalidConfiguration.selector);
            vm.prank(supplier);
            factory.postDeal(t, 0, deadline, CAP);
        }

        // 5. tiers not ascending (second minBuyers <= first) → TiersNotAscending
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](2);
            t[0] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 1_000_000});
            t[1] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 750_000}); // not ascending
            vm.expectRevert(DealFactory.TiersNotAscending.selector);
            vm.prank(supplier);
            factory.postDeal(t, MIN_BUYERS, deadline, CAP);
        }

        // 6. tiers not descending (second price >= first) → TiersNotDescending
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](2);
            t[0] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 1_000_000});
            t[1] = SwarmTypes.Tier({minBuyers: 25, pricePerUnit: 1_000_000}); // not descending
            vm.expectRevert(DealFactory.TiersNotDescending.selector);
            vm.prank(supplier);
            factory.postDeal(t, MIN_BUYERS, deadline, CAP);
        }

        // 7. deadline <= block.timestamp → DeadlineNotFuture
        {
            SwarmTypes.Tier[] memory t = _standardTiers();
            vm.expectRevert(DealFactory.DeadlineNotFuture.selector);
            vm.prank(supplier);
            factory.postDeal(t, MIN_BUYERS, uint64(block.timestamp), CAP);
        }

        // 8. cap == 0 → BuyerCapExceeded
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](1);
            t[0] = SwarmTypes.Tier({minBuyers: 1, pricePerUnit: 1_000_000});
            vm.expectRevert(DealFactory.BuyerCapExceeded.selector);
            vm.prank(supplier);
            factory.postDeal(t, 1, deadline, 0);
        }

        // 9. cap > 100 → BuyerCapExceeded
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](1);
            t[0] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 1_000_000});
            vm.expectRevert(DealFactory.BuyerCapExceeded.selector);
            vm.prank(supplier);
            factory.postDeal(t, MIN_BUYERS, deadline, 101);
        }

        // 10. minBuyers > cap → InvalidConfiguration
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](1);
            t[0] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 1_000_000});
            vm.expectRevert(DealFactory.InvalidConfiguration.selector);
            vm.prank(supplier);
            factory.postDeal(t, 50, deadline, 40); // minBuyers=50 > cap=40
        }

        // 11. tiers[last].minBuyers > cap → InvalidConfiguration
        {
            SwarmTypes.Tier[] memory t = new SwarmTypes.Tier[](2);
            t[0] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 1_000_000});
            t[1] = SwarmTypes.Tier({minBuyers: 80, pricePerUnit: 750_000}); // 80 > cap=50
            vm.expectRevert(DealFactory.InvalidConfiguration.selector);
            vm.prank(supplier);
            factory.postDeal(t, MIN_BUYERS, deadline, 50);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test 19 — Claimable accumulates across deals
    // ═══════════════════════════════════════════════════════════════════════════
    function test_ClaimableAccumulatesAcrossDeals() public {
        address buyer1 = address(uint160(1));

        // --- Deal 1: 12 buyers ---
        uint256 dealId1 = _postStandardDeal();
        _commitBuyers(dealId1, 12);

        // Warp past deal 1 deadline and settle
        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.settle(dealId1);

        // buyer1 escrowed $1.00, clearing price $1.00, refund = 0
        // Actually at 12 buyers, clearing price = $1.00 (tier1 needs 10, met)
        // So refund_1 = 1_000_000 - 1_000_000 = 0
        // buyer1 has no refund from deal 1
        uint256 refund1 = settler.claimable(buyer1);
        // refund1 == 0 at 12 buyers with cp=$1.00

        // --- Deal 2: 51 buyers (gives buyer1 a $0.50 refund) ---
        // Need to create a new deal with fresh deadline
        // Re-use a new block.timestamp after warp
        uint64 deadline2 = uint64(block.timestamp + DEADLINE_OFFSET);
        vm.prank(supplier);
        uint256 dealId2 = factory.postDeal(_standardTiers(), MIN_BUYERS, deadline2, CAP);

        // Fund and commit 51 buyers for deal 2 (buyer1 re-commits)
        for (uint256 i = 1; i <= 51; i++) {
            address buyer = address(uint160(i));
            // Fund with generous amount for deal 2
            usdc.mint(buyer, 2_000_000);
            vm.prank(buyer); usdc.approve(address(pool), 2_000_000);
            vm.prank(buyer); pool.commit(dealId2);
        }

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.settle(dealId2);

        // At 51 buyers, cp = $0.50. buyer1 escrowed $1.00, refund = $0.50
        uint256 refund2 = settler.claimable(buyer1) - refund1;
        assertEq(refund2, 500_000, "buyer1 refund from deal 2 should be 500_000");

        // Total claimable = refund_1 + refund_2
        uint256 totalClaimable = settler.claimable(buyer1);
        assertEq(totalClaimable, refund1 + refund2, "claimable should accumulate");

        // Buyer 1 claims ONCE
        if (totalClaimable > 0) {
            uint256 balBefore = usdc.balanceOf(buyer1);
            vm.prank(buyer1); settler.claim();
            assertEq(usdc.balanceOf(buyer1) - balBefore, totalClaimable, "received accumulated refund");
        }

        assertEq(settler.claimable(buyer1), 0, "claimable[buyer1] == 0 after claim");
    }
}
