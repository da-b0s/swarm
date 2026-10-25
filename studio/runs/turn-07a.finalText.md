Reading the spec first, then all relevant contract files. Now read all three existing test files: Now I have a complete picture of everything. Let me set up the todos and start working: Now I'll rewrite `DemandPool.sol` with the top-up logic: Now update Settler — change the refund calculation from `(paid - cp) * units` to `escrowed - cp * units`: The `paid` variable on line 100 is now unused. Remove it: Now update `SwarmV2Test` — the `test_Order_AlreadyCommitted` test asserts the old behaviour (second commit reverts). With v2.1 a second commit is a valid top-up, so that test must change. Replace it with a test that verifies a top-up succeeds: The `test_WorkedExample` asserts single-lot buyers, and the refund formula changed from `(paid - cp) * units` to `escrowed - cp * units`. For a single lot these are identical (since `escrowed = paid * units`), so those assertions are still correct. Now write the new test file: Now run `forge test` over the complete suite: Stack too deep in `_doCommit`. The issue is the `isTopUp` bool, `priceBefore`, `lotPricePerUnit`, `lotEscrow`, `oldPaid` all on the stack together. I need to split the function. I'll extract the top-up path into a separate private function: One test fails: `test_TopUp_SettleRefundExact` — B2 has zero refund so `settler.claim()` reverts `NothingToClaim`. Fix by skipping B2's claim when they have nothing claimable: All 56 tests pass. There's a harmless variable shadowing warning in the withdraw function — fix it now: Clean compile, 56/56 pass, no warnings. **56/56 tests pass. Complete unedited forge output above.**

---

Here is exactly what changed and why:

**`contracts/DemandPool.sol`**

- `AlreadyCommitted` error removed — no longer reachable from ordering (still definable, but since nothing uses it, removed cleanly).
- `_checkCommitPreconditions` gains an `isTopUp bool` parameter. When `true`, the `maxBuyers` check is skipped (the buyer is already counted); the `maxUnitsPerBuyer` check uses `unitsOf[buyer] + units` (total across lots) instead of just `units`.
- `_doCommit` now detects whether the buyer is new or a top-up by reading `_buyerIndex`. The stack-depth issue from having both paths inline was resolved by extracting `_recordNewBuyer` and `_recordTopUp` as separate private helpers. `_recordTopUp` accumulates `unitsOf` and `escrowed`, and moves the `tierCount` tally entry from the old `paidPerUnit` to the new one when the lot price is cheaper.
- `commit` and `_commitWithAuth` both derive `isTopUp` before calling `_checkCommitPreconditions`.
- `withdraw` now reads `paid = paidPerUnit[dealId][msg.sender]` before the strand check (removing the shadowing warning) and uses that as the tally-exclusion key. Behaviour is unchanged — it still removes the whole order and credits the full accumulated escrow.

**`contracts/Settler.sol`**

- `_creditBuyers`: refund formula changed from `(paid - cp) * units` to `escrow - cp * units`. The `paid` read is removed (unused). For single-lot buyers these are identical since `escrow = paid * units`; for multi-lot buyers the escrow already sums `(lotPrice_i × lotUnits_i)` across every lot, so subtracting `cp × totalUnits` gives the exact total overpayment.

**`contracts/test/SwarmV2Test.t.sol`**

- `test_Order_AlreadyCommitted` replaced with `test_Order_TopUpAddsLot`. The old test expected `AlreadyCommitted` to revert on a second commit, which is no longer the contract behaviour. The new test confirms a second commit by the same buyer adds a lot and updates `unitsOf`.

**`contracts/test/SwarmV2TopUpTest.t.sol` — 11 new tests:**

| Test | What it covers |
|---|---|
| `test_TopUp_AfterTierBreak_LotPriceDrops` | Top-up at lower price: `paidPerUnit` drops, `escrowed` and `unitsOf` sum |
| `test_TopUp_SelfBreaksTier` | Top-up that itself crosses a tier pays the new lower price |
| `test_TopUp_PerBuyerLimitAcrossLots` | `maxUnitsPerBuyer` counts total units (lot1 + lot2) |
| `test_TopUp_StockLimitApplies` | Stock cap blocks a top-up that would exceed `maxUnits` |
| `test_TopUp_MaxBuyersDoesNotBlockExistingBuyer` | `maxBuyers` is not checked on a top-up |
| `test_Strand_TopUpKeepsStrandRuleValid` | Top-up at the same tier price; B1 can then withdraw without stranding B2 |
| `test_Strand_WithdrawRefusedThenPermittedAfterTopUp` | Withdrawal refused, B2 tops up to keep tier, B1 can then withdraw |
| `test_TopUp_WithdrawReturnsFullEscrow` | Withdraw after two lots credits the full combined escrow |
| `test_TopUp_SettleRefundExact` | Settlement refund = `escrowed - cp × units` computed exactly for a two-lot buyer |
| `test_TopUp_GaslessTopUp` | Gasless `commitWithAuthorization` adds a lot the same way |
| `testFuzz_TopUp_Conservation` | Random orders, top-ups, withdrawals through settlement; USDC and goods conservation, no negative refunds, both contracts empty after all claims |