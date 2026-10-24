Reading both files in full before touching anything. Good. I have both files completely. The plan:

1. Remove `via_ir = true` from `foundry.toml`.
2. Refactor `_signAuth` to return a struct so its frame is shallow enough without `via_ir`.
3. Update all call sites in the file that destructure its return.
4. Replace `test_Gasless_TransferWithAuthCannotCommit` and the `_signTransfer` helper with the correct test: sign a `ReceiveWithAuthorization`, try to submit it via `transferWithAuthorization` (must revert), then show the same sig still works through `commitWithAuthorization`. Now refactor `_signAuth` to return a struct and update all call sites. The struct replaces the seven individual return values; each call site destructures it instead: Now replace `_signAuth` to return `Auth memory` instead of seven individual values: Now update all call sites. Test 1: Test 2: Test 3: Test 4: Test 5: Now replace test 6 and its `_signTransfer` helper with the correct threat model. The new test: sign a `ReceiveWithAuthorization`, pass those values to `transferWithAuthorization` (must revert because the typehashes differ), assert buyer balance / pool balance / buyer count unchanged, then show the same sig still works through `commitWithAuthorization`: Test 7: Finally update `_doGaslessCommit` — it still uses the old destructuring syntax: Good. All call sites updated. Now run the full suite: 27/27 pass. Complete unedited output:

```
Compiling 37 files with Solc 0.8.28
Solc 0.8.28 finished in 2.43s
Compiler run successful!

Ran 8 tests for contracts/test/SwarmGaslessTest.t.sol:SwarmGaslessTest
[PASS] testFuzz_Gasless_Conservation(uint8,uint8) (runs: 256, μ: 4323944, ~: 3427977)
[PASS] test_Gasless_Blocklisted() (gas: 1132942)
[PASS] test_Gasless_ExcessCredited() (gas: 4720866)
[PASS] test_Gasless_PriceRose() (gas: 3919008)
[PASS] test_Gasless_Replay() (gas: 459945)
[PASS] test_Gasless_SignerRecorded() (gas: 456022)
[PASS] test_Gasless_TransferWithAuthCannotCommit() (gas: 468850)
[PASS] test_Gasless_WrongDeal() (gas: 431792)
Suite result: ok. 8 passed; 0 failed; 0 skipped; finished in 1.32s (1.33s CPU time)

Ran 19 tests for contracts/test/SwarmTest.t.sol:SwarmTest
[PASS] testFuzz_Conservation(uint8,uint8) (runs: 256, μ: 6566345, ~: 4081433)
[PASS] testFuzz_NoDeadEnd(uint8,uint8) (runs: 256, μ: 4589764, ~: 2487429)
[PASS] testFuzz_UniformPrice(uint8,uint8) (runs: 256, μ: 6731837, ~: 4086999)
[PASS] test_ClaimableAccumulatesAcrossDeals() (gas: 10633123)
[PASS] test_DoubleCommitReverts() (gas: 439464)
[PASS] test_DoubleSettlementReverts() (gas: 6782353)
[PASS] test_GasBound() (gas: 28332672)
Logs:
  settle(100 buyers) gas: 1475533
  withdraw(buyer50 from 60) gas: 58204

[PASS] test_HappyPath51Buyers() (gas: 8799038)
[PASS] test_Pause() (gas: 2268318)
[PASS] test_PostDealValidation() (gas: 104660)
[PASS] test_PullSafety_BlocklistedBuyer() (gas: 22629334)
[PASS] test_ReentrancyOnClaim() (gas: 9731036)
[PASS] test_RefundAll_BelowMinimum() (gas: 1455817)
[PASS] test_RoundingAndDust() (gas: 8617081)
[PASS] test_SettleAtMinimum() (gas: 1924513)
[PASS] test_SettleBeforeDeadlineReverts() (gas: 1782422)
[PASS] test_TierBoundary() (gas: 4033201)
[PASS] test_UnBreak() (gas: 4237273)
[PASS] test_WouldStrandBuyer() (gas: 55786547)
Suite result: ok. 19 passed; 0 failed; 0 skipped; finished in 1.32s (2.07s CPU time)

Ran 2 test suites in 1.32s (2.65s CPU time): 27 tests passed, 0 failed, 0 skipped (27 total tests)
```

`settle(100 buyers)` gas is back to **1,475,533** — matching the pre-`via_ir` baseline of 1,475,504 to within noise (the 29-gas difference is from the new `authorizationState` pre-check path that was added in this session, not from the compiler pipeline). The `via_ir` bytecode had read 1,483,728, confirming it was genuinely changing codegen.

**What changed and why:**

`via_ir = true` was removed from `foundry.toml`. The stack-depth problem it was solving (`_signAuth` returning seven bare values) is fixed properly: `_signAuth` now returns `Auth memory`, a single struct slot. The compiler packs the seven fields into one memory pointer, which is a single stack slot at every call site. All eight call sites in the file — tests 1–7 and `_doGaslessCommit` — were updated to use `a.validAfter`, `a.validBefore`, `a.v`, `a.r`, `a.s`.

`test_Gasless_TransferWithAuthCannotCommit` now tests the actual threat: an attacker takes a real `ReceiveWithAuthorization` signature from the relayer's wire and tries to submit it via `transferWithAuthorization`. The USDC mock rejects it because the two function types use different EIP-712 typehashes — `ReceiveWithAuthorization(...)` vs `TransferWithAuthorization(...)` — so the struct hash is different and ecrecover returns the wrong signer. The test then proves the signature was not consumed by the failed call: the same `(v, r, s)` triple succeeds immediately through `commitWithAuthorization`. The old `_signTransfer` helper is gone entirely.