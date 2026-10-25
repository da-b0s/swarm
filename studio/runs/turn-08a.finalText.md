Reading the spec and all contract source before writing anything. Now read all three test files: Now I have a complete picture. Let me also check the test-helpers for the blocklisted mock: Good. Now I have everything I need. Let me plan carefully:

**v2.2 changes needed:**
1. `DemandPool.withdraw(dealId, units)` — new signature with units param; partial vs full logic; immediate USDC payout via low-level call with settler fallback; new `Withdrawn` event signature
2. `Settler.creditWithdrawal` — already exists, just used differently (fallback only now)
3. New `WithdrawInvalidUnits` error for 0 or > unitsOf
4. Update existing tests that call `pool.withdraw(d)` (now `pool.withdraw(d, unitsOf)` for full) and decode old `Withdrawn` event
5. New test file

The key design points from spec:
- `returned = escrowed × units / unitsOf` (rounded down, proportional)
- For partial: keep `paidPerUnit` and tally unchanged; only reduce `escrowed`, `unitsOf`, `totalUnits`
- For full: existing cleanup (remove from buyer list, clear tally entry, clear all mappings)
- Strand check: `priceAt(totalUnits − units)` must not exceed any remaining buyer's `paidPerUnit` — for partial this includes the caller
- Immediate payout: low-level `call` on USDC, check success + returned bool; fallback to `ISettler.creditWithdrawal`
- New event: `Withdrawn(dealId, buyer, units, amountReturned, paidDirectly, livePrice, totalUnits, buyerCount)`
- `TierBroken` emitted when price changes

Now set up todos and start writing: Now update the existing test files. First `SwarmV2Test.t.sol` — all calls to `pool.withdraw(d)` need `pool.withdraw(d, units)`, and any assertion that expects `settler.claimable` to be funded should now expect the USDC in the buyer's wallet: Now I need to audit every `pool.withdraw` call across all three existing test files and update them. Key changes:
1. `pool.withdraw(d)` → `pool.withdraw(d, pool.unitsOf(d, buyer))`
2. After a full withdrawal, the old tests assert `settler.claimable` grew — now the USDC goes directly to the buyer's wallet
3. The `Withdrawn` event signature changed: new fields `units`, `paidDirectly`

Let me identify all occurrences: Now let me update each file. Starting with `SwarmV2Test.t.sol`:

**SwarmV2Test changes:**
- Line 496: `pool.withdraw(d)` — this is the `vm.expectRevert` test, B1 tries to withdraw and should fail. Change to `pool.withdraw(d, pool.unitsOf(d, B1))` but wait — B1's units is 5 and it's inside `vm.prank(B1)`. Actually the test is `vm.prank(B1); vm.expectRevert(DemandPool.WouldStrandBuyer.selector); pool.withdraw(d)` — just needs the units arg.
- Line 502: B1 withdraws successfully. Old test doesn't check claimable, just checks `totalUnits`.
- Line 511: B1 withdraws (single buyer). Old test checks `totalUnits(d) == 0`.
- Line 730: fuzz test — `vm.prank(buyer); pool.withdraw(d)` — needs `pool.unitsOf(d, buyer)` passed.

The fuzz test at line 728–731 was:
```solidity
uint256 escrow = pool.escrowed(d, buyer);
vm.prank(buyer); pool.withdraw(d);
totalCommitted -= escrow;
```
After the change, the USDC goes directly to the buyer's wallet (not claimable), so `totalCommitted -= escrow` is still correct conceptually. But the claim at line 758 drains withdrawn buyers' claimable — this now won't have anything from withdrawals, which is fine. Now update the fuzz test in `SwarmV2Test.t.sol` (line 730): The fuzz test at ~line 755 drains "withdrawn buyers' claimable" — now those buyers got their USDC directly so `settler.claimable(b)` will be 0. The claim loop `if (settler.claimable(b) > 0) settler.claim()` is safe since it's gated. No change needed there.

Now update `SwarmV2GaslessTest.t.sol` line 261: Now update `SwarmV2TopUpTest.t.sol` — all `pool.withdraw(d)` calls need units: Now I see all the changes needed. The `test_TopUp_WithdrawReturnsFullEscrow` test checked `settler.claimable` — now it should check the buyer's wallet balance. Also the fuzz test at line 545. Let me also check the withdraw-in-fuzz: Now I'll make all the updates to `SwarmV2TopUpTest.t.sol`: Now update `test_TopUp_WithdrawReturnsFullEscrow` — the test previously asserted `settler.claimable` grew. Now the USDC goes directly to the buyer's wallet: Now update the fuzz test in `SwarmV2TopUpTest`: Good. Now write the new partial-withdraw test file: Now run the full test suite: Compile succeeded, forge test is still running. Check the all-log: The background process already exited but forge test itself was still running. Let me run forge test directly: The log is truncated — forge test output isn't being written to the file. The issue is `2>&1 >` ordering. Let me fix the redirect: Two issues: (1) long NatSpec comment with `$1.00` triggers a doc tag error — split it up; (2) `_ = myPaid` isn't valid Solidity — use `myPaid;` or just remove it. Let me fix both: The comment block starts at line 366. I need to replace lines 366–421 with the shorter comment. The simplest fix is to rewrite the whole function block: The rest of the old comment is still there. I need to remove lines 371 through 421 (the remaining NatSpec lines before the `function` declaration): I need to remove lines 371-425 (the old `///` NatSpec lines that remain after my partial replacement). Let me do a targeted edit: Now fix the `_ = myPaid` syntax error in the fuzz test: That `(myPaid);` is also not valid Solidity for suppressing unused variable warnings — just remove the `myPaid` variable declaration entirely since it isn't used in the strand check: Now run forge test again: 8 failures to analyse:

1. **`NotCommitted`** errors on `test_GL_PriceRose`, `test_Strand_TopUpKeepsStrandRuleValid`, `test_TopUp_WithdrawReturnsFullEscrow`, `test_Strand_TopUpKeepsStrandRuleValid` — these call `pool.withdraw(d, pool.unitsOf(d, buyer))` but the buyer isn't committed. The issue: `pool.unitsOf(d, buyer)` on a non-committed buyer returns 0, so `withdraw(d, 0)` hits `WithdrawInvalidUnits` before `NotCommitted`. Wait actually it hits `NotCommitted` first. But actually for `test_GL_PriceRose` the tierer called `withdraw(d, pool.unitsOf(d, tierer))` where `tierer` is a named constant address — not a vm.addr key. Let me check: `tierer = address(0x5002)` and `pool.unitsOf(d, tierer)` — tierer committed 10 units, so `unitsOf = 10`. Actually the test fails with `NotCommitted` which means `_buyerIndex` is 0. Oh wait — `tierer` committed with `vm.prank(tierer)` which doesn't use a private key. The `unitsOf` read returns the correct value. But wait, `pool.withdraw(d, pool.unitsOf(d, tierer))` — maybe `pool.unitsOf(d, tierer)` returns 0 because `tierer` is `address(0x5002)` and this is correct... The `_buyerIndex` check fires first. Hmm.

Actually re-reading the failing tests more carefully:

- `test_GL_PriceRose`: `vm.prank(tierer); pool.withdraw(d, pool.unitsOf(d, tierer))` — `tierer` DID commit 10 units. The `NotCommitted` error shouldn't happen unless the `pool.unitsOf()` call itself is somehow returning 0 and then `withdraw(d, 0)` fires `WithdrawInvalidUnits`, then the contract check order... wait, my contract checks `if (units == 0 || units > myUnits) revert WithdrawInvalidUnits()` AFTER `if (buyerPos == 0) revert NotCommitted()`. So `NotCommitted` fires before `WithdrawInvalidUnits`. So the buyer IS NOT in the pool when `withdraw` is called... But they should be.

Oh! I see the issue. In the new `withdraw(dealId, units)`, `_removeBuyer` uses `buyerPos` BEFORE any cleanup. But actually let me re-read — oh I see: I check `_buyerIndex` AFTER the check. No wait: `buyerPos = _buyerIndex[dealId][msg.sender]` and then `if (buyerPos == 0) revert NotCommitted()`. That should work for anyone who committed.

Let me trace through `test_GL_PriceRose` more carefully: tierer commits 10 units at line 253, then `vm.prank(tierer); pool.withdraw(d, pool.unitsOf(d, tierer))` at line 262. The `pool.unitsOf(d, tierer)` is called INSIDE the test code (not inside the prank context). The prank only applies to the next state-changing call, not view calls. So `pool.unitsOf(d, tierer)` returns 10 correctly. Then `withdraw(d, 10)` is called with `vm.prank(tierer)` — `msg.sender` is tierer, `_buyerIndex[d][tierer]` should be 1. So `NotCommitted` shouldn't fire.

Unless... the `withdraw` function signature change causes ABI confusion. Let me check: the old function was `withdraw(uint256)` and the new is `withdraw(uint256, uint32)`. The selector is different. In Solidity tests with `pool.withdraw(d, pool.unitsOf(d, tierer))` — `pool.unitsOf` returns `uint32`. So this is `pool.withdraw(uint256, uint32)` which matches the new signature exactly.

Actually wait — could this be a stale artifact? Let me run just those specific failing tests with `-vvvv` to see the stack trace:

2. **`next call did not revert as expected`** on strand tests — the tests now call `pool.withdraw(d, pool.unitsOf(d, B1))` in the expectRevert block but with the new signature the strand check might behave differently for a full withdrawal with 2 buyers vs. the old logic.

3. **`pool has no remaining escrow: 6000000 != 0`** on `test_PartialWithdraw_Rounding_SettlementExact` — the buyer commits two lots (5 units then 4 units = 9 units total at $1.00) then partially withdraws 3, leaving 6 units and $6 escrowed. The pool HAS the $6 still (it was not transferred out because those funds are still in pool for settlement). The test asserts `pool.escrowed(d, B1) == 0` after settle — but `pool.escrowed` is the mapping in `DemandPool`, not a post-settle cleared thing. The settler calls `pool.escrowed(d, buyer)` to read the escrow but never clears it (that's expected — it's an immutable record). The `assertEq(pool.escrowed(d, B1), 0, "pool has no remaining escrow")` assertion is wrong in my test — it should assert the pool's USDC balance is 0, not the escrowed mapping. Let me fix that test.

4. **`log mismatch at param 4`** on the blocklisted test — the event's `paidDirectly` param is `true` (1) but expected `false` (0). This means the direct transfer SUCCEEDED even though the buyer is blocklisted. The `MockBlocklistedEIP3009USDC`'s `transfer()` method may not revert for blocklisted addresses — it might just return `false`. Actually looking at my `_tryDirectTransfer`: I decode the returned bool. If `transfer` returns `false` for a blocklisted address, `callOk=true` but `ret` decodes to `false`, so `_tryDirectTransfer` returns `false`. But if the mock's `transfer` REVERTS instead of returning false, then `callOk=false` and we fall back. The mock might not have `transfer` return false for blocklisted — it may handle blocklisting only in `transferFrom` or `receiveWithAuthorization`.

Let me run specific tests with verbosity to understand: Now I can see the real issues clearly:

**`test_PartialWithdraw_StrandRule_Full`** — The test calls:
```
vm.expectRevert(WouldStrandBuyer);
pool.unitsOf(d, B1)  // THIS IS THE CALL THAT REVERTS/DOESN'T BECAUSE expectRevert consumed the next call
pool.withdraw(d, ...)
```
The issue: `vm.expectRevert` is set, then `pool.unitsOf(d, B1)` is a `staticcall` that SUCCEEDS (returns 5), which means the next call DID NOT revert — consuming the `expectRevert`. I need to capture units BEFORE setting `expectRevert`.

**`test_Strand_RefusedThenPermitted` (SwarmV2Test)** — Same pattern: `vm.expectRevert(...)` then `pool.withdraw(d, pool.unitsOf(d, B1))`. The `pool.unitsOf` staticcall is the "next call" that gets caught by expectRevert (it doesn't revert, so Foundry reports "next call did not revert as expected").

**`test_Strand_TopUpKeepsStrandRuleValid`, `test_Strand_WithdrawRefusedThenPermittedAfterTopUp`, `test_TopUp_WithdrawReturnsFullEscrow`** — `NotCommitted` error means `pool.unitsOf()` is called as part of the `withdraw` argument, but since B1 was already removed by a prior successful `pool.withdraw(d, pool.unitsOf(d, B1))`, subsequent reads return 0 and the contract fails validation. Actually no, looking at them: in `test_Strand_TopUpKeepsStrandRuleValid`, B1 has 5 units. The call is `vm.prank(B1); pool.withdraw(d, pool.unitsOf(d, B1))`. The `pool.unitsOf(d, B1)` is evaluated BEFORE the prank-wrapped call... actually the entire expression `pool.withdraw(d, pool.unitsOf(d, B1))` evaluates `pool.unitsOf(d, B1)` first as a view call (staticcall, no prank needed), returns 5, then calls `pool.withdraw(d, 5)` with the prank. So this should work. Why `NotCommitted`? Let me re-read `test_Strand_TopUpKeepsStrandRuleValid`:

```solidity
_fund(B1, 10_000_000); _commit(B1, d, 5);   // B1 has 5 units
_fund(B2, 20_000_000); _commit(B2, d, 8);   // B2 has 8 units, breaks tier
_commit(B2, d, 2);                           // top-up: B2 now has 10 units
// B1 tries to withdraw
vm.prank(B1); pool.withdraw(d, pool.unitsOf(d, B1));
```

`pool.unitsOf(d, B1)` = 5. The new `withdraw(d, 5)` with B1. B1 is committed (buyerPos != 0). `myUnits = 5`. `isFull = true`. `newTotal = 15 - 5 = 10`. `newPrice = priceAt(10) = $0.75`. Strand check: `_buyers.length > 1 || !isFull` → `2 > 1 = true`. `isFull = true` → use `_lowestPaidExcluding(dealId, tiers, paid=B1.paidPerUnit=$1.00)`. `_lowestPaidExcluding` scans tiers from highest: tier[1].pricePerUnit=$0.75, count=tierCount[$0.75]=1 (B2). tp != excludePrice ($1.00). cnt=1 > 0 → return $0.75. `lowest=$0.75`. `lowest > 0 && lowest < newPrice($0.75)` → `0.75 < 0.75 = false`. No strand! Should NOT revert. But the test says `NotCommitted`. This is very strange.

Wait — I must re-read. The error is `NotCommitted`, not `WouldStrandBuyer`. That means `_buyerIndex[dealId][B1] == 0`. But B1 committed with `_commit(B1, d, 5)`. Unless... the test setup deploys `pool` with `vm.prank(OWNER)` but `factory = new DealFactory(OWNER)` etc., and `pool.setSettler` is called on a NEW pool — but `_commit` uses the same `pool` instance. Let me re-check `test_TopUp_WithdrawReturnsFullEscrow`:

```
_commit(B1, d, 5); // escrowed=5*$1=$5
_commit(B1, d, 8); // escrowed+=8*$0.75=$6 → total=$11
vm.prank(B1); pool.withdraw(d, pool.unitsOf(d, B1));
```

`pool.unitsOf(d, B1) = 13`. Call `pool.withdraw(d, 13)`. B1 is committed. This should work. `NotCommitted` is bizarre.

Oh wait! I just realized: **`vm.prank` only applies to exactly one call, but `pool.unitsOf(d, B1)` is evaluated as an argument — it IS a call that happens inside the same transaction context**. In Solidity/Foundry, when you write:

```solidity
vm.prank(B1);
pool.withdraw(d, pool.unitsOf(d, B1));
```

Foundry evaluates `pool.unitsOf(d, B1)` FIRST (as a separate EVM call), which consumes the `vm.prank(B1)` prank context! Then `pool.withdraw(d, 13)` is called without a prank, so `msg.sender` is the test contract address, not B1. The test contract has `_buyerIndex = 0` → `NotCommitted`.

This is the root cause of ALL the `NotCommitted` failures. The fix: pre-capture `unitsOf` into a local variable before setting the prank.

And for the `vm.expectRevert` + `pool.unitsOf` issue: `pool.unitsOf` is called AFTER `vm.expectRevert`, consuming the expectation on a view call that doesn't revert.

Let me fix all occurrences: Now fix `SwarmV2GaslessTest.t.sol` `test_GL_PriceRose`: Now fix all the `SwarmV2TopUpTest.t.sol` withdraw calls: Now fix the fuzz test in `SwarmV2TopUpTest`: Good. Now fix the remaining issues in `SwarmV2PartialWithdrawTest.t.sol`:

**Issue 1**: `test_PartialWithdraw_StrandRule_Full` — `vm.expectRevert` followed by `pool.withdraw(d, pool.unitsOf(d, B1))`. Fix: pre-capture units.

**Issue 2**: `test_PartialWithdraw_Rounding_SettlementExact` — The test asserts `assertEq(pool.escrowed(d, B1), 0, "pool has no remaining escrow")` but `pool.escrowed` is a mapping that is never cleared after settlement. The USDC moved to settler via `pullForSettler`. Change assertion to check pool's USDC balance is 0.

**Issue 3**: `test_PartialWithdraw_Blocklisted_FallsBackToClaimable` — The blocklisted mock's `transfer()` apparently SUCCEEDS for a blocklisted buyer (returns true), not reverts. The spec says "only if transfer fails" — so the mock doesn't block `transfer`. Let me check `MockBlocklistedEIP3009USDC` — it only blocks `receiveWithAuthorization` and `isBlacklisted`. The `transfer()` call goes through. The fallback only triggers when transfer actually fails. I need to use a different approach: write a mock that makes `transfer` fail for the blacklisted address, or test this differently. The cleanest fix is to write a lightweight USDC mock that makes `transfer` return false for a blacklisted recipient, or just revert. Let me check what the existing mock has: As expected — it only overrides `isBlacklisted`, not `transfer`. The `transfer()` method still works normally for blocklisted addresses. The `_tryDirectTransfer` will succeed. 

For a proper test of the fallback, I need a USDC mock where `transfer` returns `false` or reverts for a blocklisted address. The cleanest fix: override `transfer` in `MockBlocklistedEIP3009USDC` to return false when the `to` address is blacklisted. But that's a test-helper change. I can also write an inline mock in the test file using a `vm.mockCall`.

Actually the simplest approach: use `vm.mockCall` to make the USDC `transfer(B1, amount)` return `false`. Let me rewrite the blocklisted test to use this approach instead of redeploying: I need to make the blocklisted test use a mock where `transfer` actually fails. The simplest approach: override `transfer` in `MockBlocklistedEIP3009USDC` to return false when recipient is blocklisted. Let me update the test helper: Now fix `test_PartialWithdraw_Rounding_SettlementExact` — the wrong assertion `pool.escrowed(d, B1) == 0` after settlement. The `pool.escrowed` mapping is not cleared by the settler — it's an informational mapping. Change to assert pool USDC balance is 0: Line 363: `assertEq(pool.escrowed(d, B1), 0, "pool has no remaining escrow")` — `pool.escrowed` is not cleared by settlement (only the USDC moves). Fix: change to check the pool's USDC balance: Now fix `test_PartialWithdraw_StrandRule_Full` — the `vm.expectRevert` followed by argument evaluation: Now I need to check: why is `test_PartialWithdraw_StrandRule_Full` failing with "next call did not revert as expected"? B1 has 5 units at $1.00. B2 has 8 units at $0.75. `pool.unitsOf(d, B1) = 5`. `withdraw(d, 5)`: `buyerPos = 1` (not zero), `myUnits = 5`, `units = 5`, `isFull = true`, `newTotal = 13 - 5 = 8`, `newPrice = priceAt(8) = $1.00`. Strand check: `_buyers.length > 1 (2 > 1 = true) || !isFull (false)` → true. `isFull = true` → `_lowestPaidExcluding(d, tiers, paid=B1.paidPerUnit=$1.00)`. Looking at `_lowestPaidExcluding`: tiers in reverse are [$0.75, $1.00]. Tier[1] pricePerUnit=$0.75. `tp=$0.75`. `cnt = tierCount[$0.75]`. How many buyers at $0.75? B2 paid $0.75 → `tierCount[$0.75] = 1`. `tp ($0.75) == excludePrice ($1.00)`? No. `cnt = 1 > 0` → return $0.75. `lowest = $0.75`. `lowest > 0 && lowest < newPrice ($1.00)` → `0.75 < 1.00 = true` → `revert WouldStrandBuyer`. 

So it SHOULD revert. But the test fails "next call did not revert as expected". Looking at the trace again — the test had `pool.unitsOf(d, B1)` evaluated as an argument AFTER `vm.prank(B1)`, which consumed the prank on the view call. Then `pool.withdraw(d, 5)` was called without prank (test contract as msg.sender). Test contract is not committed → `NotCommitted`. But the log says "next call did not revert as expected" for this test which implies it didn't fail with `WouldStrandBuyer`. Wait, the trace showed `[FAIL: next call did not revert as expected] test_PartialWithdraw_StrandRule_Full` — so the call did NOT revert. Let me re-check: the `pool.unitsOf` call happens, consumes the expectRevert, and returns 5. Then `pool.withdraw(d, 5)` is the next call which gets executed without an expectRevert wrapper — it may or may not revert. Actually, with `vm.prank(B1)` consumed by `pool.unitsOf`, the `pool.withdraw` runs as the test contract (address 0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496 or similar). The test contract has no buyerIndex → `NotCommitted`. So `pool.withdraw` DID revert, just with `NotCommitted` not `WouldStrandBuyer`. Foundry reports "next call did not revert as expected" when the revert selector doesn't match.

My fix reads `pool.unitsOf(d, B1)` before the prank/expectRevert, so now it will work correctly. Let me now run the tests again: The EIP-3009 mock uses OZ ERC20 which doesn't expose `transfer` the way I expected. Let me check: `MockEIP3009USDC` extends `MockERC20`. `MockERC20` is an OZ ERC20 with `mint()`. `ERC20.transfer` is defined in OZ ERC20. It should be callable via `super.transfer`. The issue might be that OZ `transfer` is not `virtual` at the right inheritance level, or the function signature differs. Let me use `ERC20.transfer` directly: Down to 1 failing test. `test_PartialWithdraw_Rounding_SettlementExact` — pool USDC balance is 6_000_000 after settle. This is expected: the pool holds the $6 that B1 still has escrowed (after the partial withdrawal). Settlement calls `settler.settle(d)` which calls `pool.pullForSettler` to move funds from pool to settler. But wait — `Settler.claim()` calls `pool.pullForSettler`, not `settle`. `settle` calls `factory.pullGoodsForSettler` (for the goods token, not USDC). For USDC, the pool holds the money; when buyers claim, they call `settler.claim()` which calls `pool.pullForSettler`. Since the test doesn't call `settler.claim()` after settling, the USDC stays in the pool.

The test just needs to additionally call `settler.claim()` to drain the pool, or assert `settler.claimable(SUPPLIER)` directly without checking pool balance. The test's purpose is to confirm that `claimable(B1) == 0` (no refund when escrow divides evenly) and `claimable(SUPPLIER) == 6_000_000`. Let me fix by removing the pool USDC balance assertion (it's fine to be non-zero before claims) or by draining first: **67/67 pass.** Let me read the full log header to paste the complete output: **Complete unedited `forge test` output:**

```
Compiling 1 files with Solc 0.8.28
Solc 0.8.28 finished in 2.03s
Compiler run successful with warnings:
Warning (2018): Function state mutability can be restricted to pure
  --> contracts/test/SwarmV2PartialWithdrawTest.t.sol:70:5:
   |
70 |     function _usdc() internal view returns (MockERC20) {
   |     ^ (Relevant source part starts here and spans across multiple lines).


Ran 1 test for contracts/test/SwarmV2Smoke.t.sol:SwarmV2Smoke
[PASS] test_SmokeSettlement() (gas: 982894)
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 2.41ms (1.19ms CPU time)

Ran 9 tests for contracts/test/SwarmV2GaslessTest.t.sol:SwarmV2GaslessTest
[PASS] testFuzz_V2Gasless_Conservation(uint8,uint8) (runs: 256, μ: 2546649, ~: 2116872)
[PASS] test_GL_Blocklisted() (gas: 1297765)
[PASS] test_GL_PriceFalls_ExcessCredited() (gas: 892274)
[PASS] test_GL_PriceRose() (gas: 671392)
[PASS] test_GL_Replay() (gas: 678159)
[PASS] test_GL_SignerRecorded() (gas: 675417)
[PASS] test_GL_TransferWithAuthCannotCommit() (gas: 683753)
[PASS] test_GL_UnitsBound() (gas: 447482)
[PASS] test_GL_WrongDeal() (gas: 694267)
Suite result: ok. 9 passed; 0 failed; 0 skipped; finished in 586.10ms (593.97ms CPU time)

Ran 35 tests for contracts/test/SwarmV2Test.t.sol:SwarmV2Test
[PASS] testFuzz_V2_Conservation(uint8,uint8) (runs: 256, μ: 2246466, ~: 1748113)
[PASS] test_Claims_ReentrantGoods() (gas: 1268897)
[PASS] test_Claims_SecondClaimGoodsReverts() (gas: 819794)
[PASS] test_Claims_SecondClaimReverts() (gas: 1079231)
[PASS] test_GasBound_Settle100() (gas: 21574922)
[PASS] test_Order_IncrementalPriceFalls() (gas: 939814)
[PASS] test_Order_MaxBuyersCap() (gas: 982923)
[PASS] test_Order_MaxUnitsPerBuyer() (gas: 482430)
[PASS] test_Order_TierBreakByOwnOrder() (gas: 709008)
[PASS] test_Order_TopUpAddsLot() (gas: 759990)
[PASS] test_Order_UnitCapReached() (gas: 690025)
[PASS] test_Order_ZeroUnits() (gas: 479649)
[PASS] test_Post_DeadlineNotFuture() (gas: 96917)
[PASS] test_Post_InvalidGoodsToken_USDC() (gas: 17144)
[PASS] test_Post_InvalidGoodsToken_Zero() (gas: 16953)
[PASS] test_Post_InvalidTierCount_Eleven() (gas: 101171)
[PASS] test_Post_InvalidTierCount_Zero() (gas: 93643)
[PASS] test_Post_LastTierExceedsMax() (gas: 98263)
[PASS] test_Post_MaxBuyersOutOfRange_101() (gas: 96491)
[PASS] test_Post_MaxBuyersOutOfRange_Zero() (gas: 96026)
[PASS] test_Post_MinUnitsExceedsMax() (gas: 107365)
[PASS] test_Post_MinUnitsZero() (gas: 95196)
[PASS] test_Post_PriceCapExceeded() (gas: 94521)
[PASS] test_Post_TierMinUnitsExceedsMin() (gas: 95020)
[PASS] test_Post_TiersNotAscending() (gas: 96042)
[PASS] test_Post_TiersNotDescending() (gas: 96625)
[PASS] test_Post_TitleEmpty() (gas: 97106)
[PASS] test_Post_UnsupportedToken_FeeOnTransfer() (gas: 585488)
[PASS] test_Post_ZeroTierPrice() (gas: 94369)
[PASS] test_Refund_BelowMinUnits() (gas: 1015361)
[PASS] test_Refund_NobodyOrdered() (gas: 427600)
[PASS] test_Refund_SettleRevertsWhenBelowMin() (gas: 729142)
[PASS] test_Strand_RefusedThenPermitted() (gas: 1123994)
[PASS] test_Strand_SingleBuyerCanAlwaysWithdraw() (gas: 647187)
[PASS] test_WorkedExample() (gas: 1628383)
Suite result: ok. 35 passed; 0 failed; 0 skipped; finished in 651.44ms (675.06ms CPU time)

Ran 11 tests for contracts/test/SwarmV2PartialWithdrawTest.t.sol:SwarmV2PartialWithdrawTest
[PASS] testFuzz_PartialWithdraw_Conservation(uint8,uint8,uint8,uint8) (runs: 256, μ: 1919012, ~: 1578820)
[PASS] test_FullWithdraw_PaidToWallet() (gas: 576976)
[PASS] test_MultiLot_PartialWithdraw_ThenSettle() (gas: 1113415)
[PASS] test_PartialWithdraw_Blocklisted_FallsBackToClaimable() (gas: 6641726)
[PASS] test_PartialWithdraw_MoreThanHeld_Reverts() (gas: 611233)
[PASS] test_PartialWithdraw_ReturnsAverageToWallet() (gas: 681174)
[PASS] test_PartialWithdraw_Rounding_NoUnderflow() (gas: 766619)
[PASS] test_PartialWithdraw_Rounding_SettlementExact() (gas: 843350)
[PASS] test_PartialWithdraw_StrandRule_Full() (gas: 900793)
[PASS] test_PartialWithdraw_StrandRule_Partial() (gas: 956259)
[PASS] test_PartialWithdraw_ZeroUnits_Reverts() (gas: 611232)
Suite result: ok. 11 passed; 0 failed; 0 skipped; finished in 678.50ms (683.66ms CPU time)

Ran 11 tests for contracts/test/SwarmV2TopUpTest.t.sol:SwarmV2TopUpTest
[PASS] testFuzz_TopUp_Conservation(uint8,uint8,uint8) (runs: 256, μ: 2317642, ~: 1968096)
[PASS] test_Strand_TopUpKeepsStrandRuleValid() (gas: 855784)
[PASS] test_Strand_WithdrawRefusedThenPermittedAfterTopUp() (gas: 884691)
[PASS] test_TopUp_AfterTierBreak_LotPriceDrops() (gas: 737890)
[PASS] test_TopUp_GaslessTopUp() (gas: 6623012)
[PASS] test_TopUp_MaxBuyersDoesNotBlockExistingBuyer() (gas: 1001030)
[PASS] test_TopUp_PerBuyerLimitAcrossLots() (gas: 746907)
[PASS] test_TopUp_SelfBreaksTier() (gas: 702614)
[PASS] test_TopUp_SettleRefundExact() (gas: 1113459)
[PASS] test_TopUp_StockLimitApplies() (gas: 634491)
[PASS] test_TopUp_WithdrawReturnsFullEscrow() (gas: 686004)
Suite result: ok. 11 passed; 0 failed; 0 skipped; finished in 350.94ms (357.14ms CPU time)

Ran 5 test suites in 869.30ms (2.27s CPU time): 67 tests passed, 0 failed, 0 skipped (67 total tests)
```

---

Here is exactly what changed and why:

**`contracts/DemandPool.sol`**

- `withdraw(uint256 dealId)` replaced by `withdraw(uint256 dealId, uint32 units)`.
- `WithdrawInvalidUnits` error added: reverts when `units == 0` or `units > unitsOf[msg.sender]`.
- Full vs partial split: `isFull = (units == myUnits)`. Full withdrawal uses the existing cleanup path (remove buyer, clear mappings, remove from tally). Partial withdrawal subtracts proportionally from `escrowed` (`returned = escrowed * units / unitsOf`, rounded down) and decrements `unitsOf` and `totalUnits`; `paidPerUnit` and `tierCount` are left alone (the cheapest-lot tally stays valid).
- Strand check: for full withdrawals the existing `_lowestPaidExcluding` logic is used. For partial withdrawals, `_lowestPaidAll` is used (the caller stays in the deal and their own `paidPerUnit` must also be >= `newPrice`). Single-buyer full withdrawals skip the check as before.
- `_lowestPaidAll` private helper added for the partial case.
- Immediate payout: `_tryDirectTransfer` attempts a low-level `call` to USDC `transfer(to, amount)`, decoding the returned bool. Falls back to `ISettler.creditWithdrawal` only when it returns false (e.g. blocklisted recipient). All state mutations happen before the transfer (reentrancy guard held).
- `Withdrawn` event signature updated to `(dealId, buyer, units, amountReturned, paidDirectly, livePrice, totalUnits, buyerCount)`.
- `AlreadyCommitted` error removed (was already gone from v2.1; confirmed absent).

**`contracts/Settler.sol`**: no changes needed; `creditWithdrawal` already exists as the fallback path.

**`contracts/test-helpers/MockBlocklistedEIP3009USDC.sol`**: `transfer(address to, uint256 amount)` override added — returns `false` when `to` is blacklisted, otherwise delegates to `_transfer`. This makes the blocklisted-fallback test meaningful.

**Existing test files updated (and why):**

| File | Tests changed | Reason |
|---|---|---|
| `SwarmV2Test.t.sol` | `test_Strand_RefusedThenPermitted`, `test_Strand_SingleBuyerCanAlwaysWithdraw`, fuzz `testFuzz_V2_Conservation` | `withdraw(d)` → `withdraw(d, units)`. Units captured before `vm.prank`/`vm.expectRevert` to avoid Foundry consuming the prank on the staticcall argument evaluation. |
| `SwarmV2GaslessTest.t.sol` | `test_GL_PriceRose` | Same `withdraw` signature update; units captured before prank. |
| `SwarmV2TopUpTest.t.sol` | `test_Strand_TopUpKeepsStrandRuleValid`, `test_Strand_WithdrawRefusedThenPermittedAfterTopUp`, `test_TopUp_WithdrawReturnsFullEscrow`, fuzz `testFuzz_TopUp_Conservation` | Same signature update. `test_TopUp_WithdrawReturnsFullEscrow` assertion changed from `settler.claimable` grew to buyer wallet balance grew (withdrawal now goes straight to wallet). |

**`contracts/test/SwarmV2PartialWithdrawTest.t.sol` — 11 new tests:**

| Test | What it covers |
|---|---|
| `test_PartialWithdraw_ReturnsAverageToWallet` | Proportional return to wallet; buyer stays; paidPerUnit unchanged |
| `test_FullWithdraw_PaidToWallet` | Full withdrawal goes to wallet (not claimable) |
| `test_PartialWithdraw_Blocklisted_FallsBackToClaimable` | `transfer` returns false for blocklisted; credits `settler.claimable`; `paidDirectly=false` in event |
| `test_PartialWithdraw_ZeroUnits_Reverts` | `WithdrawInvalidUnits` on 0 |
| `test_PartialWithdraw_MoreThanHeld_Reverts` | `WithdrawInvalidUnits` on units > held |
| `test_PartialWithdraw_StrandRule_Partial` | Partial that drops below tier refused; safe partial (stays at tier) succeeds |
| `test_PartialWithdraw_StrandRule_Full` | Full withdrawal of tier-holder refused when it would strand another buyer |
| `test_PartialWithdraw_Rounding_SettlementExact` | Partial then settle; `escrowed - cp*units = 0` (exact divisible case); pool and settler empty after all claims |
| `test_PartialWithdraw_Rounding_NoUnderflow` | 10 units, withdraw 3, settle; refund = 0 (exact case), no underflow |
| `test_MultiLot_PartialWithdraw_ThenSettle` | Multi-lot order (top-up), partial withdrawal with rounding dust, settle; `refund = escrowed - cp*units` exact including dust |
| `testFuzz_PartialWithdraw_Conservation` | Random orders, top-ups, partial and full withdrawals through settlement; pool and settler empty, all passes accounted for |