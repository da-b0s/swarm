# Swarm mechanism — the spec Studio must implement

## The rule that decides everything

**Every buyer escrows the same collateral — the top tier price — whenever they
commit. Everyone settles at the clearing price unlocked by the final volume. The
difference is refunded, identically, to all of them.**

The brief says commit "escrows the CURRENT tier price". That was changed, and the
change is the most substantive engineering decision in the project; the reasoning
is under "the withdrawal squeeze" below.

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

## The numbers, pinned

Campaign curve $1.00 at 10 buyers / $0.75 at 25 / $0.50 at 50, minimum 10,
51 buyers, collateral $1.00:

| Quantity | Value |
|---|---|
| Collateral per buyer | $1.00 |
| Clearing price | $0.50 |
| Refund per buyer | $0.50, identical for all 51 |
| Supplier credited | $25.50 |
| Refunds total | $25.50 |
| Commits total | $51.00 |
| Peak escrow | $51.00 |

The tier boundary is `>=`: `clearingPrice` is $1.00 at 24 buyers and $0.75 at 25.

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

### Three candidate fixes, and why two were rejected

**(a) Per-buyer `min(escrowed, clearing)`.** What Studio implemented on its own
initiative. Solvent, no fund-lock — but different buyers then pay different
amounts for the same deal. That forfeits the single-clearing-price property the
product is built on, and would have to be disclosed as a known limitation on the
one claim the write-up leads with. Rejected.

**(b) Clamp the clearing price to the lowest escrow.** Keeps one price and is
solvent. But it is gameable: commit while volume is high to escrow the bottom
tier, then mass-withdraw, and the clamp drags settlement to the bottom tier for
everyone at the supplier's expense. Measured on the campaign curve, 25 honest
buyers pay the supplier $18.75, while the same 25 reached through a mass
withdrawal pay $12.50. Rejected.

**(c) Uniform top-tier collateral.** Every buyer escrows `tiers[0].price`
regardless of when they commit, and is refunded down to the clearing price.
**Chosen.**

Under (c) the failure cannot occur rather than being handled:

- No buyer can be underwater, so no refund subtraction can underflow.
- The clearing price is always `tierPrice(finalCount)` — one price, unconditionally.
- Every refund is identical, so there is no per-buyer rounding and no dust.
- Withdrawals need no restrictions at all; a tier un-breaks freely.
- Conservation is trivially exact: `collateral × n == clearing × n + (collateral − clearing) × n`.
- It removes a race in gasless commits that neither the brief nor Studio spotted:
  an EIP-3009 authorization is signed for a fixed amount, so a commit price that
  moves between signing and relaying invalidates the authorization. Fixed
  collateral cannot race.

The cost is more capital locked up per buyer ($1.00 rather than as little as
$0.50) and a slightly higher peak escrow ($51.00 rather than $43.75) — paid in by
buyers, not by us. In exchange the emotional hook gets stronger, not weaker:
everyone escrows the top price and watches a single shared refund grow as volume
builds.

All three are reproducible side by side:

```
$ node tools/scenarios.mjs
pass  reason 1 — an underwater buyer appears  — b49 escrowed $0.5, clearing $0.75
pass  reason 1 — settlement is insolvent  — short by $0.25
pass  reason 2 — but a coalition cuts the supplier's take  — 25 honest buyers pay
      the supplier $18.75; the same 25 after a mass withdrawal pay $12.5
pass  no sequence can produce an underwater buyer  — 0 found
```

## Edge cases the contract must get right

| Case | Required behaviour |
|---|---|
| Withdrawal un-breaks a tier | Live price goes back **up**. A tier is not sticky. |
| Clearing after withdrawals | Always `tierPrice(finalCount)`. Affordable by construction, since everyone escrowed the top tier. |
| Buyer removal from the middle | Swap-and-pop; no stale index, no array corruption. |
| Boundary | `n >= tier.minBuyers`, not `>`. Buyer 25 exactly triggers tier 2. |
| Below minimum | `refundAll` returns every commit in full; supplier gets nothing. |
| State machine | `Open → Settled` or `Open → Refunded`. Mutually exclusive, each once. |
| Blocklisted participant | Credited to `claimable`; cannot block anyone else. Pull, never push. |
| Dust | Contract USDC balance is exactly 0 after all claims. Uniform refunds mean no per-buyer rounding. |
| Pause | Halts `postDeal` and `commit`. Never `settle`, `refundAll` or `claim`. |
| Randomness | None needed. `block.prevrandao` is always 0 on Arc — say so in the write-up. |
