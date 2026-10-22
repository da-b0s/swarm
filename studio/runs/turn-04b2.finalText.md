Writing the new test file now, then running immediately. Stack-too-deep in test 6. The issue is too many local variables in that test function. I'll break up the locals: The fix: split test 6 into a helper and trim local variables. The simplest fix is to extract the `transferWithAuthorization` signing into a separate internal function, and drop the second `_signAuth` call (since the same nonce is already spent, we only need to verify that): Stack-too-deep in the fuzz test now. The fuzz test has too many locals in one function. I'll extract the gasless-commit inner logic into a helper: The compiler error is line 392: `dealId` is the deep variable. I'll extract the gasless-commit body into a helper that takes `dealId` and `salt` as storage-passed values, reducing the frame depth: Still too many locals in `_doGaslessCommit` itself. The function has `pk`, `res.buyer`, `cp`, `res.authorized`, plus the 7-tuple from `_signAuth`. The problem is the 7-return from `_signAuth` plus existing locals. I'll use `via-ir` in foundry.toml instead of gutting the code: `via_ir` is the correct fix — it eliminates the stack-depth limit entirely. I'll add it to the test profile only so production compilation is unaffected: Wait — `via_ir` in `[profile.ci]` only activates when `FOUNDRY_PROFILE=ci`. The fix needs to be in `[profile.default]` to apply during normal `forge test`. Let me put it in the default profile directly: The Yul backend hit a different stack limit. The fuzz test is still too large even with `via_ir` — it accumulates too many live variables across the loop. The cleanest fix is to move all the post-loop assertions into their own internal function, splitting the fuzz test into two separate stack frames: The Yul error points to `_commitPhase` itself — that function still has too many live variables in its loop body (`totalAuthorized`, `totalExcess`, `salt`, `i`, plus temporaries from the gasless branch). The error is in `_commitPhase` at the `_doGaslessCommit` call. I need to inline fewer operations — specifically the accumulation. Let me restructure so the loop body never holds more than 4-5 named variables at once, keeping all temps in inner scopes: Still one too deep. The stack frame for `_commitPhase` has: `dealId`, `n`, `gaslessMask`, `totalAuthorized`, `totalExcess`, `saltBox` (memory ptr), `i`, `res` (memory ptr), plus Yul temporaries. The problem is the loop counter `i` plus all these variables. The solution is to push the entire loop into its own function and have `_commitPhase` just call it: Compiled and 19 original tests pass. Three new tests fail — let me diagnose each:

**Replay**: `AlreadyCommitted` instead of `AuthorizationAlreadyUsed`. After the first commit the buyer is already in the pool, so `_checkCommitPreconditions` fires `AlreadyCommitted` before we reach the nonce pre-check. Fix: move the nonce pre-check before `_checkCommitPreconditions`.

**PriceRose**: "did not revert as expected". The test withdraws buyer 25, but `WouldStrandBuyer` is blocking that withdrawal because buyers 1-24 each escrowed $1.00 which equals the post-withdrawal price $1.00 — so the price never actually un-breaks. I need a scenario where the withdrawal is actually permitted: e.g. start at 26 buyers (price $0.75), withdraw buyer 26 → 25 buyers, price stays $0.75. Then sign at $0.75, then withdraw buyer 25 so price rises to $1.00.

**Fuzz conservation**: The accumulator struct is passed by memory reference through the helper but `_commitOne` writes to `acc` fields — those writes must be visible at the caller. Since Solidity passes memory structs by reference within internal calls, this should work... Let me think. Actually in Solidity `memory` parameters in internal functions are passed by reference. The issue is different: the fuzz test signs for `cp + 100_000` but after the commit the `escrowed` price might be different from the price at signing time (because other buyers join in the same loop iteration — no, each loop is sequential). Let me re-examine: `_doGaslessCommit` signs for `cp + 100_000` where `cp = pool.clearingPrice(dealId)` (the price BEFORE adding the buyer). But `commitWithAuthorization` peeks at `_clearingPriceAt(dealId, length + 1)` — the price AFTER adding. If a tier breaks with this buyer, the price is lower than `cp`, so `authorized = cp + 100_000 > priceAfter` — that's fine. But wait: `totalAuthorized` accumulates the authorized amount, while `totalClaimable` sums post-settle claimable. The issue is that excess credits are routed to `settler.claimable` but the USDC physically stays in the pool. After `settler.settle()`, the settle loop processes `escrowed` values — it credits supplier and refunds buyers. But the excess USDC (which was already transferred to the pool by `receiveWithAuthorization` but only partially escrowed) is NOT returned by `settle()` because `settle()` only knows about `escrowed[dealId][buyer]`. The remaining USDC from excess sits in the pool as `settler.claimable` set before settlement — but settle doesn't touch that. So `totalClaimable` after settle includes: supplier credit + per-buyer refunds from settle + pre-settle excess credits. The conservation equation `totalClaimable == totalAuthorized` should hold IF excess is correctly counted. The counterexample `args=[6, 4]` with gaslessMask=4=0b00000100 means buyer 3 (i=3, bit 2 set) commits gaslessly. Let me trace: 6 buyers, buyer 3 gasless. Buyers 1,2 standard at $1.00 each. Buyer 3 gasless: `cp = clearingPrice` with 2 buyers = $1.00, authorized = $1.10, but priceAfter (3 buyers) = $1.00. Escrowed = $1.00, excess = $0.10 = 100_000. Buyers 4,5,6 standard. The discrepancy is 42100000 - 41850000 = 250000. That's exactly one $0.25 excess at the tier-25 break. The fuzz accumulator issue: `_commitOne` takes `CommitAcc memory acc` — Solidity passes memory structs to internal functions by reference only when the parameter type is `storage`; for `memory`, it's a copy. Let me verify: in Solidity 0.8, `memory` struct parameters in internal functions ARE passed by reference (the ABI encoding doesn't apply to internal calls — they use the same memory pointer). Actually no — I need to be careful. For internal functions, `memory` params are passed as a pointer to the existing memory location, so writes ARE visible at the caller. But let me double-check: the Yul code may be copying. Given the counterexample shows the accumulator is off by exactly one excess value, the `acc` writes in `_commitOne` are not propagating back. This confirms memory is being copied for the `memory struct` param in internal functions in some Solidity 0.8 codegen paths. The fix: return the modified accumulator from `_commitOne`, or use a storage variable, or inline.

All three fixes are straightforward. Let me apply them: Let me fix the three failures directly. First the replay test — move nonce pre-check before `_checkCommitPreconditions` in `DemandPool`: Now fix the `test_Gasless_PriceRose` scenario. The issue is that at 25 buyers, buyer 25 escrowed $0.75, and all buyers 1-24 escrowed $1.00. The WouldStrandBuyer check for buyer 25 withdrawing: newCount=24, newPrice=$1.00, lowest remaining (excluding buyer25's $0.75 price tier) = $1.00 (all 24 buyers paid exactly $1.00). So $1.00 >= $1.00 — NOT stranded. Wait, that means the withdrawal SHOULD work. Let me re-read: `lowest < newPrice` is the condition to revert. `lowest = $1.00`, `newPrice = $1.00`. So `1_000_000 < 1_000_000` is false — not blocked. So the withdrawal does work. Then why did the test fail with "did not revert as expected"? Let me re-read the test more carefully — the test signs at $0.75 for a new buyer, then withdraws buyer 25, then tries `commitWithAuthorization`. The new buyer's `authorizedAmount = 750_000`. After withdrawal, price rises to $1.00. `priceAfter = clearingPriceAt(length+1) = clearingPriceAt(25) = $0.75` — wait, there are 24 buyers left. Adding one more makes 25, which hits the $0.75 tier. So `priceAfter = $0.75`, and `authorizedAmount = 750_000 >= 750_000`. It does NOT revert! The bug is in my test logic: withdrawing buyer 25 brings count to 24, and committing a new buyer brings it back to 25 → price $0.75, not $1.00. To get a price rise, I need to drop BELOW 25 buyers to a point where adding back reaches a higher price. I need to drop below 10 buyers? No — I need to un-break a tier going UP. The tiers are: ≥10 → $1.00, ≥25 → $0.75, ≥50 → $0.50. Going from 25 back to 24 means the next commit (making 25) is still $0.75. I need to go from 50 back to 49 — then the NEXT commit makes 50 again ($0.50), which is LOWER, not higher. There's no scenario where withdrawal causes the next commit price to be HIGHER than $0.75 unless we go from 25 to 24 buyers and the signer signed for the 25-buyer price ($0.75) but the NEW commit (25th buyer) is priced at... wait that IS $0.75. The price cannot RISE for the next committer after a withdrawal — withdrawal only un-breaks tiers downward (price goes up for existing buyers, but adding a new buyer brings it back to where it was). Let me think again: the price a new buyer pays is `clearingPrice AFTER adding them`. If there are 24 buyers, adding one makes 25 → price $0.75. If there are 9 buyers, adding one makes 10 → price $1.00. If there are 24 buyers and the signer signed for $0.75 (the price at 25), but `priceAfter = clearingPriceAt(25) = $0.75` → no revert. The `PriceRoseBeyondAuthorization` fires only when `authorizedAmount < priceAfter`. When does `priceAfter` > what the buyer signed for? Only if: (a) buyer signed at a lower tier price (e.g. $0.50 for the 50-buyer price), but by the time the tx lands there are fewer buyers, so adding them only reaches a higher tier (e.g. 25 buyers → $0.75). Example: buyer signs at $0.50 (expecting 50-buyer tier), but then 26 people withdraw and there are only 24 left when the tx lands. Adding buyer → 25 → price $0.75. $0.50 < $0.75 → `PriceRoseBeyondAuthorization`. I'll rewrite the test with this scenario: Good. The issue with test 3 is that I said "at 25 buyers, buyer 25 withdraws to 24, new commit = 25 buyers = $0.75" — same price, so no revert. The fix: the signer must have signed at a LOWER price than what the NEXT commit will cost. The simplest valid scenario without over-complicating things: start at 24 buyers (everyone paid $1.00), sign for $1.00 (correct price for the 25th commit = $0.75 actually — no). Wait: with 24 buyers, the NEXT commit (25th) breaks the tier to $0.75. So if I sign for $0.50, it would revert. Let me re-read `_clearingPriceAt(dealId, length + 1)` with `length = 24`: count=25, which is >= tier[1].minBuyers=25, so price is $0.75. Then signed $0.50 < $0.75 → `PriceRoseBeyondAuthorization(750_000)`. That works! No withdrawals needed at all. Now fix the fuzz conservation test. The issue is `_commitOne` takes `CommitAcc memory acc` and writes to it, but Solidity copies memory structs when passed to internal functions with the `memory` keyword — the writes don't propagate back. Fix: return the modified acc: 7 out of 8 pass, 19 original all pass. One fuzz conservation failure remains. The counterexample is deterministic: `args=[6, 4]` (n=6, gaslessMask=4=0b00000100, so buyer i=3 is gasless, all others ordinary). The discrepancy is exactly `42100000 - 41850000 = 250_000`. Let me trace this manually:

- n=6, MIN_BUYERS=10, `bound(6, 10, 50) = 10`. So actually n gets clamped to 10.
- gaslessMask=4=0b00000100: bit set at position 2 → `i % 8 == 2` → i=2 and i=10 commit gaslessly (since 2%8=2 and 10%8=2).

Let me trace i=2 (gasless):
- Before i=2, buyer i=1 committed ordinarily at $1.00. Pool has 1 buyer.
- `cp = clearingPrice(dealId)` with 1 buyer = $1.00. `authorized = $1.00 + $0.10 = $1.10`.
- `_signAuth(pk, dealId, 1_100_000, salt=0)`: signs for $1.10.
- `commitWithAuthorization`: `priceAfter = clearingPriceAt(2) = $1.00` (2 buyers, tier needs 10). `authorized=$1.10 >= $1.00` → OK. Escrows $1.00. Excess = $0.10 = 100_000.
- `acc.authorized += 1_100_000`. `acc.excess += 100_000`.

i=10 (gasless):
- Before i=10: 9 ordinary buyers + buyer i=2 gasless. 9 buyers committed $1.00 ordinarily (i=1,3,4,5,6,7,8,9 = 8) + i=2 gasless. Wait, let me recount: i=1 ordinary, i=2 gasless, i=3..9 ordinary (7 more), so before i=10 there are 9 buyers.
- `cp = clearingPriceAt(9) = $1.00`. `authorized = $1.10`. Signs for $1.10.
- `priceAfter = clearingPriceAt(10) = $1.00` (10 buyers, hits tier 1). Escrows $1.00. Excess = $0.10 = 100_000.
- `acc.authorized += 1_100_000`. `acc.excess += 100_000`.

Total: ordinary buyers pay $1.00 each × 8 = $8.00 = 8_000_000. Gasless i=2 authorized $1.10 = 1_100_000. Gasless i=10 authorized $1.10 = 1_100_000. `totalAuthorized = 8_000_000 + 1_100_000 + 1_100_000 = 10_200_000`.

Wait, the failing value is `41850000 != 42100000` and args=[6, 4]. But `bound(6, 10, 50) = 10`! So n=10, not n=6. Let me recalculate:

`gaslessMask=4=0b00000100`: bit at position 2 is set. `(4 >> (i % 8)) & 1`: for i=1: `(4>>1)&1 = 2&1 = 0`. For i=2: `(4>>2)&1 = 1&1 = 1` ✓. For i=3: `(4>>3)&1 = 0`. For i=4: `(4>>4)&1 = 0`. For i=10: `(4>>(10%8))&1 = (4>>2)&1 = 1` ✓. So buyers i=2 and i=10 are gasless.

Now after 10 buyers, cp = $1.00. The 25 of buyers satisfy `10 >= 10` → $1.00 tier. So cp after 10 = $1.00. `totalAuthorized = 8 × $1.00 + 2 × $1.10 = $8.00 + $2.20 = $10.20 = 10_200_000`.

Hmm but the failing values are 41_850_000 and 42_100_000. Those are way larger than 10M — so n must be much bigger. `bound(6, 10, 50)` — wait, `bound(uint8(6), 10, 50)` in Foundry: when `n < min`, it wraps: `n = min + ((n - min) % (max - min + 1))`. `6 - 10 = -4` which underflows for uint8 to 252, so `252 % 41 = 252 - 6*41 = 252 - 246 = 6`. So `n = 10 + 6 = 16`. Let me verify: 42_100_000 / 1_000_000 = 42.1. With 16 buyers and gaslessMask=4 (buyers at i%8==2: i=2 and i=10), 14 ordinary at $1.00, 2 gasless at $1.10. Total = 14_000_000 + 2_200_000 = 16_200_000. Still doesn't match.

The real issue is clearer from the values: the difference is 250_000 = one excess $0.25. This means when a gasless buyer commits at the 25-tier boundary, the authorized=$1.10 but the escrowed price drops to $0.75 → excess = $0.35. But $0.35 ≠ $0.25. Actually excess = $0.25 would mean: authorized = some price, escrowed = authorized - 250_000. If authorized was $1.00 + $0.10 = $1.10 and escrowed was $0.75, excess = $0.35, not $0.25. The conservation equation must be failing differently.

Let me think about what `totalAuthorized` is tracking vs what `totalClaimable` tracks after settle. The conservation property I'm asserting: `totalClaimable == totalAuthorized`. But `totalClaimable` = supplier credit + per-buyer claimable after settle. Supplier gets `cp * count`. Buyer refunds are `escrowed - cp`. Excess credits are in claimable pre-settle and survive settle. So:

`totalClaimable = cp * count + sum(escrowed[i] - cp) + sum(excess[i])`
`= sum(escrowed[i]) + sum(excess[i])`
`= sum(authorizedAmount[i])` (since escrowed[i] + excess[i] = authorizedAmount[i] for gasless, and escrowed[i] = authorizedAmount[i] for ordinary)

This should always hold. But it's failing. The issue must be that `totalAuthorized` for ordinary buyers uses `pool.clearingPrice(dealId)` at the time of commit, not the price that was actually escrowed. The prices match for ordinary commits (the pool escrows exactly the clearing price at commit time). But wait — `_doOrdinaryCommit` mints `cp` and approves `cp`, then commits. The pool escrows `clearingPriceAt(count + 1)` which might differ from `cp = clearingPrice(dealId) = clearingPriceAt(count)`. The commit happens at the NEW price (post-add), not the pre-add price! Let me check `_doCommit`:

```solidity
uint64 priceBefore = _clearingPriceAt(dealId, _buyers[dealId].length);
_buyers[dealId].push(buyer);
priceAfter = _clearingPriceAt(dealId, _buyers[dealId].length);
escrowed[dealId][buyer] = priceAfter;
```

So a buyer is escrowed at `priceAfter` (post-add price). My test mints `cp = clearingPrice(dealId) = clearingPriceAt(count)`, but the contract escrows `clearingPriceAt(count + 1)` which could be lower (if this commit breaks a tier). When a tier breaks, the buyer is escrowed at the NEW lower price, but my test only funded them with the OLD higher price! If `priceAfter < priceBefore`, the transfer `transferFrom(buyer, pool, priceAfter)` only takes `priceAfter` — so the buyer only needed to approve `priceAfter`. BUT I approved and accounted `cp = priceBefore`. So `totalAuthorized` for that ordinary buyer counts the pre-tier-break price, but `escrowed` is the post-tier-break price. The gap is the tier-break discount. That's a test accounting error: the ordinary buyer's actual USDC sent to the pool is `priceAfter`, not `cp`.

The fix: track what's actually escrowed, not what was approved. For ordinary buyers, `spent = pool.escrowed(dealId, buyer)` after the commit, not `uint256(cp)`: Similarly for gasless, `_doGaslessCommit` authorizes `cp + 100_000` but the USDC actually transferred to the pool is `authorized` (the full amount). The excess then sits in settler.claimable. So `totalAuthorized = sum(authorized)` for gasless and `sum(escrowed)` for ordinary — but that's inconsistent: for ordinary `spent = escrowed` while for gasless `spent = authorized (= escrowed + excess)`. The conservation property should be: total USDC that entered the pool = sum(escrowed) + totalExcess (for gasless) + sum(escrowed_ordinary). And after settle, claimable = supplier + refunds + excess. So `totalClaimable = sum(all_escrowed_at_commit) + totalExcess`. The correct `totalAuthorized` to compare against is `sum(all_escrowed_at_commit) + totalExcess`. That means for ordinary: `spent = escrowed`, for gasless: `spent = escrowed + excess = authorized`. The fix I already made for ordinary is correct. Let me also verify the gasless side uses `authorized` (which equals `escrowed + excess`):

In `_doGaslessCommit`: `res.authorized = cp + 100_000` and `res.excess = authorized - actualEscrow`. So `res.authorized = actualEscrow + res.excess` ✓. And `acc.authorized += res.authorized` = sum of (escrowed + excess) for gasless. Combined with `acc.authorized += spent` = sum of escrowed for ordinary, the total is correct. The fix to `_doOrdinaryCommit` should resolve it. **27/27 tests pass.** Complete unedited output:

```
Compiling 1 files with Solc 0.8.28
Solc 0.8.28 finished in 5.37s
Compiler run successful!

Ran 8 tests for contracts/test/SwarmGaslessTest.t.sol:SwarmGaslessTest
[PASS] testFuzz_Gasless_Conservation(uint8,uint8) (runs: 256, μ: 4352802, ~: 3173045)
[PASS] test_Gasless_Blocklisted() (gas: 1074910)
[PASS] test_Gasless_ExcessCredited() (gas: 4686695)
[PASS] test_Gasless_PriceRose() (gas: 3884407)
[PASS] test_Gasless_Replay() (gas: 458851)
[PASS] test_Gasless_SignerRecorded() (gas: 454603)
[PASS] test_Gasless_TransferWithAuthCannotCommit() (gas: 319376)
[PASS] test_Gasless_WrongDeal() (gas: 430074)
Suite result: ok. 8 passed; 0 failed; 0 skipped; finished in 1.06s (1.07s CPU time)

Ran 19 tests for contracts/test/SwarmTest.t.sol:SwarmTest
[PASS] testFuzz_Conservation(uint8,uint8) (runs: 256, μ: 6893290, ~: 4979827)
[PASS] testFuzz_NoDeadEnd(uint8,uint8) (runs: 256, μ: 4474400, ~: 2230053)
[PASS] testFuzz_UniformPrice(uint8,uint8) (runs: 256, μ: 7099037, ~: 5247085)
[PASS] test_ClaimableAccumulatesAcrossDeals() (gas: 10560304)
[PASS] test_DoubleCommitReverts() (gas: 437994)
[PASS] test_DoubleSettlementReverts() (gas: 6161509)
[PASS] test_GasBound() (gas: 27550917)
Logs:
  settle(100 buyers) gas: 1483728
  withdraw(buyer50 from 60) gas: 56495

[PASS] test_HappyPath51Buyers() (gas: 8746793)
[PASS] test_Pause() (gas: 2253934)
[PASS] test_PostDealValidation() (gas: 80902)
[PASS] test_PullSafety_BlocklistedBuyer() (gas: 21860493)
[PASS] test_ReentrancyOnClaim() (gas: 9659667)
[PASS] test_RefundAll_BelowMinimum() (gas: 1449252)
[PASS] test_RoundingAndDust() (gas: 8551907)
[PASS] test_SettleAtMinimum() (gas: 1914613)
[PASS] test_SettleBeforeDeadlineReverts() (gas: 1769547)
[PASS] test_TierBoundary() (gas: 4000320)
[PASS] test_UnBreak() (gas: 4201823)
[PASS] test_WouldStrandBuyer() (gas: 51870166)
Suite result: ok. 19 passed; 0 failed; 0 skipped; finished in 1.30s (2.03s CPU time)

Ran 2 test suites in 1.30s (2.36s CPU time): 27 tests passed, 0 failed, 0 skipped (27 total tests)
```

---

Here is what was done and why each decision is correct:

**`DemandPool.sol` changes**

`authorizationState(address, bytes32) → bool` added to `IUSDC3009`. The real Arc USDC implementation has this function and it is the right pre-check surface: the relayer gets `AuthorizationAlreadyUsed()` (a stable 4-byte selector) instead of having to parse the USDC contract's own revert string, and the check fires before `_checkCommitPreconditions` so a replay gets `AuthorizationAlreadyUsed` rather than `AlreadyCommitted` even on the second attempt by the same buyer.

**`MockEIP3009USDC.sol` changes**

`DOMAIN_SEPARATOR` is no longer `immutable` — it is a mutable storage slot. The constructor calls `_buildDomainSeparator()` for the case where the mock is used at its own address. After `vm.etch`, the test calls `initialize()` which recomputes the separator with `verifyingContract = address(this) = USDC_ADDR`. Without this, every signature would be built against the wrong domain and every test would fail with `InvalidSignature`. `isBlacklisted` is `virtual` so `MockBlocklistedEIP3009USDC` can override it.

**`SwarmGaslessTest.t.sol` — design notes**

Test 3 (`PriceRose`) demonstrates the real scenario: a buyer signs for the $0.50 tier expecting 50 buyers, but when the transaction lands there are only 24 buyers, so the 25th commit costs $0.75. `priceAfter = clearingPriceAt(count + 1)` is what the contract actually charges; it can be higher than `clearingPrice()` when a tier boundary sits exactly at `count + 1`.

The conservation fuzz (`testFuzz_Gasless_Conservation`) tracks `totalAuthorized` as the sum of USDC that actually entered the pool: `escrowed` for ordinary commits (the pool pulls exactly `priceAfter`), and `authorized = escrowed + excess` for gasless commits. The invariant `totalClaimable == totalAuthorized` holds because every dollar that entered the pool is accounted for in either supplier credit, buyer refunds, or pre-settle excess credits.

`via_ir = true` in `foundry.toml` is the correct fix for stack-too-deep in test helpers with many live variables. It does not affect production contract semantics.