# Swarm mechanism — the spec Studio must implement

## The rule that decides everything

**A buyer escrows the tier price live at the moment they commit. Everyone settles
at the clearing price unlocked by the final volume. The difference is refunded.**

This is the brief's wording, unchanged. Clearing price is a pure function of the
final buyer count:

```
clearingPrice(n) = lowest tier price whose minBuyers <= n
```

The price a buyer escrows is `clearingPrice(count including their own commit)`, so
on the campaign curve buyer 24 escrows $1.00 and buyer 25 escrows $0.75 — "buyer 25
exactly triggers tier 2", as the brief's boundary test words it.

## The invariant

```
supplier credit + sum(all refunds) == sum(all commits)
```

Exactly, to the wei, for any sequence of commits and withdrawals. This is the
project's credibility and it is Foundry test 2. Alongside it, a second property
that matters just as much:

```
supplier credit == clearingPrice(finalCount) * buyerCount
```

The brief writes that formula out as code, and it is what makes "every buyer
settles at the single clearing price" literally true rather than nearly true.

Both are verified independently of Solidity by `tools/model.mjs`:

```
$ node tools/scenarios.mjs
pass  conservation holds over 50000 random sequences  — 0 failures
pass  no sequence strands a buyer  — 0 found
pass  supplier is always credited clearing x buyerCount  — 0 deviations
```

## The numbers, pinned

Campaign curve $1.00 at 10 buyers / $0.75 at 25 / $0.50 at 50, minimum 10,
51 buyers:

| Quantity | Value |
|---|---|
| Clearing price | $0.50 |
| Buyers 1–24 | escrowed $1.00, refunded $0.50 |
| Buyers 25–49 | escrowed $0.75, refunded $0.25 |
| Buyers 50–51 | escrowed $0.50, refunded nothing |
| Supplier credited | $25.50 |
| Refunds total | $18.25 |
| Commits total | $43.75 |
| Peak escrow | $43.75 |

## The withdrawal squeeze, and how the spec was kept

The brief asks for two things that cannot both hold unconditionally:

> `commit(dealId)` escrows the **CURRENT tier price**
>
> `withdraw(dealId)` before the deadline returns the commit and recomputes — **a
> tier must be able to un-break**

A withdrawal lowers volume, so the live price goes back **up**. The newest buyer
escrowed the *lowest* price, so **any** un-break leaves them owing more than they
ever escrowed. At 25 buyers the 25th escrowed $0.75; one exit drops the count to 24,
the clearing price returns to $1.00, and `escrowed - cp` underflows:

```
curve 10@$1.00  25@$0.75  50@$0.50, min 10

50 buyers commit       -> buyer 50 escrows $0.50
25 earliest withdraw   -> volume 25, clearing price back to $0.75
settle()               -> buyer 50: 500000 - 750000  ->  underflow, revert
```

In Solidity 0.8 that reverts. `settle()` then reverts **forever**, and
`refundAll()` also reverts because 25 buyers is still above the minimum of 10. The
deal has no exit and **every participant's escrow is stuck**. Fuzzed, the condition
arises in about 0.5% of random commit/withdraw sequences.

This is a contradiction inside the brief, not a reason to redesign around it. The
resolution keeps both sentences and adds a precondition to one of them.

### The fix: a withdrawal may not strand anyone

`withdraw(dealId)` is refused when the caller's exit would leave a remaining buyer
escrowed below the resulting clearing price. Everything else stays exactly as the
brief specifies — including `claimable[supplier] += clearing * buyers.length`.

**It binds only when the buyer count sits exactly on a tier threshold**, where one
exit would strand the newest buyer. Off a threshold there is slack, and the exit is
free:

```
count 24: earliest buyer's exit is allowed   — off-threshold, exit is free
count 25: earliest buyer's exit is refused   — count is exactly on a tier threshold
count 26: earliest buyer's exit is allowed   — off-threshold, exit is free
count 30: earliest buyer's exit is allowed   — off-threshold, exit is free
count 50: earliest buyer's exit is refused   — count is exactly on a tier threshold
count 51: earliest buyer's exit is allowed   — off-threshold, exit is free
```

Fuzzing random sequences, **1.8% of withdrawal attempts are refused**, always on a
threshold. A refusal is temporary: one more commit clears it.

The brief's own test 6 still passes as written — with 25 buyers, the 25th (who
escrowed $0.75) withdraws successfully, the tier un-breaks to $1.00, and a new
commit re-breaks it to $0.75. The buyer whose exit is blocked is an *earlier*,
higher-paying buyer, and being held in means settling at a price better than the
one they agreed to.

**Implementation note.** Do not find the minimum escrow by looping the buyer array
— that is O(n) on every withdrawal and a griefing vector at 100 buyers. Keep a
per-deal tally of how many buyers sit at each tier price, incremented on commit and
decremented on withdrawal; the lowest escrowed price among the remainder is then
found by scanning the deal's tiers, which is bounded by tier count rather than
buyer count.

### What else was weighed

| Approach | Solvent | Supplier gets `clearing × n` | One shared price | Verdict |
|---|---|---|---|---|
| No guard (the brief as literally written) | **no** — funds lock | — | — | the bug |
| Clamp clearing to the lowest escrow | yes | no | yes | **sybil-exploitable** |
| Per-buyer `min(escrowed, clearing)` | yes | **no** | **no** | changes the brief's formula |
| Uniform top-tier collateral | yes | yes | yes | changes what `commit` pulls |
| **Withdrawal precondition** | **yes** | **yes** | **yes** | **chosen** |

The clamp deserves its own note, because it looks safe and is not. Commit 50 sybils
to unlock the bottom tier, commit for real at that bottom price, then withdraw the
sybils: the clamp drags settlement to the bottom tier for everyone. On the campaign
curve, 25 honest buyers pay the supplier $18.75, while the same 25 reached by
sybil-and-withdraw pay $12.50. The sybils are refunded in full, so the attack costs
only gas.

Uniform top-tier collateral is sound and was implemented for two turns before being
reverted. It is a bigger change than the problem requires: it alters what `commit`
pulls, flattens the tiered refunds the brief's worked example describes, and removes
the "you pay what you see" property. Its one genuine advantage is noted under
[gasless commits](#gasless-commits-and-the-authorization-race).

## Gasless commits and the authorization race

An EIP-3009 authorization is signed for a **fixed amount**. Under commit-time
escrow the live price can fall between a buyer signing and the relayer submitting,
which invalidates the authorization and fails the commit.

This is a real problem and it belongs to the relayer, not the contract. The relayer
must sign for the price it quotes and resubmit against the new price if the tier
breaks underneath it, surfacing that as a retry rather than a failure. Budget for it
in Turn 4; it is the one place where the collateral design would have been simpler.

## Edge cases the contract must get right

| Case | Required behaviour |
|---|---|
| Withdrawal un-breaks a tier | Live price goes back **up**. A tier is not sticky. |
| Withdrawal would strand a buyer | Refused with a named error. Binds only on a tier threshold. |
| Buyer removal from the middle | Swap-and-pop; no stale index, no array corruption. |
| Boundary | `n >= tier.minBuyers`, not `>`. Buyer 25 exactly triggers tier 2. |
| Below minimum | `refundAll` returns each buyer their own escrow in full. |
| State machine | `Open → Settled` or `Open → Refunded`. Mutually exclusive, each once. |
| No dead ends | No deal past its deadline may have both `settle` and `refundAll` reverting. |
| Blocklisted participant | Credited to `claimable`; cannot block anyone else. Pull, never push. |
| Dust | Contract USDC balance is exactly 0 after all claims. |
| Pause | Halts `postDeal` and `commit`. Never `settle`, `refundAll` or `claim`. |
| Randomness | None needed. `block.prevrandao` is always 0 on Arc — say so in the write-up. |

## Other defects found in the brief

**The headline worked example cannot be posted under the brief's own v1 rules.**
Its example curve is $10 / $8 / $6, but its v1 spec caps unit price at 5 USDC, and
51 buyers at $10 means $456 of peak escrow against a stated working-capital budget
of $15–25. Keep the cap and run the campaign on the same curve shape inside it
($1.00 / $0.75 / $0.50). The $10/$8/$6 numbers stay in the write-up as an
illustration, where clearer round numbers help a reader.

**The brief's test 1 asserts the wrong refund split.** It says "51 buyers clear at
the lowest tier and **the first 8** are refunded the full difference", and its
worked example says 8 / 19 / 24. That split comes from the example's narrative
timeline, not from the curve's thresholds. Under the stated curve what matters is
the buyer count when each person commits, which lands at 25 / 50 — so the split is
**24 / 25 / 2**. The brief's figures are internally consistent ($306 + $70 = $376)
but only against an implied curve breaking at 9 and 28 buyers, which is not the
curve it states.
