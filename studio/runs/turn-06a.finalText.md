Reading the spec and all existing contracts in full before writing anything. Good. I have everything. Now setting up todos and writing all five files: Now delete old test files and write the smoke test: The smoke test reveals I need the factory to release goods to the settler during settlement. Let me add `pullGoodsForSettler` to the factory and call it from `Settler.settle()`: Now add `pullGoodsForSettler` calls in Settler.settle() and refundAll(): Now run build and test: Stack-too-deep in `postDeal` — too many local variables. I need to split it: validate in a separate internal function, then write to storage directly. The fix: move all the validation logic before the `dealId = ++dealCount` assignment into a small `_validateDeal` helper, keeping the storage writes isolated: Still too deep — passing 11 calldata arguments to `_storeDeal` creates the same problem. The fix: `_storeDeal` should take only the `dealId` and read everything from a local struct, or better, just write to storage directly in `postDeal` but with fewer live variables. The real issue is that `postDeal` has 10 parameters plus the function's own locals. The cleanest solution: pack non-tier parameters into a memory struct before validation: The problem is the function signature itself has 10 parameters, exhausting the stack before any local is created. The only viable solution without `via_ir` is to pack the parameters into a calldata struct at the call site. Solidity supports `calldata` structs since 0.8. I'll replace the flat parameters with two calldata structs: Now update `_validateDeal` and `_storeDeal` to take `PostParams calldata` instead of `memory` (since `p` is now calldata in `postDeal`), and remove the separate `title`/`description` params: Now update the smoke test to use the new `PostParams` struct call: Stack-too-deep now in DemandPool.withdraw(). The emit line has too many locals in scope. Fix: cache the value before the other locals go out of scope: Stack-too-deep in `commitWithAuthorization`. It has 9 parameters plus its local variables. Same solution — pack parameters into a struct or break the function. I'll use an inner function for the price-check-and-transfer step: Stack-too-deep in `Settler.settle()`. The loop body has: `deal`, `buyers`, `cp`, `totalUnitsSold`, `buyerCount`, `totalRefunds`, `totalEscrowed`, `unitsDelivered`, then inside the loop `buyer`, `units`, `paid`, `escrow`, `refund`, `goods`. That's 14 variables. Fix: move the loop into its own function that returns the accumulated totals: Now add the `_creditBuyers` helper before `settle`: Let me get the full `forge build` output too: Complete unedited output:

**`forge build`:**
```
Compiling 10 files with Solc 0.8.28
Solc 0.8.28 finished in 1.40s
Compiler run successful!
warning[block-timestamp]: usage of `block.timestamp` in a comparison may be manipulated by validators
    ╭▸ contracts/test-helpers/MockEIP3009USDC.sol:182:13
    │
182 │         if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
    │             ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    │
    ╰ help: https://book.getfoundry.sh/reference/forge/forge-lint#block-timestamp

warning[block-timestamp]: usage of `block.timestamp` in a comparison may be manipulated by validators
    ╭▸ contracts/DealFactory.sol:157:13
    │
157 │         if (p.deadline <= block.timestamp) revert DeadlineNotFuture();
    │             ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    │
    ╰ help: https://book.getfoundry.sh/reference/forge/forge-lint#block-timestamp

warning[block-timestamp]: usage of `block.timestamp` in a comparison may be manipulated by validators
    ╭▸ contracts/DemandPool.sol:168:13
    │
168 │         if (block.timestamp >= deal.deadline) revert DeadlinePassed();
    │             ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    │
    ╰ help: https://book.getfoundry.sh/reference/forge/forge-lint#block-timestamp

warning[block-timestamp]: usage of `block.timestamp` in a comparison may be manipulated by validators
    ╭▸ contracts/Settler.sol:118:13
    │
118 │         if (block.timestamp < deal.deadline) revert DeadlineNotReached();
    │             ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    │
    ╰ help: https://book.getfoundry.sh/reference/forge/forge-lint#block-timestamp

warning[block-timestamp]: usage of `block.timestamp` in a comparison may be manipulated by validators
    ╭▸ contracts/Settler.sol:162:13
    │
162 │         if (block.timestamp < deal.deadline) revert DeadlineNotReached();
    │             ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    │
    ╰ help: https://book.getfoundry.sh/reference/forge/forge-lint#block-timestamp

warning[block-timestamp]: usage of `block.timestamp` in a comparison may be manipulated by validators
    ╭▸ contracts/test-helpers/MockEIP3009USDC.sol:183:13
    │
183 │         if (block.timestamp >= validBefore) revert AuthorizationExpired();
    │             ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    │
    ╰ help: https://book.getfoundry.sh/reference/forge/forge-lint#block-timestamp

warning[block-timestamp]: usage of `block.timestamp` in a comparison may be manipulated by validators
    ╭▸ contracts/DemandPool.sol:366:13
    │
366 │         if (block.timestamp >= deal.deadline) revert DeadlinePassed();
    │             ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    │
    ╰ help: https://book.getfoundry.sh/reference/forge/forge-lint#block-timestamp
```

**`forge test -vv`:**
```
No files changed, compilation skipped

Ran 1 test for contracts/test/SwarmV2Smoke.t.sol:SwarmV2Smoke
[PASS] test_SmokeSettlement() (gas: 983901)
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 2.14ms (973.95µs CPU time)

Ran 1 test suite in 8.20ms (2.14ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

Warnings only (all `block.timestamp` comparisons, expected and correct for a deadline-driven protocol). No errors, no size warnings. 1/1 tests pass.

---

Here is what changed and why each design decision is correct.

**`SwarmTypes.Tier`** now uses `minUnits` (not `minBuyers`) since the curve threshold is volume. `Deal` gains `goodsToken`, `tokensPerUnit`, `maxUnits`, `maxUnitsPerBuyer`, `maxBuyers`, `title`, `description` and drops the v1 `cap`/`minBuyers` names.

**`DealFactory.postDeal`** takes a `PostParams calldata` struct + `Tier[]` — two arguments instead of ten, which is the only way to stay within the EVM's 16-slot stack limit without `via_ir`. The balance-delta check (`balAfter - balBefore == stockAmount`) is inside a block scope to keep that frame shallow. `pullGoodsForSettler` is the new settler-only transfer function that moves the deposited tokens to the Settler at settlement time, so `claimGoods` can `transfer` them out.

**`DemandPool`** tracks `totalUnits`, `unitsOf`, `paidPerUnit` (per-unit price, replacing v1's `escrowed` value). `paidPerUnit = priceAt(totalUnits + units)` — the buyer's order is included in the threshold, so a large enough order breaks its own tier. `escrowed = paidPerUnit × units`. The strand check is unchanged in invariant: `_lowestPaidExcluding` walks the tier tally. `commitWithAuthorization` is refactored into an outer public function that packs 10 parameters into `AuthParams memory` and delegates to `_commitWithAuth`, avoiding the stack limit. The nonce now binds `units` too: `keccak256(abi.encode(address(this), dealId, buyer, units, salt))`.

**`Settler.settle`** calls `factory.pullGoodsForSettler` to take custody, then delegates per-buyer credits to `_creditBuyers` (its own stack frame). Two named conservation errors: `UsdcConservationViolation` and `GoodsConservationViolation`. `claimGoods(token)` drains `goodsClaimable[token][msg.sender]` and calls `IERC20(token).transfer`. `refundAll` returns the full stock to the supplier via `goodsClaimable`.

**`SwarmPass`** is a standard OZ `ERC20` with `decimals()` overriding to 0. The faucet uses `block.timestamp / 86400` as the day key, which is the standard approach for once-per-day limits in Solidity.