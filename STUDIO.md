# How Swarm was built in Arc Studio

Project: https://studio.arc.io/app/2fe1f645-9652-481c-a05d-bc8d769c63c9
Turns: in progress, from 19 October 2026

Every turn below was run through the Arc Studio CLI (`@circle-fin/arc-studio-cli`
v1.2.1) with `--output json`. The exact prompt for each turn is committed under
`studio/prompts/`; the result document Studio returned is committed under
`studio/runs/`. Nothing here is reconstructed after the fact.

## Turn 0 — before Studio (and why)

Arc Studio writes the contracts, tests and frontend. It was given a spec that had
already been checked, because two defects in the source brief would otherwise have
been baked straight into the Solidity.

The mechanism was first modelled as plain integer arithmetic in
[`tools/curve.mjs`](tools/curve.mjs) — clearing price, per-buyer refunds, supplier
credit, conservation — and fuzzed over 20,000 random commit/withdraw sequences.
That turned up:

1. **The brief's headline curve ($10/$8/$6) violates the brief's own 5 USDC v1
   price cap**, and implies $456 of peak escrow against a $15–25 working-capital
   budget. Resolved by keeping the cap and running the campaign on the same curve
   shape inside it ($1.00/$0.75/$0.50).
2. **The brief's test 1 asserted the wrong refund split** — "the first 8 buyers
   refunded $4 each". Under the stated curve the split is 25/25/1, not 8/19/24;
   the 8/19/24 figures came from the example's narrative timeline rather than the
   curve's thresholds. Passing that to Studio verbatim would have produced either
   a failing test or a contract bent to satisfy a wrong expectation.

Both are written up in [`docs/mechanism.md`](docs/mechanism.md).

Chain facts were re-verified against the live Arc docs rather than taken from the
brief ([`docs/arc-facts.md`](docs/arc-facts.md)). Every address and chain ID in the
brief checked out. Two useful things the brief did not have turned up: the USDC
**system emitter** (`0xffff…fFFfE`), which logs all USDC transfers chain-wide and
simplifies the `/proof` page, and a **known-blocklisted testnet address**
(`0x7099…79C8`), which lets the pull-safety test run against the real blocklist
instead of a mock.

## Turn 1 — core contracts

Prompt: [`studio/prompts/turn-01-contracts.md`](studio/prompts/turn-01-contracts.md)
Result: [`studio/runs/turn-01.json`](studio/runs/turn-01.json) · status `needs_input`

**Studio generated** four contracts — `SwarmTypes.sol`, `DealFactory.sol`,
`DemandPool.sol`, `Settler.sol` (18 / 144 / 173 / 143 lines). It started from an
OpenZeppelin scaffold, used manual owner logic rather than importing `Ownable`,
and ran two auditors plus a structure digest over its own output before replying.

**What it got right without being asked.** Custom errors rather than require
strings. Swap-and-pop buyer removal with the index map kept consistent, including
the case where the withdrawer is the last element. `claimable` accumulating across
deals rather than per deal. A settler-only `setDealState` enforcing `0 → 1` or
`0 → 2` and nothing else. It also honoured every Arc-specific constraint in the
prompt: no `msg.value`, no `block.prevrandao`, `block.timestamp` for deadline
comparison only, and the 6-decimal ERC-20 interface throughout.

**What it got wrong, and I caught in review.**

- `commit()` never emitted `TierBroken`. The downward break is the entire product
  and it produced no event at all; `withdraw()` emitted it for upward moves only.
  Both the frontend and `/proof` key off that event.
- `withdraw()` pushed USDC directly with `USDC.transfer(msg.sender, amount)`.
  Arc reverts transfers to blocklisted addresses, so a blocklisted buyer could not
  withdraw at all — and the prompt had asked for pull payments everywhere.
- The conservation check was a bare `assert`, which raises `Panic(0x01)` and burns
  all remaining gas, turning a detectable accounting bug into an expensive
  mystery.

**What it found that I had also found independently.** Its functional auditor
reached the withdrawal squeeze: a withdrawal raises the live price, so a buyer who
committed at high volume can owe more at settlement than they escrowed, and
`paid - cp` underflows. I had reached the same failure from the other direction,
by modelling the mechanism in `tools/model.mjs` and fuzzing it — it arises in about
0.5% of random commit/withdraw sequences. Two independent routes to the same bug is
the most reassuring thing that happened all day.

Its reasoning is worth reading in full
([`studio/runs/turn-01.finalText.md`](studio/runs/turn-01.finalText.md)): it
cycles through top-up-on-withdrawal, `refund = paid > cp ? paid - cp : 0`,
deducting the shortfall from supplier credit, and capping the clearing price at the
minimum escrow, rejecting each in turn — "no, that breaks the spec", "but then
supplier doesn't get a uniform clearing price", "but that violates conservation" —
before implementing per-buyer `min(escrowed, cp)` and stopping to ask rather than
deciding for me. Stopping to ask was the right call and it is the single most
useful thing Studio did in this turn.

**Where I disagreed with its answer.** Per-buyer `min(escrowed, cp)` is solvent and
does prevent the fund-lock, but it means different buyers pay different amounts for
the same deal, which forfeits the single-clearing-price property the entire product
and the whole "why Arc" argument rest on. I was not willing to make that claim
99.5% true. My own candidate — clamping the clearing price to the lowest escrow —
keeps one price but I then found it gameable: commit at the bottom tier,
mass-withdraw, and settlement drags to the bottom tier for everyone at the
supplier's expense ($12.50 instead of $18.75 on the campaign curve).

So neither of our fixes was good enough, and the answer was to remove the failure
rather than handle it. See Turn 1b.

## Turn 1b — uniform top-tier collateral

Prompt: [`studio/prompts/turn-01b-fixes.md`](studio/prompts/turn-01b-fixes.md)

Answered the planning question with `fix_first` and specified the mechanism change:
every buyer escrows `tiers[0].price` — the top of the curve — whenever they commit,
and is refunded down to the clearing price at settlement.

This deviates from the brief, which says commit "escrows the CURRENT tier price".
The deviation is deliberate and it is the most substantive engineering decision in
the project: under uniform collateral nobody can be underwater, so the clearing
price is always the volume-unlocked tier price, every refund is identical, there is
no per-buyer rounding, withdrawals need no restrictions, and conservation is
trivially exact. It also removes a race in gasless commits that neither the brief
nor Studio had spotted — an EIP-3009 authorization is signed for a fixed amount, so
a commit price that moves between signing and relaying would invalidate it.

Result: [`studio/runs/turn-01b.json`](studio/runs/turn-01b.json)

Studio confirmed `claimable` accumulates across deals and is never reset, applied
all five changes, and then **found two more bugs on its own** while re-auditing —
both real:

- `commit()` and `withdraw()` had no guard for the window before `setSettler` had
  been called. A buyer could be removed from the buyer array while the credit for
  their collateral was silently dropped, because `withdraw()` now routes the
  refund through the settler. It added a `SettlerNotConfigured` error to both.
- `postDeal` allowed `minBuyers > cap`, which makes settlement permanently
  unreachable — the deal can only ever refund. It added `InvalidConfiguration`.

The second one is the kind of thing a human reviewer skims past, and it found it by
running its functional auditor against its own output twice in a row.

**What went wrong operationally.** The CLI lost the response stream
(`Lost the response stream (terminated)`), which cancels an attached turn
server-side. The contract edits had already landed but the testnet deploy never
ran. The fix is `--detach` plus `arc-studio attach`, which is what every
subsequent turn uses. Worth knowing before trusting a 20-minute deploy turn to a
live connection.

**Review of the pulled contracts** (`onchain/contracts/`, 477 lines across four
files — pulled rather than read from the chat, because the result document's prose
is not evidence):

The collateral redesign is implemented correctly. `Settler.settle` reads
`collateral(dealId)`, credits every buyer an identical `top - cp`, credits the
supplier `cp × buyerCount`, and checks conservation with a named
`ConservationViolation` error. `withdraw()` routes through
`ISettler.creditWithdrawal` rather than pushing USDC. `TierBroken` now fires from
both `commit()` and `withdraw()` whenever the live price moves.

`DealFactory.postDeal` validation is genuinely thorough: non-empty tiers, the
5 USDC price cap per tier, strictly ascending `minBuyers`, strictly descending
prices, a reachable first tier, a future deadline, `cap` within 1–100,
`minBuyers <= cap`, and the bottom tier reachable within `cap`. That strict descent
is now load-bearing for solvency — it is what guarantees `tiers[0].pricePerUnit` is
the maximum, so the `uint64` subtraction `top - cp` in `settle` cannot underflow.

Three residual defects I found in review, carried into Turn 1c:

- A zero tier price is accepted. Strict descent means only the bottom tier can be
  zero, but that is a deal which settles while paying the supplier nothing.
- `minBuyers == 0` is accepted and creates a permanently wedged deal: `refundAll`
  can never run because `buyers.length >= 0` always holds, while `settle` with zero
  buyers reads `collateral` as 0 and underflows `top - cp`. Both exits revert. No
  funds at risk, but it falsifies the property that no deal past its deadline can
  have both exits revert.
- `collateral[dealId]` is set lazily on the first `commit`, which is the root cause
  of the above and also reads as zero for a posted deal nobody has joined — the
  frontend needs it before the first buyer arrives.

And one thing the prompt should have specified and did not: the events do not carry
the amounts. `Committed` emits only `livePrice`, never the collateral actually
pulled, and `Refunded` emits only a buyer count. So USDC moved could not be totalled
from logs alone, which defeats the point of a `/proof` page that reads from chain.
Turn 1c enriches all six events.

## Turn 1c — residual fixes, event payloads, testnet deploy

Prompt: [`studio/prompts/turn-01c-events-and-deploy.md`](studio/prompts/turn-01c-events-and-deploy.md)

_Result:_ _pending_

## Turn 2 — tests

Prompt: [`studio/prompts/turn-02-tests.md`](studio/prompts/turn-02-tests.md)

_Tests generated:_ _pending_
_Failed on first run:_ _pending_

## Turn 3 — frontend

Prompt: [`studio/prompts/turn-03-frontend.md`](studio/prompts/turn-03-frontend.md)

_pending_

## Turn 4 — gasless commits

Prompt: [`studio/prompts/turn-04-gasless.md`](studio/prompts/turn-04-gasless.md)

_pending_

## Turns 5+

| Turn | Intent | What changed |
|---|---|---|
| _pending_ | | |

## What Studio did well / badly

_Two honest paragraphs, written at the end. Reviewers trust candour, and a log that
reads like nothing ever went wrong reads like a log that was written afterwards._
