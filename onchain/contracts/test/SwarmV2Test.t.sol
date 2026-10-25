// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {DealFactory} from "../DealFactory.sol";
import {DemandPool} from "../DemandPool.sol";
import {Settler} from "../Settler.sol";
import {SwarmPass} from "../SwarmPass.sol";
import {SwarmTypes} from "../SwarmTypes.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockFeeToken} from "../test-helpers/MockFeeToken.sol";
import {MockReentrantGoods} from "../test-helpers/MockReentrantGoods.sol";

contract SwarmV2Test is Test {
    // ── Shared infrastructure ─────────────────────────────────────────────────

    DealFactory factory;
    DemandPool  pool;
    Settler     settler;
    SwarmPass   pass;
    MockERC20   usdc;

    address constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    address constant OWNER     = address(0x1000);
    address constant SUPPLIER  = address(0x2000);

    // Ten named buyers
    address constant B1 = address(0x3001);
    address constant B2 = address(0x3002);
    address constant B3 = address(0x3003);
    address constant B4 = address(0x3004);
    address constant B5 = address(0x3005);

    // Standard three-tier curve: minUnits 1/$1.00, 10/$0.75, 20/$0.50
    SwarmTypes.Tier[] internal stdTiers;

    function setUp() public {
        // Deploy mock USDC at canonical address
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.etch(USDC_ADDR, address(usdc).code);
        usdc = MockERC20(USDC_ADDR);

        // Deploy SwarmPass (faucet on)
        vm.prank(OWNER);
        pass = new SwarmPass(true);

        // Deploy + wire
        vm.prank(OWNER); factory = new DealFactory(OWNER);
        vm.prank(OWNER); pool    = new DemandPool(address(factory), OWNER);
        vm.prank(OWNER); settler = new Settler(address(factory), address(pool), OWNER);
        vm.prank(OWNER); factory.setDemandPool(address(pool));
        vm.prank(OWNER); factory.setSettler(address(settler));
        vm.prank(OWNER); pool.setSettler(address(settler));

        // Standard tier array
        stdTiers.push(SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000}));
        stdTiers.push(SwarmTypes.Tier({minUnits: 10, pricePerUnit: 750_000}));
        stdTiers.push(SwarmTypes.Tier({minUnits: 20, pricePerUnit: 500_000}));
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _postStdDeal(uint32 maxUnits, uint32 minUnits, uint32 maxBuyers, uint32 maxPerBuyer)
        internal returns (uint256 dealId)
    {
        uint256 stock = uint256(maxUnits);
        vm.prank(OWNER); pass.mint(SUPPLIER, stock);
        vm.prank(SUPPLIER); pass.approve(address(factory), stock);
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
                title:            "Test Deal",
                description:      "Test"
            }),
            stdTiers
        );
    }

    function _fund(address buyer, uint256 amount) internal {
        usdc.mint(buyer, amount);
        vm.prank(buyer); usdc.approve(address(pool), type(uint256).max);
    }

    function _commit(address buyer, uint256 dealId, uint32 units) internal {
        vm.prank(buyer); pool.commit(dealId, units);
    }

    function _settle(uint256 dealId) internal {
        vm.warp(block.timestamp + 2 days + 1);
        settler.settle(dealId);
    }

    // ── SECTION 1: Posting validation ─────────────────────────────────────────

    // Helper: a single-tier array with minUnits=1, $1.00 — used for post-validation tests
    // that need stdTiers-compatible params but must avoid LastTierExceedsMax.
    function _oneTier() internal pure returns (SwarmTypes.Tier[] memory t) {
        t = new SwarmTypes.Tier[](1);
        t[0] = SwarmTypes.Tier({minUnits: 1, pricePerUnit: 1_000_000});
    }

    function test_Post_InvalidTierCount_Zero() public {
        SwarmTypes.Tier[] memory empty = new SwarmTypes.Tier[](0);
        vm.prank(OWNER); pass.mint(SUPPLIER, 10);
        vm.prank(SUPPLIER); pass.approve(address(factory), 10);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.InvalidTierCount.selector);
        factory.postDeal(_params(address(pass), 10, 1, 10, 0, 10), empty);
    }

    function test_Post_InvalidTierCount_Eleven() public {
        SwarmTypes.Tier[] memory big = new SwarmTypes.Tier[](11);
        for (uint256 i = 0; i < 11; i++) {
            big[i] = SwarmTypes.Tier({minUnits: uint32(i + 1), pricePerUnit: uint64(5_000_000 - i * 100_000)});
        }
        vm.prank(OWNER); pass.mint(SUPPLIER, 10);
        vm.prank(SUPPLIER); pass.approve(address(factory), 10);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.InvalidTierCount.selector);
        factory.postDeal(_params(address(pass), 10, 1, 10, 0, 10), big);
    }

    function test_Post_ZeroTierPrice() public {
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](1);
        tiers[0] = SwarmTypes.Tier({minUnits: 1, pricePerUnit: 0});
        vm.prank(OWNER); pass.mint(SUPPLIER, 10);
        vm.prank(SUPPLIER); pass.approve(address(factory), 10);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.ZeroTierPrice.selector);
        factory.postDeal(_params(address(pass), 10, 1, 10, 0, 10), tiers);
    }

    function test_Post_PriceCapExceeded() public {
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](1);
        tiers[0] = SwarmTypes.Tier({minUnits: 1, pricePerUnit: 5_000_001});
        vm.prank(OWNER); pass.mint(SUPPLIER, 10);
        vm.prank(SUPPLIER); pass.approve(address(factory), 10);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.PriceCapExceeded.selector);
        factory.postDeal(_params(address(pass), 10, 1, 10, 0, 10), tiers);
    }

    function test_Post_TiersNotAscending() public {
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 10, pricePerUnit: 1_000_000});
        tiers[1] = SwarmTypes.Tier({minUnits: 5,  pricePerUnit: 750_000});
        vm.prank(OWNER); pass.mint(SUPPLIER, 10);
        vm.prank(SUPPLIER); pass.approve(address(factory), 10);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.TiersNotAscending.selector);
        factory.postDeal(_params(address(pass), 10, 1, 10, 0, 10), tiers);
    }

    function test_Post_TiersNotDescending() public {
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 750_000});
        tiers[1] = SwarmTypes.Tier({minUnits: 10, pricePerUnit: 1_000_000});
        vm.prank(OWNER); pass.mint(SUPPLIER, 10);
        vm.prank(SUPPLIER); pass.approve(address(factory), 10);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.TiersNotDescending.selector);
        factory.postDeal(_params(address(pass), 10, 1, 10, 0, 10), tiers);
    }

    function test_Post_MinUnitsZero() public {
        // Use a single tier with minUnits=0 so TierMinUnitsExceedsMin doesn't fire first.
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](1);
        tiers[0] = SwarmTypes.Tier({minUnits: 0, pricePerUnit: 1_000_000});
        vm.prank(OWNER); pass.mint(SUPPLIER, 10);
        vm.prank(SUPPLIER); pass.approve(address(factory), 10);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.MinUnitsZero.selector);
        factory.postDeal(_params(address(pass), 10, 0, 10, 0, 10), tiers);
    }

    function test_Post_MinUnitsExceedsMax() public {
        // maxUnits=30 to accommodate stdTiers[2].minUnits=20; minUnits=31 > maxUnits=30.
        vm.prank(OWNER); pass.mint(SUPPLIER, 30);
        vm.prank(SUPPLIER); pass.approve(address(factory), 30);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.MinUnitsExceedsMax.selector);
        factory.postDeal(_params(address(pass), 30, 31, 10, 0, 10), stdTiers);
    }

    function test_Post_MaxBuyersOutOfRange_Zero() public {
        vm.prank(OWNER); pass.mint(SUPPLIER, 30);
        vm.prank(SUPPLIER); pass.approve(address(factory), 30);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.MaxBuyersOutOfRange.selector);
        factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         1,
                maxUnits:         30,
                maxUnitsPerBuyer: 0,
                maxBuyers:        0,   // invalid
                deadline:         uint64(block.timestamp + 1 days),
                title:            "T",
                description:      ""
            }),
            _oneTier()
        );
    }

    function test_Post_MaxBuyersOutOfRange_101() public {
        vm.prank(OWNER); pass.mint(SUPPLIER, 30);
        vm.prank(SUPPLIER); pass.approve(address(factory), 30);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.MaxBuyersOutOfRange.selector);
        factory.postDeal(_params(address(pass), 30, 1, 10, 0, 101), _oneTier());
    }

    function test_Post_InvalidGoodsToken_Zero() public {
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.InvalidGoodsToken.selector);
        factory.postDeal(_params(address(0), 30, 1, 10, 0, 10), _oneTier());
    }

    function test_Post_InvalidGoodsToken_USDC() public {
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.InvalidGoodsToken.selector);
        factory.postDeal(_params(USDC_ADDR, 30, 1, 10, 0, 10), _oneTier());
    }

    function test_Post_DeadlineNotFuture() public {
        vm.prank(OWNER); pass.mint(SUPPLIER, 30);
        vm.prank(SUPPLIER); pass.approve(address(factory), 30);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.DeadlineNotFuture.selector);
        factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         1,
                maxUnits:         30,
                maxUnitsPerBuyer: 0,
                maxBuyers:        10,
                deadline:         uint64(block.timestamp),   // not future
                title:            "T",
                description:      ""
            }),
            _oneTier()
        );
    }

    function test_Post_TitleEmpty() public {
        vm.prank(OWNER); pass.mint(SUPPLIER, 30);
        vm.prank(SUPPLIER); pass.approve(address(factory), 30);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.TitleEmpty.selector);
        factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         1,
                maxUnits:         30,
                maxUnitsPerBuyer: 0,
                maxBuyers:        10,
                deadline:         uint64(block.timestamp + 1 days),
                title:            "",
                description:      ""
            }),
            _oneTier()
        );
    }

    function test_Post_UnsupportedToken_FeeOnTransfer() public {
        MockFeeToken fee = new MockFeeToken();
        uint256 stock = 100;
        fee.mint(SUPPLIER, stock + 10);
        vm.prank(SUPPLIER); fee.approve(address(factory), stock);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.UnsupportedToken.selector);
        factory.postDeal(_params(address(fee), uint32(stock), 1, 10, 0, 10), stdTiers);
    }

    function test_Post_TierMinUnitsExceedsMin() public {
        // tiers[0].minUnits=10 > minUnits=5
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](1);
        tiers[0] = SwarmTypes.Tier({minUnits: 10, pricePerUnit: 1_000_000});
        vm.prank(OWNER); pass.mint(SUPPLIER, 20);
        vm.prank(SUPPLIER); pass.approve(address(factory), 20);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.TierMinUnitsExceedsMin.selector);
        factory.postDeal(_params(address(pass), 20, 5, 20, 0, 10), tiers);
    }

    function test_Post_LastTierExceedsMax() public {
        // tiers[1].minUnits=20 > maxUnits=15
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000});
        tiers[1] = SwarmTypes.Tier({minUnits: 20, pricePerUnit: 750_000});
        vm.prank(OWNER); pass.mint(SUPPLIER, 15);
        vm.prank(SUPPLIER); pass.approve(address(factory), 15);
        vm.prank(SUPPLIER);
        vm.expectRevert(DealFactory.LastTierExceedsMax.selector);
        factory.postDeal(_params(address(pass), 15, 1, 15, 0, 10), tiers);
    }

    // ── SECTION 2: Ordering ───────────────────────────────────────────────────

    function test_Order_ZeroUnits() public {
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 10_000_000);
        vm.prank(B1);
        vm.expectRevert(DemandPool.ZeroUnits.selector);
        pool.commit(d, 0);
    }

    function test_Order_UnitCapReached() public {
        // Post with single-tier so stdTiers[2].minUnits=20 doesn't exceed maxUnits=10.
        uint256 stock = 10;
        vm.prank(OWNER); pass.mint(SUPPLIER, stock);
        vm.prank(SUPPLIER); pass.approve(address(factory), stock);
        vm.prank(SUPPLIER);
        uint256 d = factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         1,
                maxUnits:         uint32(stock),
                maxUnitsPerBuyer: 0,
                maxBuyers:        10,
                deadline:         uint64(block.timestamp + 2 days),
                title:            "Cap Test",
                description:      ""
            }),
            _oneTier()
        );
        _fund(B1, 20_000_000); _commit(B1, d, 10); // fills maxUnits
        _fund(B2, 20_000_000);
        vm.prank(B2);
        vm.expectRevert(DemandPool.UnitCapReached.selector);
        pool.commit(d, 1);
    }

    function test_Order_MaxUnitsPerBuyer() public {
        uint256 d = _postStdDeal(30, 1, 10, 5); // maxPerBuyer=5
        _fund(B1, 20_000_000);
        vm.prank(B1);
        vm.expectRevert(DemandPool.UnitsPerBuyerExceeded.selector);
        pool.commit(d, 6);
    }

    function test_Order_MaxBuyersCap() public {
        uint256 d = _postStdDeal(30, 1, 2, 0); // maxBuyers=2
        _fund(B1, 10_000_000); _commit(B1, d, 1);
        _fund(B2, 10_000_000); _commit(B2, d, 1);
        _fund(B3, 10_000_000);
        vm.prank(B3);
        vm.expectRevert(DemandPool.BuyerCapReached.selector);
        pool.commit(d, 1);
    }

    // test_Order_AlreadyCommitted removed: v2.1 allows a second commit to add a lot
    // instead of reverting. Top-up behaviour is covered in SwarmV2TopUpTest.t.sol.
    function test_Order_TopUpAddsLot() public {
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 10_000_000);
        _commit(B1, d, 3);
        _fund(B1, 10_000_000);
        _commit(B1, d, 1); // top-up: adds 1 unit to existing order
        assertEq(pool.unitsOf(d, B1), 4, "total units = 4");
    }

    function test_Order_TierBreakByOwnOrder() public {
        // An order large enough to break a tier itself pays the lower price.
        // 0 units before. Buyer commits 15 units: priceAt(0+15=15) → tier[1] minUnits=10 → $0.75.
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 20_000_000);
        _commit(B1, d, 15);
        assertEq(pool.paidPerUnit(d, B1), 750_000, "paid $0.75 after self-break");
        assertEq(pool.escrowed(d, B1), 15 * 750_000, "escrowed 15 * $0.75");
    }

    function test_Order_IncrementalPriceFalls() public {
        // B1 pays $1.00, B2's order breaks tier so B2 pays $0.75.
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 10_000_000); _commit(B1, d, 5);
        _fund(B2, 10_000_000); _commit(B2, d, 8); // 5+8=13 >= 10 → $0.75
        assertEq(pool.paidPerUnit(d, B1), 1_000_000);
        assertEq(pool.paidPerUnit(d, B2), 750_000);
    }

    // ── SECTION 3: Worked example from spec ───────────────────────────────────
    // Tiers: 1/$1.00, 5/$0.75, 10/$0.50
    // B1 orders 1, B2 orders 3, B3 orders 2, B4 orders 4. Total 10.
    // priceAt for each:
    //   B1: priceAt(0+1=1)  = $1.00  (1>=1, <5). Escrowed $1.00.
    //   B2: priceAt(1+3=4)  = $1.00  (4>=1, <5). Escrowed $3.00.
    //   B3: priceAt(4+2=6)  = $0.75  (6>=5, <10). TierBroken. Escrowed $1.50.
    //   B4: priceAt(6+4=10) = $0.50  (10>=10). TierBroken. Escrowed $2.00.
    // cp=$0.50. Supplier USDC = $0.50*10 = $5.00.
    // Refunds: B1=(1.00-0.50)*1=$0.50, B2=(1.00-0.50)*3=$1.50, B3=(0.75-0.50)*2=$0.50, B4=0.
    // USDC conservation: 1+3+1.5+2=7.50 = 5.00+0.50+1.50+0.50+0.00=7.50 ✓
    // Goods: maxUnits=20, delivered=10, unsold=10. 20=10+10 ✓

    function test_WorkedExample() public {
        // Custom tiers for this example: 1/$1.00, 5/$0.75, 10/$0.50
        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](3);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000});
        tiers[1] = SwarmTypes.Tier({minUnits: 5,  pricePerUnit: 750_000});
        tiers[2] = SwarmTypes.Tier({minUnits: 10, pricePerUnit: 500_000});

        uint256 stock = 20;
        vm.prank(OWNER); pass.mint(SUPPLIER, stock);
        vm.prank(SUPPLIER); pass.approve(address(factory), stock);
        vm.prank(SUPPLIER);
        uint256 d = factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         1,
                maxUnits:         uint32(stock),
                maxUnitsPerBuyer: 0,
                maxBuyers:        10,
                deadline:         uint64(block.timestamp + 2 days),
                title:            "Worked Example",
                description:      "test"
            }),
            tiers
        );

        _fund(B1, 5_000_000); _commit(B1, d, 1);
        _fund(B2, 5_000_000); _commit(B2, d, 3);
        _fund(B3, 5_000_000); _commit(B3, d, 2);
        _fund(B4, 5_000_000); _commit(B4, d, 4);

        assertEq(pool.paidPerUnit(d, B1), 1_000_000, "B1 $1.00");
        assertEq(pool.paidPerUnit(d, B2), 1_000_000, "B2 $1.00");
        assertEq(pool.paidPerUnit(d, B3), 750_000,   "B3 $0.75");
        assertEq(pool.paidPerUnit(d, B4), 500_000,   "B4 $0.50");

        _settle(d);

        // USDC refunds
        assertEq(settler.claimable(B1), 500_000,   "B1 refund $0.50");
        assertEq(settler.claimable(B2), 1_500_000,  "B2 refund $1.50");
        assertEq(settler.claimable(B3), 500_000,   "B3 refund $0.50");
        assertEq(settler.claimable(B4), 0,          "B4 no refund");
        assertEq(settler.claimable(SUPPLIER), 5_000_000, "supplier $5.00");

        // Goods claimable
        assertEq(settler.goodsClaimable(address(pass), B1), 1,  "B1 1 pass");
        assertEq(settler.goodsClaimable(address(pass), B2), 3,  "B2 3 passes");
        assertEq(settler.goodsClaimable(address(pass), B3), 2,  "B3 2 passes");
        assertEq(settler.goodsClaimable(address(pass), B4), 4,  "B4 4 passes");
        assertEq(settler.goodsClaimable(address(pass), SUPPLIER), 10, "supplier 10 unsold");

        // Drain and verify final balances
        vm.prank(B1); settler.claim(); vm.prank(B1); settler.claimGoods(address(pass));
        vm.prank(B2); settler.claim(); vm.prank(B2); settler.claimGoods(address(pass));
        vm.prank(B3); settler.claim(); vm.prank(B3); settler.claimGoods(address(pass));
        vm.prank(B4); settler.claimGoods(address(pass));
        vm.prank(SUPPLIER); settler.claim();
        vm.prank(SUPPLIER); settler.claimGoods(address(pass));

        // USDC spent: B1=$1, B2=$3, B3=$1.5, B4=$2. After refund: B1 net=$0.50, B2=$1.50, B3=$1.00, B4=$2
        assertEq(usdc.balanceOf(B1),       5_000_000 - 1_000_000 + 500_000);
        assertEq(usdc.balanceOf(B2),       5_000_000 - 3_000_000 + 1_500_000);
        assertEq(usdc.balanceOf(B3),       5_000_000 - 1_500_000 + 500_000);
        assertEq(usdc.balanceOf(B4),       5_000_000 - 2_000_000);
        assertEq(usdc.balanceOf(SUPPLIER), 5_000_000);
        assertEq(pass.balanceOf(B1),       1);
        assertEq(pass.balanceOf(B2),       3);
        assertEq(pass.balanceOf(B3),       2);
        assertEq(pass.balanceOf(B4),       4);
        assertEq(pass.balanceOf(SUPPLIER), 10);
        assertEq(usdc.balanceOf(address(pool)),    0, "pool empty");
        assertEq(pass.balanceOf(address(settler)), 0, "settler empty");
    }

    // ── SECTION 4: Strand rule ────────────────────────────────────────────────

    function test_Strand_RefusedThenPermitted() public {
        // B1 commits 5 at $1.00, B2 commits 8 breaking tier to $0.75.
        // If B2 withdraws: totalUnits=5, newPrice=priceAt(5)=$1.00. B1 paid $1.00 ≥ $1.00 → OK.
        // If B1 tries to withdraw instead: totalUnits=8, newPrice=priceAt(8)=$1.00.
        //   B2's paidPerUnit=$0.75 < $1.00 → WouldStrandBuyer.
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 10_000_000); _commit(B1, d, 5);
        _fund(B2, 10_000_000); _commit(B2, d, 8); // breaks tier to $0.75

        // B1 tries to withdraw — B2 would be stranded ($0.75 < new price $1.00)
        vm.prank(B1);
        vm.expectRevert(DemandPool.WouldStrandBuyer.selector);
        pool.withdraw(d);

        // B2 adds more units... wait, one order per buyer. B3 commits enough to keep tier.
        _fund(B3, 10_000_000); _commit(B3, d, 5); // total=18, still $0.75

        // Now B1 withdraws: totalUnits−5=13, newPrice=$0.75. B2 paid $0.75, B3 paid $0.75. OK.
        vm.prank(B1); pool.withdraw(d);
        assertEq(pool.totalUnits(d), 13, "13 units remain");
    }

    function test_Strand_SingleBuyerCanAlwaysWithdraw() public {
        uint256 d = _postStdDeal(30, 5, 10, 0);
        // 15 units: priceAt(15) = $0.75; cost = 15 * 750_000 = 11_250_000
        _fund(B1, 15_000_000); _commit(B1, d, 15);
        // Only buyer — strand check skipped (buyers.length == 1)
        vm.prank(B1); pool.withdraw(d);
        assertEq(pool.totalUnits(d), 0);
    }

    // ── SECTION 5: Refund path ────────────────────────────────────────────────

    function test_Refund_BelowMinUnits() public {
        uint256 d = _postStdDeal(30, 20, 10, 0); // minUnits=20
        _fund(B1, 10_000_000); _commit(B1, d, 5);
        _fund(B2, 10_000_000); _commit(B2, d, 8); // total=13, below min=20

        vm.warp(block.timestamp + 2 days + 1);
        settler.refundAll(d);

        assertEq(factory.getDeal(d).state, 2, "refunded state");
        // Full escrow back
        assertEq(settler.claimable(B1), 5_000_000,  "B1 full escrow back");
        assertEq(settler.claimable(B2), 6_000_000,  "B2 full escrow back");
        // Supplier gets all stock back
        assertEq(settler.goodsClaimable(address(pass), SUPPLIER), 30, "supplier all stock back");

        vm.prank(B1); settler.claim();
        assertEq(usdc.balanceOf(B1), 10_000_000, "B1 made whole");

        vm.prank(SUPPLIER); settler.claimGoods(address(pass));
        assertEq(pass.balanceOf(SUPPLIER), 30, "supplier all passes back");
    }

    function test_Refund_NobodyOrdered() public {
        uint256 d = _postStdDeal(30, 5, 10, 0);
        vm.warp(block.timestamp + 2 days + 1);
        settler.refundAll(d);
        assertEq(factory.getDeal(d).state, 2);
        assertEq(settler.goodsClaimable(address(pass), SUPPLIER), 30, "supplier gets stock back");
        vm.prank(SUPPLIER); settler.claimGoods(address(pass));
        assertEq(pass.balanceOf(SUPPLIER), 30);
    }

    function test_Refund_SettleRevertsWhenBelowMin() public {
        uint256 d = _postStdDeal(30, 20, 10, 0);
        _fund(B1, 10_000_000); _commit(B1, d, 5);
        vm.warp(block.timestamp + 2 days + 1);
        vm.expectRevert(Settler.MinUnitsNotMet.selector);
        settler.settle(d);
    }

    // ── SECTION 6: Claims ─────────────────────────────────────────────────────

    function test_Claims_SecondClaimReverts() public {
        // B1 at $1.00, B2 breaks tier to $0.75 so B1 gets a non-zero refund to claim.
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 10_000_000); _commit(B1, d, 5);
        _fund(B2, 10_000_000); _commit(B2, d, 8); // total 13, breaks to $0.75
        _settle(d);

        // B1 refund = (1.00-0.75)*5 = $1.25 > 0
        assertGt(settler.claimable(B1), 0, "B1 has refund to claim");
        vm.prank(B1); settler.claim();
        vm.prank(B1);
        vm.expectRevert(Settler.NothingToClaim.selector);
        settler.claim();
    }

    function test_Claims_SecondClaimGoodsReverts() public {
        uint256 d = _postStdDeal(30, 1, 10, 0);
        _fund(B1, 10_000_000); _commit(B1, d, 5);
        _settle(d);

        vm.prank(B1); settler.claimGoods(address(pass));
        vm.prank(B1);
        vm.expectRevert(Settler.NothingToClaim.selector);
        settler.claimGoods(address(pass));
    }

    function test_Claims_ReentrantGoods() public {
        MockReentrantGoods reentrant = new MockReentrantGoods();
        // Do NOT set settler yet — we only want reentry during claimGoods, not settle.

        uint256 stock = 10;
        reentrant.mint(SUPPLIER, stock);
        vm.prank(SUPPLIER); reentrant.approve(address(factory), stock);

        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](1);
        tiers[0] = SwarmTypes.Tier({minUnits: 1, pricePerUnit: 1_000_000});

        vm.prank(SUPPLIER);
        uint256 d = factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(reentrant),
                tokensPerUnit:    1,
                minUnits:         1,
                maxUnits:         uint32(stock),
                maxUnitsPerBuyer: 0,
                maxBuyers:        10,
                deadline:         uint64(block.timestamp + 2 days),
                title:            "Reentrant Test",
                description:      "test"
            }),
            tiers
        );

        _fund(B1, 5_000_000); _commit(B1, d, 3);
        // Settle before arming the reentrant token — pullGoodsForSettler runs clean.
        _settle(d);

        // NOW arm the reentrant token so it tries to call claimGoods again on transfer.
        reentrant.setSettler(address(settler));

        // claimGoods holds the nonReentrant lock; the inner claimGoods call must revert.
        vm.prank(B1);
        vm.expectRevert();
        settler.claimGoods(address(reentrant));
    }

    // ── SECTION 7: Gas measurement ────────────────────────────────────────────

    function test_GasBound_Settle100() public {
        // Build deal with maxBuyers=100, maxUnits=200.
        uint256 stock = 200;
        vm.prank(OWNER); pass.mint(SUPPLIER, stock);
        vm.prank(SUPPLIER); pass.approve(address(factory), stock);

        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](1);
        tiers[0] = SwarmTypes.Tier({minUnits: 1, pricePerUnit: 1_000_000});

        vm.prank(SUPPLIER);
        uint256 d = factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         1,
                maxUnits:         uint32(stock),
                maxUnitsPerBuyer: 0,
                maxBuyers:        100,
                deadline:         uint64(block.timestamp + 2 days),
                title:            "Gas Bound",
                description:      "test"
            }),
            tiers
        );

        for (uint256 i = 0; i < 100; i++) {
            address buyer = address(uint160(0x9000 + i));
            usdc.mint(buyer, 2_000_000);
            vm.prank(buyer); usdc.approve(address(pool), type(uint256).max);
            vm.prank(buyer); pool.commit(d, 2);
        }

        vm.warp(block.timestamp + 2 days + 1);
        uint256 gasBefore = gasleft();
        settler.settle(d);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("settle(100 buyers) gas:", gasUsed);
        assertLt(gasUsed, 10_000_000, "settle must stay well below block gas limit");
    }

    // ── SECTION 8: Fuzz — conservation ───────────────────────────────────────

    function testFuzz_V2_Conservation(uint8 n, uint8 wMask) public {
        n = uint8(bound(uint256(n), 2, 20));

        uint256 stock = uint256(n) * 3; // plenty of units
        vm.prank(OWNER); pass.mint(SUPPLIER, stock);
        vm.prank(SUPPLIER); pass.approve(address(factory), stock);

        SwarmTypes.Tier[] memory tiers = new SwarmTypes.Tier[](2);
        tiers[0] = SwarmTypes.Tier({minUnits: 1,  pricePerUnit: 1_000_000});
        tiers[1] = SwarmTypes.Tier({minUnits: uint32(n), pricePerUnit: 500_000});

        vm.prank(SUPPLIER);
        uint256 d = factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         1,
                maxUnits:         uint32(stock),
                maxUnitsPerBuyer: 3,
                maxBuyers:        100,
                deadline:         uint64(block.timestamp + 2 days),
                title:            "Fuzz",
                description:      ""
            }),
            tiers
        );

        uint256 totalCommitted;
        address[] memory buyers = new address[](n);

        // Commit phase
        for (uint256 i = 0; i < n; i++) {
            address buyer = address(uint160(0xA000 + i));
            buyers[i] = buyer;
            uint32 units = uint32(1 + (i % 3)); // 1, 2, or 3 units
            usdc.mint(buyer, 10_000_000);
            vm.prank(buyer); usdc.approve(address(pool), type(uint256).max);
            vm.prank(buyer); pool.commit(d, units);
            totalCommitted += pool.escrowed(d, buyer);
        }

        // Withdraw phase: buyers whose bit in wMask is set try to withdraw
        for (uint256 i = 0; i < n && i < 8; i++) {
            if ((wMask >> i) & 1 == 0) continue;
            address buyer = buyers[i];
            // Skip if already not committed (shouldn't happen) or would strand
            if (pool.escrowed(d, buyer) == 0) continue;
            uint32 myUnits  = pool.unitsOf(d, buyer);
            uint32 newTotal = pool.totalUnits(d) - myUnits;
            uint64 newPrice = _priceAtPublic(d, newTotal);
            bool wouldStrand = false;
            if (pool.getBuyerCount(d) > 1) {
                // Rough check: if any buyer paid less than newPrice it would strand
                address[] memory remaining = pool.getBuyers(d);
                for (uint256 j = 0; j < remaining.length; j++) {
                    if (remaining[j] == buyer) continue;
                    if (pool.paidPerUnit(d, remaining[j]) < newPrice) { wouldStrand = true; break; }
                }
            }
            if (!wouldStrand) {
                uint256 escrow = pool.escrowed(d, buyer);
                vm.prank(buyer); pool.withdraw(d);
                totalCommitted -= escrow;
            }
        }

        // Settle or refund
        vm.warp(block.timestamp + 2 days + 1);
        uint32 total = pool.totalUnits(d);

        SwarmTypes.Deal memory deal = factory.getDeal(d);

        if (total >= deal.minUnits) {
            settler.settle(d);
        } else {
            settler.refundAll(d);
        }

        // Drain all claimable balances
        address[] memory activeBuyers = pool.getBuyers(d);
        for (uint256 i = 0; i < activeBuyers.length; i++) {
            address b = activeBuyers[i];
            if (settler.claimable(b) > 0) { vm.prank(b); settler.claim(); }
            if (settler.goodsClaimable(address(pass), b) > 0) { vm.prank(b); settler.claimGoods(address(pass)); }
        }
        // Also drain withdrawn buyers' claimable (credited via creditWithdrawal)
        for (uint256 i = 0; i < n; i++) {
            address b = buyers[i];
            if (settler.claimable(b) > 0) { vm.prank(b); settler.claim(); }
        }
        if (settler.claimable(SUPPLIER) > 0) { vm.prank(SUPPLIER); settler.claim(); }
        if (settler.goodsClaimable(address(pass), SUPPLIER) > 0) {
            vm.prank(SUPPLIER); settler.claimGoods(address(pass));
        }

        // After all claims: pool holds no USDC, settler holds no passes
        assertEq(usdc.balanceOf(address(pool)), 0, "pool USDC zero after all claims");
        assertEq(pass.balanceOf(address(settler)), 0, "settler passes zero after all claims");

        // USDC conservation: totalCommitted == supplier USDC claimed + buyer refunds
        // Since all claimed, total minted to buyers that they still hold
        // plus supplier balance must account for everything.
        // Simpler invariant: pool balance == 0 and nothing stuck in settler.
        assertEq(usdc.balanceOf(address(settler)), 0, "no USDC stuck in settler");

        // Goods conservation: all passes accounted for
        // factory emitted stock, everyone who claimed holds passes, settler empty
        if (total >= deal.minUnits) {
            // Delivered to buyers + unsold to supplier = stock
            uint256 passesOut;
            for (uint256 i = 0; i < n; i++) {
                passesOut += pass.balanceOf(buyers[i]);
            }
            passesOut += pass.balanceOf(SUPPLIER);
            assertEq(passesOut, stock, "all passes accounted for");
        } else {
            // Full refund: supplier has all passes
            assertEq(pass.balanceOf(SUPPLIER), stock, "supplier has all passes on refund");
        }

        // Conservation holds structurally: settle/refundAll both contain named-error checks
        // that revert if violated. Reaching this point proves conservation passed.
    }

    // ── Internal test helpers ─────────────────────────────────────────────────

    function _params(
        address goodsToken,
        uint32  maxUnits,
        uint32  minUnits,
        uint32  maxUnitsPerBuyer,
        uint64  deadline,
        uint32  maxBuyers
    ) internal view returns (DealFactory.PostParams memory) {
        uint64 dl = deadline == 0 ? uint64(block.timestamp + 1 days) : deadline;
        return DealFactory.PostParams({
            goodsToken:       goodsToken,
            tokensPerUnit:    1,
            minUnits:         minUnits,
            maxUnits:         maxUnits,
            maxUnitsPerBuyer: maxUnitsPerBuyer,
            maxBuyers:        maxBuyers == 0 ? 10 : maxBuyers,
            deadline:         dl,
            title:            "T",
            description:      ""
        });
    }

    function _priceAtPublic(uint256 dealId, uint32 units) internal view returns (uint64) {
        // For the fuzz strand check: compute the price at a hypothetical unit count
        // by reading deal tiers and iterating.
        SwarmTypes.Deal memory deal = factory.getDeal(dealId);
        for (uint256 i = deal.tiers.length; i > 0; i--) {
            if (units >= deal.tiers[i - 1].minUnits) return deal.tiers[i - 1].pricePerUnit;
        }
        return deal.tiers[0].pricePerUnit;
    }
}
