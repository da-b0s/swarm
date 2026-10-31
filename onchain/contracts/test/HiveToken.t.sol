// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HiveToken} from "../HiveToken.sol";
import {DealFactory} from "../DealFactory.sol";
import {DemandPool} from "../DemandPool.sol";
import {Settler} from "../Settler.sol";
import {SwarmTypes} from "../SwarmTypes.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/**
 * @notice HiveToken unit tests + Swarm v2 round-trip integration test.
 *
 * Unit tests cover:
 *   - Correct name, symbol, decimals and total supply.
 *   - Entire supply lands on recipient at construction.
 *   - Zero-address recipient reverts with ZeroAddressRecipient.
 *   - Transfer moves exact amount (no hidden fee).
 *   - No mint path after deployment (totalSupply unchanged after transfers).
 *
 * Integration test (Swarm round trip):
 *   - Supplier posts a deal in DealFactory selling HIVE,
 *     tokensPerUnit = 1e18 (one whole HIVE per unit).
 *   - Tiers: >=1 unit → $2.00/unit, >=5 units → $1.50/unit.
 *   - One buyer commits 5 units, crosses the $1.50 tier.
 *   - Settler settles after the deadline.
 *   - Buyer ends with exactly 5 HIVE (5 × 1e18 base units).
 *   - Supplier ends with exactly 5 × $1.50 = $7.50 USDC (7_500_000 micro-USDC).
 */
contract HiveTokenTest is Test {

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 constant TOTAL_SUPPLY  = 1_000_000 * 10 ** 18;
    uint256 constant TOKENS_PER_UNIT = 1e18;   // 1 whole HIVE per unit

    address constant USDC_ADDR = 0x3600000000000000000000000000000000000000;

    // ── Actors ────────────────────────────────────────────────────────────────

    address owner    = address(0x1000);
    address supplier = address(0x2000);
    address buyer    = address(0x3001);
    address alice    = address(0x4001);
    address bob      = address(0x4002);

    // ── Contracts ─────────────────────────────────────────────────────────────

    HiveToken  hive;
    MockERC20  usdc;
    DealFactory factory;
    DemandPool  pool;
    Settler     settler;

    // ─────────────────────────────────────────────────────────────────────────
    // Unit tests
    // ─────────────────────────────────────────────────────────────────────────

    function test_Metadata() public {
        hive = new HiveToken(alice);
        assertEq(hive.name(),     "Hive",  "name");
        assertEq(hive.symbol(),   "HIVE",  "symbol");
        assertEq(hive.decimals(), 18,       "decimals");
    }

    function test_TotalSupply() public {
        hive = new HiveToken(alice);
        assertEq(hive.totalSupply(), TOTAL_SUPPLY, "total supply");
    }

    function test_EntireSupplyToRecipient() public {
        hive = new HiveToken(alice);
        assertEq(hive.balanceOf(alice), TOTAL_SUPPLY, "recipient holds all supply");
        assertEq(hive.balanceOf(bob),   0,             "non-recipient has nothing");
    }

    function test_ZeroAddressRecipientReverts() public {
        vm.expectRevert(HiveToken.ZeroAddressRecipient.selector);
        new HiveToken(address(0));
    }

    function test_TransferExactAmount_NoFee() public {
        hive = new HiveToken(alice);
        uint256 amount = 100 * 10 ** 18;

        vm.prank(alice);
        hive.transfer(bob, amount);

        assertEq(hive.balanceOf(alice), TOTAL_SUPPLY - amount, "alice after transfer");
        assertEq(hive.balanceOf(bob),   amount,                 "bob after transfer");
    }

    function test_TotalSupplyUnchangedAfterTransfers() public {
        hive = new HiveToken(alice);
        uint256 amount = 250_000 * 10 ** 18;

        vm.prank(alice);
        hive.transfer(bob, amount);

        // totalSupply must be exactly TOTAL_SUPPLY — no mint, no burn
        assertEq(hive.totalSupply(), TOTAL_SUPPLY, "supply unchanged");
    }

    function test_NoMintAfterDeployment() public {
        hive = new HiveToken(alice);
        // HiveToken exposes no mint function — this would be a compile error
        // if called. We verify by checking totalSupply is immutably fixed
        // across multiple operations.
        vm.prank(alice); hive.transfer(bob, 1e18);
        vm.prank(bob);   hive.transfer(alice, 1e18);
        assertEq(hive.totalSupply(), TOTAL_SUPPLY, "supply fixed after transfers");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Swarm round-trip integration test
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Deploy and wire the full Swarm v2 stack with mock USDC + HiveToken.
    function _setUpSwarm() internal {
        // Deploy mock USDC at the canonical Arc address
        MockERC20 usdcImpl = new MockERC20("USD Coin", "USDC", 6);
        vm.etch(USDC_ADDR, address(usdcImpl).code);
        usdc = MockERC20(USDC_ADDR);

        // Deploy Swarm contracts
        vm.startPrank(owner);
        factory = new DealFactory(owner);
        pool    = new DemandPool(address(factory), owner);
        settler = new Settler(address(factory), address(pool), owner);

        factory.setDemandPool(address(pool));
        factory.setSettler(address(settler));
        pool.setSettler(address(settler));
        vm.stopPrank();

        // Mint HiveToken supply to supplier (whole supply — they will deposit
        // only the deal stock into the factory)
        hive = new HiveToken(supplier);

        // Fund buyer with USDC (100 USDC — more than enough)
        usdc.mint(buyer, 100_000_000);
        vm.prank(buyer);
        usdc.approve(address(pool), type(uint256).max);

        // Supplier approves factory to pull HIVE for deal stock
        vm.prank(supplier);
        hive.approve(address(factory), type(uint256).max);
    }

    function test_SwarmRoundTrip() public {
        _setUpSwarm();

        // ── Post deal ─────────────────────────────────────────────────────────
        //
        // Stock: 10 units × 1e18 HIVE per unit = 10 HIVE tokens.
        // Tiers:
        //   Tier 0: minUnits=1, pricePerUnit=$2.00 (2_000_000 micro-USDC)
        //   Tier 1: minUnits=5, pricePerUnit=$1.50 (1_500_000 micro-USDC)
        //
        // Buyer commits 5 units:
        //   priceAt(0+5=5) → tier[1] minUnits=5<=5 → $1.50.
        //   Escrow = 5 × $1.50 = $7.50 (7_500_000 micro-USDC).
        //
        // Settlement:
        //   clearingPrice = $1.50
        //   Supplier USDC  = $1.50 × 5 = $7.50
        //   Buyer HIVE     = 5 × 1e18

        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 1, pricePerUnit: 2_000_000}); // $2.00
        tiers[1] = SwarmTypes.Tier({minUnits: 5, pricePerUnit: 1_500_000}); // $1.50

        uint64 deadline = uint64(block.timestamp + 1 days);

        vm.prank(supplier);
        uint256 dealId = factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(hive),
                tokensPerUnit:    TOKENS_PER_UNIT,
                minUnits:         1,
                maxUnits:         10,
                maxUnitsPerBuyer: 0,
                maxBuyers:        10,
                deadline:         deadline,
                title:            "Hive Token Launch",
                description:      "Buy HIVE at a group discount."
            }),
            tiers
        );

        // Factory holds the deposited stock: 10 × 1e18 HIVE
        assertEq(hive.balanceOf(address(factory)), 10 * TOKENS_PER_UNIT, "factory holds stock");
        assertEq(hive.balanceOf(supplier), TOTAL_SUPPLY - 10 * TOKENS_PER_UNIT, "supplier balance reduced");

        // ── Buyer commits 5 units ─────────────────────────────────────────────

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);

        vm.prank(buyer);
        pool.commit(dealId, 5);

        assertEq(pool.totalUnits(dealId),       5,         "5 units committed");
        assertEq(pool.paidPerUnit(dealId, buyer), 1_500_000, "paid $1.50/unit");
        assertEq(pool.escrowed(dealId, buyer),   7_500_000, "escrowed $7.50");
        assertEq(
            usdc.balanceOf(buyer),
            buyerUsdcBefore - 7_500_000,
            "buyer USDC reduced by escrow"
        );

        // ── Settle ────────────────────────────────────────────────────────────

        vm.warp(deadline + 1);
        settler.settle(dealId);

        assertEq(factory.getDeal(dealId).state, 1, "deal settled");

        // After settlement the settler holds all HIVE (pulled from factory)
        assertEq(hive.balanceOf(address(settler)), 10 * TOKENS_PER_UNIT, "settler holds HIVE");
        assertEq(hive.balanceOf(address(factory)), 0, "factory released HIVE");

        // ── USDC claimable ────────────────────────────────────────────────────

        // Clearing price = $1.50 (tier 1 applied). Buyer paid exactly $1.50/unit — no refund.
        assertEq(settler.claimable(buyer),    0,          "buyer: no USDC refund");
        assertEq(settler.claimable(supplier), 7_500_000,  "supplier: $7.50 USDC");

        // ── Goods claimable ───────────────────────────────────────────────────

        // Buyer bought 5 units → 5 × 1e18 HIVE
        assertEq(
            settler.goodsClaimable(address(hive), buyer),
            5 * TOKENS_PER_UNIT,
            "buyer: 5 HIVE claimable"
        );
        // Supplier unsold stock: (10 - 5) units × 1e18 = 5 HIVE
        assertEq(
            settler.goodsClaimable(address(hive), supplier),
            5 * TOKENS_PER_UNIT,
            "supplier: 5 HIVE unsold stock"
        );

        // ── Claim ─────────────────────────────────────────────────────────────

        vm.prank(supplier);
        settler.claim();
        assertEq(usdc.balanceOf(supplier), 7_500_000, "supplier receives $7.50 USDC");

        vm.prank(buyer);
        settler.claimGoods(address(hive));
        assertEq(hive.balanceOf(buyer), 5 * TOKENS_PER_UNIT, "buyer receives exactly 5 HIVE");

        vm.prank(supplier);
        settler.claimGoods(address(hive));
        assertEq(
            hive.balanceOf(supplier),
            TOTAL_SUPPLY - 10 * TOKENS_PER_UNIT + 5 * TOKENS_PER_UNIT,
            "supplier recovers 5 unsold HIVE"
        );

        // Settler drained
        assertEq(hive.balanceOf(address(settler)), 0, "settler empty");
        assertEq(usdc.balanceOf(address(pool)),    0, "pool empty");

        // Total supply still fixed
        assertEq(hive.totalSupply(), TOTAL_SUPPLY, "total supply invariant");
    }
}
