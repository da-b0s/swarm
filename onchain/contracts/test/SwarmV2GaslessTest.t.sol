// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DealFactory} from "../DealFactory.sol";
import {DemandPool} from "../DemandPool.sol";
import {Settler} from "../Settler.sol";
import {SwarmPass} from "../SwarmPass.sol";
import {SwarmTypes} from "../SwarmTypes.sol";
import {MockEIP3009USDC} from "../test-helpers/MockEIP3009USDC.sol";
import {MockBlocklistedEIP3009USDC} from "../test-helpers/MockBlocklistedEIP3009USDC.sol";

// ── Signing result struct — avoids stack-too-deep without via_ir ──────────────
struct Auth {
    uint256 validAfter;
    uint256 validBefore;
    bytes32 nonce;
    uint256 signedAmount;
    uint8   v;
    bytes32 r;
    bytes32 s;
}

contract SwarmV2GaslessTest is Test {
    // ── Infrastructure ────────────────────────────────────────────────────────

    DealFactory factory;
    DemandPool  pool;
    Settler     settler;
    SwarmPass   pass;
    MockEIP3009USDC usdc;

    address constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    address constant OWNER     = address(0x1000);
    address constant SUPPLIER  = address(0x2000);
    address constant RELAYER   = address(0x4000);

    // EIP-712 typehash for ReceiveWithAuthorization
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,"
        "uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,"
        "uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // Standard two-tier curve: 1 unit = $1.00, ≥10 units = $0.75
    SwarmTypes.Tier[] internal stdTiers;

    function setUp() public {
        // Etch the EIP-3009 mock at the canonical USDC address.
        MockEIP3009USDC impl = new MockEIP3009USDC();
        vm.etch(USDC_ADDR, address(impl).code);
        usdc = MockEIP3009USDC(USDC_ADDR);
        usdc.initialize(); // rebuild domain separator at the etched address

        vm.prank(OWNER); pass    = new SwarmPass(true);
        vm.prank(OWNER); factory = new DealFactory(OWNER);
        vm.prank(OWNER); pool    = new DemandPool(address(factory), OWNER);
        vm.prank(OWNER); settler = new Settler(address(factory), address(pool), OWNER);
        vm.prank(OWNER); factory.setDemandPool(address(pool));
        vm.prank(OWNER); factory.setSettler(address(settler));
        vm.prank(OWNER); pool.setSettler(address(settler));

        stdTiers.push(SwarmTypes.Tier({minUnits:  1, pricePerUnit: 1_000_000}));
        stdTiers.push(SwarmTypes.Tier({minUnits: 10, pricePerUnit:   750_000}));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _postDeal(uint32 maxUnits, uint32 minUnits) internal returns (uint256) {
        uint256 stock = uint256(maxUnits);
        vm.prank(OWNER); pass.mint(SUPPLIER, stock);
        vm.prank(SUPPLIER); pass.approve(address(factory), stock);
        vm.prank(SUPPLIER);
        return factory.postDeal(
            DealFactory.PostParams({
                goodsToken:       address(pass),
                tokensPerUnit:    1,
                minUnits:         minUnits,
                maxUnits:         maxUnits,
                maxUnitsPerBuyer: 0,
                maxBuyers:        50,
                deadline:         uint64(block.timestamp + 2 days),
                title:            "Gasless Deal",
                description:      ""
            }),
            stdTiers
        );
    }

    /// @dev Fund a named-account address (not a vm key) with USDC via the mock.
    function _fund(address who, uint256 amt) internal {
        usdc.mint(who, amt);
    }

    /// @dev Fund a private-key-derived address with USDC.
    function _fundPk(uint256 pk, uint256 amt) internal {
        usdc.mint(vm.addr(pk), amt);
    }

    /**
     * @dev Build and sign a ReceiveWithAuthorization for `commitWithAuthorization`.
     *      Nonce = keccak256(pool, dealId, buyer, units, salt) — matches the contract.
     *      signedAmount = priceAt(totalUnits + units) * units at call time.
     *
     *      Returns Auth struct so the caller has one memory slot, not seven stack slots.
     */
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
        // Quote the price including this buyer's units.
        uint64 priceAfter = _priceAt(dealId, uint256(pool.totalUnits(dealId)) + uint256(units));
        a.signedAmount = uint256(priceAfter) * uint256(units);

        // Build the EIP-712 domain separator — must match initialize()'d value at USDC_ADDR.
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

    /// @dev Helper: read priceAt from the pool's perspective (mirrors contract logic).
    function _priceAt(uint256 dealId, uint256 units) internal view returns (uint64) {
        SwarmTypes.Deal memory d = factory.getDeal(dealId);
        for (uint256 i = d.tiers.length; i > 0; i--) {
            if (units >= d.tiers[i - 1].minUnits) return d.tiers[i - 1].pricePerUnit;
        }
        return d.tiers[0].pricePerUnit;
    }

    /// @dev Submit a gasless commit as the RELAYER.
    function _gaslessCommit(
        uint256 dealId,
        uint256 pk,
        uint32  units,
        Auth memory a
    ) internal {
        vm.prank(RELAYER);
        pool.commitWithAuthorization(
            dealId,
            vm.addr(pk),
            units,
            a.signedAmount,
            a.validAfter,
            a.validBefore,
            a.nonce,       // already the derived nonce — we pass it as salt here
            a.v, a.r, a.s
        );
    }

    // ── Problem: commitWithAuthorization takes `salt` not the computed nonce ──
    // The public API is:
    //   commitWithAuthorization(dealId, buyer, units, authorizedAmount,
    //                           validAfter, validBefore, salt, v, r, s)
    // And the contract computes: nonce = keccak256(pool, dealId, buyer, units, salt).
    // We must pass the RAW SALT, not the computed nonce.
    // _signAuth already computes a.nonce = authorizationNonce(..., salt),
    // so we need to also store the salt separately.
    // Rebuild _signAuth to take an explicit salt bytes32 and store it.
    // Rebuild _gaslessCommit to pass salt.
    //
    // → Restructure: _signAuth receives a salt, the Auth struct stores both
    //   the computed nonce AND the original salt so _gaslessCommit can pass the salt.

    // ── Tests ─────────────────────────────────────────────────────────────────

    // 1. Signer recorded, not relayer ─────────────────────────────────────────
    function test_GL_SignerRecorded() public {
        uint256 d   = _postDeal(20, 1);
        uint256 pk  = 0xA001;
        address buyer = vm.addr(pk);
        bytes32 salt = bytes32(uint256(1));

        Auth memory a = _signAuth(pk, d, 3, salt);
        _fundPk(pk, a.signedAmount);
        _gaslessCommitWithSalt(d, pk, 3, a, salt);

        assertEq(pool.unitsOf(d, buyer),  3,             "units recorded");
        assertEq(pool.unitsOf(d, RELAYER), 0,            "relayer not recorded");
        uint256 expectedEscrow = uint256(1_000_000) * 3; // priceAt(3) = $1.00
        assertEq(pool.escrowed(d, buyer), expectedEscrow, "escrow correct");
    }

    // 2. Price falls between signing and landing ───────────────────────────────
    function test_GL_PriceFalls_ExcessCredited() public {
        uint256 d   = _postDeal(20, 1);
        uint256 pk  = 0xA002;
        address buyer = vm.addr(pk);
        bytes32 salt = bytes32(uint256(2));

        // Sign for 8 units at $1.00 each = $8.00 (does NOT break tier on its own)
        Auth memory a = _signAuth(pk, d, 8, salt);
        assertEq(a.signedAmount, 8_000_000, "signed for $8.00");
        _fundPk(pk, a.signedAmount);

        // Another buyer commits 5 units first — total becomes 5, still $1.00, no break yet.
        // Then our buyer's 8 units: total = 13 ≥ 10 → breaks to $0.75.
        // BUT: _signAuth quotes priceAt(0 + 8) = $1.00 BEFORE the other buyer commits.
        // After the other buyer commits 5 units, total = 5; priceAt(5 + 8) = priceAt(13) = $0.75.
        // So at landing, requiredTotal = $0.75 * 8 = $6.00 < signed $8.00 → excess = $2.00.

        // Commit the other buyer first (standard path).
        address other = address(0x5001);
        _fund(other, 5_000_000);
        vm.prank(other); usdc.approve(address(pool), 5_000_000);
        vm.prank(other); pool.commit(d, 5);

        // Now submit the gasless commit; price has fallen.
        vm.expectEmit(true, true, false, true);
        emit DemandPool.ExcessCredited(d, buyer, 2_000_000); // $2.00 excess
        _gaslessCommitWithSalt(d, pk, 8, a, salt);

        // Buyer escrowed at $0.75 * 8 = $6.00
        assertEq(pool.escrowed(d, buyer), 6_000_000, "escrowed at lower price");
        // Excess $2.00 is in settler.claimable
        assertEq(settler.claimable(buyer), 2_000_000, "excess in claimable");
    }

    // 3. Price rises above authorization ──────────────────────────────────────
    function test_GL_PriceRose() public {
        uint256 d   = _postDeal(20, 1);
        uint256 pk  = 0xA003;
        bytes32 salt = bytes32(uint256(3));

        // Push past tier 2 to $0.75: commit 10 units with a standard buyer.
        address tierer = address(0x5002);
        _fund(tierer, 10_000_000);
        vm.prank(tierer); usdc.approve(address(pool), 10_000_000);
        vm.prank(tierer); pool.commit(d, 10); // total=10, price=$0.75

        // Sign for 5 units at $0.75 * 5 = $3.75 (price at total+5 = priceAt(15) = $0.75)
        Auth memory a = _signAuth(pk, d, 5, salt);
        assertEq(a.signedAmount, 3_750_000, "signed $3.75");
        _fundPk(pk, a.signedAmount);

        // Tierer withdraws — total drops to 0, price rises back to $1.00.
        // v2.2: read unitsOf before prank (prank would be consumed by the view call).
        uint32 tiererUnits = pool.unitsOf(d, tierer);
        vm.prank(tierer);
        pool.withdraw(d, tiererUnits);

        // Now priceAt(0 + 5) = $1.00; required = $5.00 > authorized $3.75.
        // PriceRoseBeyondAuthorization(5_000_000) expected.
        bytes32 nonce = pool.authorizationNonce(d, vm.addr(pk), 5, salt);
        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(DemandPool.PriceRoseBeyondAuthorization.selector, uint256(5_000_000))
        );
        pool.commitWithAuthorization(d, vm.addr(pk), 5, a.signedAmount, a.validAfter, a.validBefore, salt, a.v, a.r, a.s);

        // No state changes.
        assertEq(pool.unitsOf(d, vm.addr(pk)), 0, "no units recorded");
        assertFalse(usdc.authorizationState(vm.addr(pk), nonce), "nonce not consumed");
    }

    // 4. Units are bound: same signature, different units → revert ─────────────
    function test_GL_UnitsBound() public {
        uint256 d   = _postDeal(20, 1);
        uint256 pk  = 0xA004;
        address buyer = vm.addr(pk);
        bytes32 salt = bytes32(uint256(4));

        // Sign for 3 units.
        Auth memory a = _signAuth(pk, d, 3, salt);
        _fundPk(pk, a.signedAmount + 1_000_000); // fund a bit extra

        // Try to submit with units=4 — nonce mismatch: pool derives nonce(d, buyer, 4, salt)
        // which differs from nonce(d, buyer, 3, salt), so USDC's sig check fails.
        vm.prank(RELAYER);
        vm.expectRevert(); // USDC will revert InvalidSignature
        pool.commitWithAuthorization(d, buyer, 4, a.signedAmount, a.validAfter, a.validBefore, salt, a.v, a.r, a.s);

        assertEq(pool.unitsOf(d, buyer), 0, "no units");
        assertEq(usdc.balanceOf(buyer), a.signedAmount + 1_000_000, "balance unchanged");
    }

    // 5. Replay reverts AuthorizationAlreadyUsed ──────────────────────────────
    function test_GL_Replay() public {
        uint256 d   = _postDeal(20, 1);
        uint256 pk  = 0xA005;
        bytes32 salt = bytes32(uint256(5));

        Auth memory a = _signAuth(pk, d, 2, salt);
        _fundPk(pk, a.signedAmount);
        _gaslessCommitWithSalt(d, pk, 2, a, salt);

        // Second attempt with same params — nonce already consumed.
        vm.prank(RELAYER);
        vm.expectRevert(DemandPool.AuthorizationAlreadyUsed.selector);
        pool.commitWithAuthorization(d, vm.addr(pk), 2, a.signedAmount, a.validAfter, a.validBefore, salt, a.v, a.r, a.s);
    }

    // 6. Signature for deal A cannot commit to deal B ─────────────────────────
    function test_GL_WrongDeal() public {
        uint256 dA  = _postDeal(20, 1);
        uint256 dB  = _postDeal(20, 1);
        uint256 pk  = 0xA006;
        address buyer = vm.addr(pk);
        bytes32 salt = bytes32(uint256(6));

        // Sign for deal A, 2 units.
        Auth memory a = _signAuth(pk, dA, 2, salt);
        _fundPk(pk, a.signedAmount * 2);

        // Submit against deal B — nonce derivation includes dealId, so it mismatches.
        vm.prank(RELAYER);
        vm.expectRevert(); // USDC rejects: InvalidSignature
        pool.commitWithAuthorization(dB, buyer, 2, a.signedAmount, a.validAfter, a.validBefore, salt, a.v, a.r, a.s);

        assertEq(pool.unitsOf(dB, buyer), 0, "deal B unchanged");
        assertEq(pool.unitsOf(dA, buyer), 0, "deal A unchanged");
    }

    // 7. ReceiveWithAuthorization sig submitted to transferWithAuthorization ───
    function test_GL_TransferWithAuthCannotCommit() public {
        uint256 d   = _postDeal(20, 1);
        uint256 pk  = 0xA007;
        address buyer = vm.addr(pk);
        bytes32 salt = bytes32(uint256(7));

        // Sign as the gasless flow would — a ReceiveWithAuthorization.
        Auth memory a = _signAuth(pk, d, 3, salt);
        _fundPk(pk, a.signedAmount);

        // Attacker tries to call transferWithAuthorization with the same (v, r, s).
        // The typehash is different, so ecrecover returns a wrong address → InvalidSignature.
        vm.expectRevert();
        usdc.transferWithAuthorization(
            buyer,
            address(pool),
            a.signedAmount,
            a.validAfter,
            a.validBefore,
            a.nonce,
            a.v, a.r, a.s
        );

        // Balance and deal state unchanged.
        assertEq(usdc.balanceOf(buyer), a.signedAmount, "buyer balance unchanged");
        assertEq(pool.unitsOf(d, buyer), 0,             "no units recorded");

        // The same signature still works through commitWithAuthorization.
        _gaslessCommitWithSalt(d, pk, 3, a, salt);
        assertEq(pool.unitsOf(d, buyer), 3, "committed after failed transferWithAuth");
    }

    // 8. Blocklisted buyer reverts Blocklisted ────────────────────────────────
    function test_GL_Blocklisted() public {
        // Replace USDC mock with the blocklisted variant.
        MockBlocklistedEIP3009USDC blocked = new MockBlocklistedEIP3009USDC();
        vm.etch(USDC_ADDR, address(blocked).code);
        MockBlocklistedEIP3009USDC bUsdc = MockBlocklistedEIP3009USDC(USDC_ADDR);
        bUsdc.initialize();

        uint256 d   = _postDeal(20, 1);
        uint256 pk  = 0xA008;
        address buyer = vm.addr(pk);
        bytes32 salt = bytes32(uint256(8));

        Auth memory a = _signAuth(pk, d, 2, salt);
        bUsdc.mint(buyer, a.signedAmount);
        bUsdc.setBlacklisted(buyer, true);

        vm.prank(RELAYER);
        vm.expectRevert(DemandPool.Blocklisted.selector);
        pool.commitWithAuthorization(d, buyer, 2, a.signedAmount, a.validAfter, a.validBefore, salt, a.v, a.r, a.s);

        assertEq(pool.unitsOf(d, buyer), 0);
    }

    // 9. Fuzz: mixed ordinary + gasless, conservation ─────────────────────────
    function testFuzz_V2Gasless_Conservation(uint8 nRaw, uint8 gaslessMask) public {
        uint32 n = uint32(bound(uint256(nRaw), 3, 20));
        uint256 d = _postDeal(uint32(n) * 5, 1); // generous maxUnits

        uint256 totalUsdcIn;   // USDC that entered the pool
        uint256 totalGoodsIn;  // passes the pool received from factory (via pullGoodsForSettler)

        for (uint256 i = 1; i <= n; i++) {
            uint32  units    = uint32(bound(uint256(keccak256(abi.encode(i, d))) % 5 + 1, 1, 4));
            bool    gasless  = ((gaslessMask >> (i % 8)) & 1) == 1;
            uint256 pk       = 0xB000 + i;
            address buyer    = vm.addr(pk);

            // Skip if maxUnits would be exceeded.
            if (uint256(pool.totalUnits(d)) + uint256(units) > uint256(n) * 5) continue;

            if (gasless) {
                bytes32 salt = bytes32(i);
                Auth memory a = _signAuth(pk, d, units, salt);
                usdc.mint(buyer, a.signedAmount);
                _gaslessCommitWithSalt(d, pk, units, a, salt);
                totalUsdcIn += a.signedAmount; // full authorized amount entered pool
            } else {
                // Quote the price the contract will charge.
                uint64 price = _priceAt(d, uint256(pool.totalUnits(d)) + uint256(units));
                uint256 cost = uint256(price) * uint256(units);
                usdc.mint(buyer, cost);
                vm.prank(buyer); usdc.approve(address(pool), cost);
                vm.prank(buyer); pool.commit(d, units);
                totalUsdcIn += cost;
            }
        }

        // Settle or refundAll.
        vm.warp(block.timestamp + 2 days + 1);
        SwarmTypes.Deal memory deal = factory.getDeal(d);
        bool settled = pool.totalUnits(d) >= deal.minUnits;
        if (settled) {
            settler.settle(d);
            // goodsIn = totalUnitsSold * tokensPerUnit (delivered to buyers at settle)
            totalGoodsIn = uint256(pool.totalUnits(d)); // captured before settle clears (recorded in deal)
        } else {
            settler.refundAll(d);
        }

        // Drain all claimable USDC.
        address[] memory buyers = pool.getBuyers(d);
        for (uint256 i = 0; i < buyers.length; i++) {
            address b = buyers[i];
            if (settler.claimable(b) > 0) { vm.prank(b); settler.claim(); }
        }
        if (settler.claimable(SUPPLIER) > 0) { vm.prank(SUPPLIER); settler.claim(); }

        // Drain all goods claimable.
        for (uint256 i = 0; i < buyers.length; i++) {
            address b = buyers[i];
            if (settler.goodsClaimable(address(pass), b) > 0) {
                vm.prank(b); settler.claimGoods(address(pass));
            }
        }
        if (settler.goodsClaimable(address(pass), SUPPLIER) > 0) {
            vm.prank(SUPPLIER); settler.claimGoods(address(pass));
        }

        // After all claims: both contracts hold nothing.
        assertEq(usdc.balanceOf(address(pool)),    0, "pool holds no USDC");
        assertEq(usdc.balanceOf(address(settler)), 0, "settler holds no USDC");
        assertEq(pass.balanceOf(address(factory)), 0, "factory holds no passes");
        assertEq(pass.balanceOf(address(settler)), 0, "settler holds no passes");
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * @dev _gaslessCommit but passes the original salt (not the computed nonce)
     *      to commitWithAuthorization, as the contract expects.
     *      The Auth.nonce field holds the computed nonce for reference/assertions.
     */
    function _gaslessCommitWithSalt(
        uint256 dealId,
        uint256 pk,
        uint32  units,
        Auth memory a,
        bytes32 salt
    ) internal {
        vm.prank(RELAYER);
        pool.commitWithAuthorization(
            dealId,
            vm.addr(pk),
            units,
            a.signedAmount,
            a.validAfter,
            a.validBefore,
            salt,
            a.v, a.r, a.s
        );
    }
}
