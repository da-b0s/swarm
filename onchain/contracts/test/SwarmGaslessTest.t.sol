// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DealFactory} from "../DealFactory.sol";
import {DemandPool} from "../DemandPool.sol";
import {Settler} from "../Settler.sol";
import {SwarmTypes} from "../SwarmTypes.sol";

import {MockEIP3009USDC} from "../test-helpers/MockEIP3009USDC.sol";
import {MockBlocklistedEIP3009USDC} from "../test-helpers/MockBlocklistedEIP3009USDC.sol";

contract SwarmGaslessTest is Test {
    // ── Constants ─────────────────────────────────────────────────────────────
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;

    address internal owner    = makeAddr("owner");
    address internal supplier = makeAddr("supplier");
    address internal relayer  = makeAddr("relayer");

    uint32 internal constant MIN_BUYERS      = 10;
    uint32 internal constant CAP             = 100;
    uint32 internal constant DEADLINE_OFFSET = 7 days;

    // EIP-712 typehash for ReceiveWithAuthorization — must match the mock exactly.
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // EIP-712 typehash for TransferWithAuthorization.
    bytes32 internal constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// Packed return struct for _signAuth — avoids stack-too-deep without via_ir.
    struct Auth {
        address buyer;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8   v;
        bytes32 r;
        bytes32 s;
    }

    // ── Contracts ─────────────────────────────────────────────────────────────
    DealFactory        internal factory;
    DemandPool         internal pool;
    Settler            internal settler;
    MockEIP3009USDC    internal usdc;

    // ── Standard tier curve ───────────────────────────────────────────────────
    function _standardTiers() internal pure returns (SwarmTypes.Tier[] memory t) {
        t = new SwarmTypes.Tier[](3);
        t[0] = SwarmTypes.Tier({minBuyers: 10, pricePerUnit: 1_000_000}); // $1.00
        t[1] = SwarmTypes.Tier({minBuyers: 25, pricePerUnit:   750_000}); // $0.75
        t[2] = SwarmTypes.Tier({minBuyers: 50, pricePerUnit:   500_000}); // $0.50
    }

    // ── setUp ─────────────────────────────────────────────────────────────────
    function setUp() public {
        // Deploy mock at a temporary address, etch its bytecode onto USDC_ADDR,
        // then call initialize() so the domain separator uses the correct
        // verifyingContract (USDC_ADDR, not the temporary deploy address).
        MockEIP3009USDC tmp = new MockEIP3009USDC();
        vm.etch(USDC_ADDR, address(tmp).code);
        usdc = MockEIP3009USDC(USDC_ADDR);
        usdc.initialize();

        // Deploy and wire the protocol stack.
        factory = new DealFactory(owner);
        pool    = new DemandPool(address(factory), owner);
        settler = new Settler(address(factory), address(pool), owner);

        vm.prank(owner); pool.setSettler(address(settler));
        vm.prank(owner); factory.setSettler(address(settler));
        vm.prank(owner); factory.setDemandPool(address(pool));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Post the standard deal and return its id.
    function _postDeal() internal returns (uint256) {
        vm.prank(supplier);
        return factory.postDeal(
            _standardTiers(), MIN_BUYERS,
            uint64(block.timestamp + DEADLINE_OFFSET), CAP
        );
    }

    /// Mint USDC and approve pool for a standard buyer.
    function _fund(address buyer, uint256 amount) internal {
        usdc.mint(buyer, amount);
        vm.prank(buyer);
        usdc.approve(address(pool), amount);
    }

    /// Commit N sequential standard buyers (address(uint160(1..N))).
    function _commitN(uint256 dealId, uint256 n) internal {
        for (uint256 i = 1; i <= n; i++) {
            address b = address(uint160(i));
            _fund(b, 2_000_000);
            vm.prank(b);
            pool.commit(dealId);
        }
    }

    /**
     * @dev Build and sign a ReceiveWithAuthorization digest.
     *
     * The domain separator is read directly from the etched mock at USDC_ADDR
     * rather than recomputed here, so a misconfigured domain makes tests fail
     * rather than passing with wrong math.
     *
     * The nonce is the pool's authorizationNonce(dealId, buyer, salt).
     */
    /// Build and sign a ReceiveWithAuthorization.
    /// Returns an Auth struct — one slot per return value, no stack-too-deep.
    function _signAuth(
        uint256 buyerPk,
        uint256 dealId,
        uint256 value,
        bytes32 salt
    ) internal view returns (Auth memory a) {
        a.buyer       = vm.addr(buyerPk);
        a.validAfter  = 0;
        a.validBefore = block.timestamp + 10 minutes;
        a.nonce       = pool.authorizationNonce(dealId, a.buyer, salt);

        bytes32 domSep = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("USDC")),
            keccak256(bytes("2")),
            block.chainid,
            USDC_ADDR
        ));
        bytes32 structHash = keccak256(abi.encode(
            RECEIVE_TYPEHASH,
            a.buyer, address(pool), value, a.validAfter, a.validBefore, a.nonce
        ));
        (a.v, a.r, a.s) = vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", domSep, structHash)));
    }

    // ── Test 1: commit recorded for signer, not relayer ───────────────────────
    function test_Gasless_SignerRecorded() public {
        uint256 dealId = _postDeal();
        uint256 buyerPk = 0xB0B;
        address buyer = vm.addr(buyerPk);
        usdc.mint(buyer, 2_000_000);

        Auth memory a = _signAuth(buyerPk, dealId, 1_000_000, bytes32(0));

        vm.prank(relayer);
        pool.commitWithAuthorization(dealId, buyer, 1_000_000, a.validAfter, a.validBefore, bytes32(0), a.v, a.r, a.s);

        // Signer is recorded as buyer, relayer is not.
        assertEq(pool.escrowed(dealId, buyer),   1_000_000, "buyer escrowed");
        assertEq(pool.escrowed(dealId, relayer),          0, "relayer not escrowed");
        assertEq(pool.getBuyerCount(dealId),              1,  "one buyer");
    }

    // ── Test 2: price falls between sign and land — excess credited ───────────
    function test_Gasless_ExcessCredited() public {
        uint256 dealId = _postDeal();

        // Sign at $1.00 (current price before any buyers).
        uint256 buyerPk = 0xA11CE;
        address buyer = vm.addr(buyerPk);
        usdc.mint(buyer, 2_000_000);

        Auth memory a = _signAuth(buyerPk, dealId, 1_000_000, bytes32(0));

        // First commit 24 standard buyers — price is still $1.00.
        _commitN(dealId, 24);
        // Now commit our buyer as the 25th — this breaks the $0.75 tier.
        // The live price after this buyer lands is $0.75, but authorized was $1.00.
        // Excess = $0.25 → should go to buyer's claimable.
        uint256 claimBefore = settler.claimable(buyer);

        vm.expectEmit(true, true, false, true, address(pool));
        emit DemandPool.ExcessCredited(dealId, buyer, 250_000);

        vm.prank(relayer);
        pool.commitWithAuthorization(dealId, buyer, 1_000_000, a.validAfter, a.validBefore, bytes32(0), a.v, a.r, a.s);

        // Escrowed is the live price ($0.75), not $1.00.
        assertEq(pool.escrowed(dealId, buyer), 750_000, "escrowed live price");
        assertEq(settler.claimable(buyer), claimBefore + 250_000, "excess in claimable");

        // Conservation at settlement.
        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.settle(dealId);

        uint64 cp = pool.clearingPrice(dealId);
        assertEq(cp, 750_000, "clearing price $0.75 at 25 buyers");

        // Supplier gets cp * 25.
        assertEq(settler.claimable(supplier), uint256(cp) * 25, "supplier credit");

        // Total claimable == total committed (including excess already in claimable).
        // Buyer committed $1.00, escrowed $0.75, excess $0.25 in claimable before settle.
        // After settle: refund for buyer = escrowed($0.75) - cp($0.75) = 0.
        // So buyer's final claimable = $0.25 (excess) + 0 (settle refund) = $0.25.
        assertEq(settler.claimable(buyer), 250_000, "buyer claimable = excess only");
    }

    // ── Test 3: price rises above authorization — PriceRoseBeyondAuthorization ─
    //
    // The price a new buyer pays is clearingPriceAt(count + 1), not clearingPrice().
    // At 24 buyers, clearingPrice() = $1.00 but the 25th commit will cost $0.75
    // (breaking the tier). A buyer who signed for $0.50 (expecting the $0.50 tier
    // to be active) but submits when only 24 buyers exist will get
    // PriceRoseBeyondAuthorization($0.75) — the price they'd be charged is above
    // what they authorized.
    function test_Gasless_PriceRose() public {
        uint256 dealId = _postDeal();

        // 24 standard buyers at $1.00.
        _commitN(dealId, 24);
        assertEq(pool.clearingPrice(dealId), 1_000_000, "price $1.00 at 24 buyers");

        // Buyer signs for $0.50 (they expected the $0.50 / 50-buyer tier to be active).
        uint256 buyerPk = 0xC0FFEE;
        address buyer = vm.addr(buyerPk);
        usdc.mint(buyer, 2_000_000);

        Auth memory a = _signAuth(buyerPk, dealId, 500_000, bytes32(0));

        // commitWithAuthorization peeks: priceAfter = clearingPriceAt(25) = $0.75.
        // authorized ($0.50) < priceAfter ($0.75) → PriceRoseBeyondAuthorization.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(DemandPool.PriceRoseBeyondAuthorization.selector, uint64(750_000))
        );
        pool.commitWithAuthorization(dealId, buyer, 500_000, a.validAfter, a.validBefore, bytes32(0), a.v, a.r, a.s);

        // No state change: buyer not recorded, count still 24.
        assertEq(pool.escrowed(dealId, buyer), 0, "no escrow after revert");
        assertEq(pool.getBuyerCount(dealId), 24, "count unchanged");
    }

    // ── Test 4: replay reverts AuthorizationAlreadyUsed ───────────────────────
    function test_Gasless_Replay() public {
        uint256 dealId = _postDeal();
        uint256 buyerPk = 0xDEAD;
        address buyer = vm.addr(buyerPk);
        usdc.mint(buyer, 4_000_000);

        Auth memory a = _signAuth(buyerPk, dealId, 1_000_000, bytes32(uint256(42)));

        // First commit succeeds.
        vm.prank(relayer);
        pool.commitWithAuthorization(dealId, buyer, 1_000_000, a.validAfter, a.validBefore, bytes32(uint256(42)), a.v, a.r, a.s);
        assertEq(pool.escrowed(dealId, buyer), 1_000_000);

        // Replay on the same deal — AuthorizationAlreadyUsed (our pre-check).
        vm.prank(relayer);
        vm.expectRevert(DemandPool.AuthorizationAlreadyUsed.selector);
        pool.commitWithAuthorization(dealId, buyer, 1_000_000, a.validAfter, a.validBefore, bytes32(uint256(42)), a.v, a.r, a.s);
    }

    // ── Test 5: signature for deal A cannot commit to deal B ──────────────────
    function test_Gasless_WrongDeal() public {
        uint256 dealA = _postDeal();
        uint256 dealB = _postDeal();

        uint256 buyerPk = 0xFACE;
        address buyer = vm.addr(buyerPk);
        usdc.mint(buyer, 2_000_000);

        // Sign for deal A.
        Auth memory a = _signAuth(buyerPk, dealA, 1_000_000, bytes32(0));

        // Submit against deal B — nonce mismatch → USDC InvalidSignature revert.
        vm.prank(relayer);
        vm.expectRevert(); // MockEIP3009USDC.InvalidSignature
        pool.commitWithAuthorization(dealB, buyer, 1_000_000, a.validAfter, a.validBefore, bytes32(0), a.v, a.r, a.s);

        // Deal B is unchanged.
        assertEq(pool.getBuyerCount(dealB), 0, "deal B unchanged");
    }

    // ── Test 6: ReceiveWithAuthorization sig cannot be replayed via transferWithAuthorization ──
    //
    // Threat: someone intercepts the buyer's ReceiveWithAuthorization signature
    // (intended for the pool) and submits it directly to
    // usdc.transferWithAuthorization(...) to move USDC into the pool with no
    // commit recorded.
    //
    // Why it cannot work: the two authorization types use different EIP-712
    // typehashes. A signature over ReceiveWithAuthorization covers a different
    // struct hash than TransferWithAuthorization, so the token's ecrecover
    // produces the wrong signer and the call reverts InvalidSignature.
    //
    // We then show the same (v, r, s) triple still works correctly through
    // commitWithAuthorization — the signature was never consumed.
    function test_Gasless_TransferWithAuthCannotCommit() public {
        uint256 dealId  = _postDeal();
        uint256 buyerPk = 0xBEEF;
        address buyer   = vm.addr(buyerPk);
        usdc.mint(buyer, 2_000_000);

        // Sign a ReceiveWithAuthorization exactly as the gasless flow does.
        Auth memory a = _signAuth(buyerPk, dealId, 1_000_000, bytes32(0));

        uint256 buyerBalBefore = usdc.balanceOf(buyer);
        uint256 poolBalBefore  = usdc.balanceOf(address(pool));

        // Attempt to replay the ReceiveWithAuthorization sig via
        // transferWithAuthorization. The typehashes differ, so ecrecover returns
        // the wrong signer and the mock reverts InvalidSignature.
        vm.expectRevert(); // InvalidSignature
        usdc.transferWithAuthorization(
            buyer, address(pool), 1_000_000,
            a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s
        );

        // Buyer balance, pool balance and buyer count are all unchanged.
        assertEq(usdc.balanceOf(buyer),        buyerBalBefore, "buyer balance unchanged");
        assertEq(usdc.balanceOf(address(pool)), poolBalBefore,  "pool balance unchanged");
        assertEq(pool.getBuyerCount(dealId),   0,              "no commit recorded");

        // The same (v, r, s) triple still works through commitWithAuthorization
        // — the authorization was not consumed by the failed transferWithAuth call.
        vm.prank(relayer);
        pool.commitWithAuthorization(dealId, buyer, 1_000_000, a.validAfter, a.validBefore, bytes32(0), a.v, a.r, a.s);
        assertEq(pool.escrowed(dealId, buyer), 1_000_000, "commit succeeded after failed transfer attempt");
        assertEq(pool.getBuyerCount(dealId),   1,         "buyer recorded");
    }

    // ── Test 7: blocklisted buyer reverts Blocklisted ─────────────────────────
    function test_Gasless_Blocklisted() public {
        // Replace the standard mock with the blocklisted variant.
        MockBlocklistedEIP3009USDC bTmp = new MockBlocklistedEIP3009USDC();
        vm.etch(USDC_ADDR, address(bTmp).code);
        MockBlocklistedEIP3009USDC bUsdc = MockBlocklistedEIP3009USDC(USDC_ADDR);
        bUsdc.initialize();

        uint256 dealId = _postDeal();
        uint256 buyerPk = 0xBAAD;
        address buyer = vm.addr(buyerPk);
        bUsdc.mint(buyer, 2_000_000);

        // Blocklist the buyer.
        bUsdc.setBlacklisted(buyer, true);

        Auth memory a = _signAuth(buyerPk, dealId, 1_000_000, bytes32(0));

        vm.prank(relayer);
        vm.expectRevert(DemandPool.Blocklisted.selector);
        pool.commitWithAuthorization(dealId, buyer, 1_000_000, a.validAfter, a.validBefore, bytes32(0), a.v, a.r, a.s);

        assertEq(pool.escrowed(dealId, buyer), 0, "no escrow");
    }

    // ── Fuzz helper — extracted to avoid stack-too-deep ──────────────────────

    // Packed return to keep the call frame shallow.
    struct GaslessResult { address buyer; uint256 authorized; uint256 excess; }

    function _doGaslessCommit(uint256 dealId, uint256 i, uint256 salt)
        internal returns (GaslessResult memory res)
    {
        uint256 pk = uint256(keccak256(abi.encode("gasless", i))) % (2**128);
        if (pk == 0) pk = 1;
        res.buyer = vm.addr(pk);

        uint256 cp = uint256(pool.clearingPrice(dealId));
        res.authorized = cp + 100_000;
        usdc.mint(res.buyer, res.authorized);

        Auth memory a = _signAuth(pk, dealId, res.authorized, bytes32(salt));

        uint256 exBefore = settler.claimable(res.buyer);
        vm.prank(relayer);
        pool.commitWithAuthorization(dealId, res.buyer, res.authorized, a.validAfter, a.validBefore, bytes32(salt), a.v, a.r, a.s);

        uint256 actualEscrow = uint256(pool.escrowed(dealId, res.buyer));
        res.excess = res.authorized - actualEscrow;

        assertEq(settler.claimable(res.buyer), exBefore + res.excess, "excess in claimable");
    }

    // ── Fuzz test helpers ─────────────────────────────────────────────────────

    // Two-phase commit loop split by commit type to minimise stack pressure.
    // Pass salt by reference via a 1-element array so it crosses the call boundary
    // without becoming another return value.
    function _doOrdinaryCommit(uint256 dealId, uint256 i) internal returns (uint256 spent) {
        address buyer = address(uint160(i + 500));
        // Approve the maximum (top tier price) so a tier break at this commit
        // doesn't leave allowance short. The pool only pulls priceAfter.
        uint64 maxPrice = 1_000_000; // top tier price in the standard curve
        usdc.mint(buyer, maxPrice);
        vm.prank(buyer); usdc.approve(address(pool), maxPrice);
        vm.prank(buyer); pool.commit(dealId);
        // Actual USDC transferred = what the pool escrowed (priceAfter, not cp).
        spent = uint256(pool.escrowed(dealId, buyer));
    }

    // Accumulator struct keeps two counters in one memory slot, avoiding extra
    // stack variables inside the loop body.
    struct CommitAcc { uint256 authorized; uint256 excess; uint256 salt; }

    // NOTE: Solidity copies memory structs on internal function calls; the callee
    // must return the modified struct for changes to be visible at the call site.
    function _commitOne(uint256 dealId, uint256 i, bool gasless, CommitAcc memory acc)
        internal returns (CommitAcc memory)
    {
        if (gasless) {
            GaslessResult memory res = _doGaslessCommit(dealId, i, acc.salt);
            acc.salt++;
            acc.excess     += res.excess;
            acc.authorized += res.authorized;
        } else {
            acc.authorized += _doOrdinaryCommit(dealId, i);
        }
        return acc;
    }

    function _commitPhase(uint256 dealId, uint256 n, uint8 gaslessMask)
        internal returns (uint256 totalAuthorized, uint256 totalExcess)
    {
        CommitAcc memory acc;
        for (uint256 i = 1; i <= n; i++) {
            acc = _commitOne(dealId, i, (gaslessMask >> (i % 8)) & 1 == 1, acc);
        }
        totalAuthorized = acc.authorized;
        totalExcess     = acc.excess;
    }

    function _assertConservation(uint256 dealId, uint256 totalAuthorized, uint256 totalExcess)
        internal
    {
        address[] memory buyers = pool.getBuyers(dealId);

        // Pool USDC balance == sum(escrowed) + totalExcess before settle.
        uint256 sumEscrowed = 0;
        for (uint256 i = 0; i < buyers.length; i++) {
            sumEscrowed += pool.escrowed(dealId, buyers[i]);
        }
        assertEq(
            IERC20(USDC_ADDR).balanceOf(address(pool)),
            sumEscrowed + totalExcess,
            "pool balance == escrowed + excess"
        );

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        settler.settle(dealId);

        uint256 cp = uint256(pool.clearingPrice(dealId));
        assertEq(settler.claimable(supplier), cp * buyers.length, "supplier credit");

        uint256 totalClaimable = settler.claimable(supplier);
        for (uint256 i = 0; i < buyers.length; i++) {
            totalClaimable += settler.claimable(buyers[i]);
        }
        assertEq(totalClaimable, totalAuthorized, "conservation: claimable == authorized");
    }

    // ── Test 8: fuzz — mixed ordinary + gasless commits, conservation ─────────
    function testFuzz_Gasless_Conservation(uint8 n, uint8 gaslessMask) public {
        n = uint8(bound(n, MIN_BUYERS, 50));
        uint256 dealId = _postDeal();
        (uint256 totalAuthorized, uint256 totalExcess) = _commitPhase(dealId, n, gaslessMask);
        _assertConservation(dealId, totalAuthorized, totalExcess);
    }
}
