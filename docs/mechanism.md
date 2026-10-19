# Swarm mechanism — the spec Studio must implement

## The rule that decides everything

**A buyer pays the tier price in force at the moment they commit. Everyone settles
at the clearing price unlocked by the final volume. The difference is refunded.**

Clearing price is a pure function of the final buyer count:

```
clearingPrice(n) = lowest tier price whose minBuyers <= n
```

## The invariant

```
supplier credit + sum(all refunds) == sum(all commits)
```

Exactly, to the wei, for any sequence of commits and withdrawals. This is the
project's credibility and it is Foundry test 2 (fuzz/invariant).

Verified independently of Solidity by `tools/curve.mjs`:

```
$ node tools/curve.mjs --fuzz 20000
fuzz: 20000 random sequences (commits interleaved with withdrawals)
conservation failures: 0
invariant holds: supplier credit + refunds == sum of commits, exactly
```

## Two defects found in the blueprint

Both were caught by modelling the mechanism in `tools/curve.mjs` before writing
any Solidity. Both would have cost real time.

### 1. The headline worked example cannot be posted under the blueprint's own v1 rules

The blueprint's example curve is **$10 at 10 buyers / $8 at 25 / $6 at 50**, but
its own v1 spec **caps unit price at 5 USDC**. Worse, 51 buyers at $10 means
**$456 of peak escrow** against a stated working-capital budget of $15–25.

**Resolution.** Keep the 5 USDC cap — it is the right risk control. Use $10/$8/$6
only as an *illustration* in the write-up (clearer numbers for a reader), and run
the real campaign on a curve inside the cap. The shape is identical, so every
argument in the write-up still holds.

Real campaign curve: **$1.00 at 10 buyers / $0.75 at 25 / $0.50 at 50**, min 10.

```
$ node tools/curve.mjs
clearing   $0.5
tier breaks @25: $1->$0.75   @50: $0.75->$0.5
   25 buyers  refunded $0.5
   25 buyers  refunded $0.25
    1 buyers  refunded $0
supplier credit  $25.5   refunds $18.75   commits $44.25
conservation     OK, exact
peak escrow      $44.25
```

$44.25 of peak escrow, paid in by real buyers, settling to $25.50 for the
supplier. That fits the budget and still produces ~103 mainnet transactions from
a single deal.

### 2. The blueprint's test 1 asserts the wrong refund split

The blueprint specifies test 1 as *"51 buyers clear at the lowest tier and **the
first 8** are refunded the full difference"*, and its worked example says
*"the first 8 refunded $4 each, the next 19 refunded $2 each, the last 24 refunded
$0"*.

That 8/19/24 split comes from the **narrative timeline** in the example (8 buyers
commit in hours 0–6, 19 more by hour 20, 24 more by hour 44) — not from the
**curve thresholds**. Under the stated curve, what matters is the buyer count when
each person commits, which lands at 25/50:

| Buyers | Count when they commit | Paid | Refunded |
|---|---|---|---|
| 1–25 | 0–24, below the 25 threshold | tier 1 | tier1 − tier3 |
| 26–50 | 25–49, below the 50 threshold | tier 2 | tier2 − tier3 |
| 51 | 50, at the last threshold | tier 3 | nothing |

So the correct split is **25 / 25 / 1**, not 8 / 19 / 24.

The blueprint's own figures are internally consistent ($306 + $70 = $376), but
only against an implied curve breaking at 9 and 28 buyers — which is not the curve
it states.

**Resolution.** `studio/prompts/turn-02-tests.md` now specifies test 1 with the
correct expected numbers, asserted individually. Had we passed the blueprint's
wording to Studio, we would have got either a failing test or — much worse — a
contract quietly bent to satisfy a wrong expectation.

## The pricing point, decided

A buyer pays the tier price at the buyer count **including their own commit**. On
the campaign curve, buyer 25 pays $0.75 and buyer 24 pays $1.00 — so "buyer 25
exactly triggers tier 2" is literally true, which is how the brief words its
boundary test.

This is economically immaterial (the difference is refunded at settlement either
way) but it changes every expected number, so it is pinned here: 51 buyers split
**24 / 25 / 2** across the three tiers, commits total **$43.75**, refunds
**$18.25**, supplier **$25.50**.

## The withdrawal squeeze — a fund-locking bug in the mechanism as specified

The brief requires that "a tier must be able to un-break": a withdrawal lowers
volume, so the live price goes back **up**. That interacts badly with the refund
calculation, and the interaction is not mentioned anywhere in the brief.

A buyer who commits when volume is high escrows a **low** tier price. If enough
earlier buyers then withdraw, the final clearing price can end up **above** what
that buyer escrowed. The natural refund expression `paid - clearing` then
underflows:

```
curve 10@$1.00  25@$0.75  50@$0.50, min 10

50 buyers commit         -> buyer 50 escrows $0.50
25 earliest withdraw     -> volume 25, tier price back to $0.75
settle()                 -> buyer 50: 500000 - 750000  ->  underflow, revert
```

In Solidity 0.8 that reverts. `settle()` then reverts **forever**, and
`refundAll()` also reverts because 25 buyers is still above the minimum of 10. The
deal has no exit and **every participant's escrow is permanently stuck**.

It is not a corner case. Fuzzing random commit/withdraw sequences, the condition
arises in **about 0.5%** of them:

```
$ node tools/scenarios.mjs
pass  the squeeze is reachable  — 25 buyers remain, tier price $0.75
pass  an underwater buyer exists  — b49 escrowed $0.5 but clearing is $0.75
pass  UNCLAMPED settlement breaks conservation  — short by $0.25
pass  CLAMPED settlement is solvent  — $18.5 == $18.5
      the squeeze arose naturally in 235 of 50000 sequences (0.5%)
```

### The fix

**Settlement never clears above the lowest price actually escrowed.** The contract
cannot charge a buyer more after the fact, so:

```
clearing = min( tierPrice(finalCount), min(escrowed) )
```

With no withdrawals the two terms are equal and nothing changes. Conservation
still holds exactly, because every buyer has escrowed at least the clearing price:

```
sum(paid) = clearing x n + sum(paid - clearing)
```

The alternative — letting the price rise and demanding the difference — is not
available, because nothing can compel a buyer to top up after committing. Clamping
is the only solvent option, and it is the one that keeps the all-or-nothing promise
honest.

## Edge cases the contract must get right

| Case | Required behaviour |
|---|---|
| Withdrawal un-breaks a tier | Live price goes back **up**. A tier is not sticky. |
| Clearing after withdrawals | Never above the lowest price escrowed — see the squeeze above. |
| Buyer removal from the middle | Swap-and-pop; no stale index, no array corruption. |
| Boundary | `n >= tier.minBuyers`, not `>`. Buyer 25 exactly triggers tier 2. |
| Below minimum | `refundAll` returns every commit in full; supplier gets nothing. |
| State machine | `Open → Settled` or `Open → Refunded`. Mutually exclusive, each once. |
| Blocklisted participant | Credited to `claimable`; cannot block anyone else. Pull, never push. |
| Dust | Contract USDC balance is exactly 0 after all claims. |
| Pause | Halts `postDeal` and `commit`. Never `settle`, `refundAll` or `claim`. |
| Randomness | None needed. `block.prevrandao` is always 0 on Arc — say so in the write-up. |
