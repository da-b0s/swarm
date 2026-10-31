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
Result: [`studio/runs/turn-01c.json`](studio/runs/turn-01c.json) · status `completed`

All three fixes applied, all six events enriched, and the first successful deploy to
Arc testnet. Verified independently with `viem` rather than taken from the result
document — the three addresses hold 4297, 5212 and 4265 bytes of code, and
`DealFactory.demandPool`, `DealFactory.settler` and `DemandPool.settlerSet` all read
back empty, which confirms its own report that the wiring had not run.

Two operational notes worth carrying forward: it **deployed twice**, producing two
complete sets of contracts in one turn, and the **wiring did not get done** — it
reported the testnet RPC timing out and handed back three calls for me to send
manually, leaving the deployment unusable. Both are now called out explicitly in the
next prompt.

## Turn 1d — reverting to the specification

Prompt: [`studio/prompts/turn-01d-revert-to-spec.md`](studio/prompts/turn-01d-revert-to-spec.md)

**This turn exists because the collateral decision was wrong, and it is worth being
straight about why.**

The withdrawal squeeze is a genuine contradiction in the brief: `commit` escrows the
current tier price, *and* a tier must be able to un-break — and any un-break leaves
the newest buyer owing more than they escrowed. Having found it, I replaced the
escrow model with uniform top-tier collateral. That is solvent, but it was the wrong
instinct: it changed what `commit` pulls, flattened the tiered refunds the brief's
own worked example describes, and discarded the "you pay what you see" property —
all to fix something that needed one precondition.

The smaller fix keeps every sentence of the spec and adds a precondition to
withdrawal: **a buyer may not exit if their exit would leave someone still in the
deal below the resulting clearing price.** Modelled before asking Studio for
anything, it holds up:

- The brief's test 6 passes as written — the marginal buyer withdraws, the tier
  un-breaks, a new commit re-breaks it.
- `claimable[supplier] += clearing * buyers.length` is preserved, which the brief
  writes out as code, and which the collateral version also kept but Studio's
  `min(escrowed, clearing)` did not.
- The precondition binds **only when the buyer count sits exactly on a tier
  threshold** — refused at 25 and 50, free at 24, 26, 30 and 51. Fuzzed, 1.8% of
  withdrawal attempts are refused, and one further commit clears a refusal.
- Over 50,000 random sequences: no conservation failures, no stranded buyers, no
  deviation from `clearing × buyerCount`.

A fourth candidate was ruled out along the way and is worth recording because it
looks safe and is not. Clamping the clearing price down to the lowest escrow keeps a
single price and is solvent, but it is sybil-exploitable: commit 50 sybils to unlock
the bottom tier, commit for real at that price, then withdraw the sybils. The clamp
drags settlement to the bottom tier for everyone — the supplier takes $12.50 instead
of $18.75 on the campaign curve — and the sybils are refunded in full, so the attack
costs only gas.

The lesson, recorded because it is the honest one: having found a real contradiction
in a specification, the first move should be to look for the narrowest change that
satisfies it, not to replace the mechanism. Two Studio turns went into collateral and
this one unwinds them.

Result: [`studio/runs/turn-01d.json`](studio/runs/turn-01d.json) · status `needs_input`

The revert landed, and the withdrawal precondition is implemented well. Rather than
loop the buyer array on every withdrawal, it keeps a per-deal tally of how many
buyers sit at each tier price and scans tiers from cheapest upward for the first
with a remaining buyer — bounded by tier count, not buyer count. Measured later at
**58,088 gas for a withdrawal out of 60 buyers**, flat rather than linear.

Its functional auditor flagged the precondition as wrong; Studio worked through the
scenario, concluded the finding was a false positive, and explained why. Checked
against the model independently at 24, 25, 26 and the test-6 case, its reasoning was
correct — which is worth recording, because an agent that can defend its own code
against a bad review is more useful than one that changes it on every complaint.

It then added a `block.chainid != 5042002` guard to all three constructors as a
"security improvement". **That would have made the mainnet deploy revert in the
constructor**, on chain 5042, which is the entire point of the project. Caught in
review; removal requested in the next turn. Running the suite locally afterwards
proved the guard was breaking the tests too — `setUp()` reverted `WrongChain()` at
Foundry's chain id 31337.

**Why this turn ended in `needs_input`.** It deployed three contracts, could not
wire them, and asked to create a **Standard Developer API Key on the Circle account,
granting access to all developer products**, written into the project. Declined.
The underlying constraint is structural: Studio deploys from a Circle-managed SCP
wallet whose key its sandbox does not hold, so it can create contracts but cannot
send the three owner transactions that connect them. That is why deployment moved
out of Studio entirely — see [`docs/deploy.md`](docs/deploy.md).

## Turn 2 — chain guard removal and the test suite

Prompt: [`studio/prompts/turn-02-guard-and-tests.md`](studio/prompts/turn-02-guard-and-tests.md)
Result: [`studio/runs/turn-02.json`](studio/runs/turn-02.json) · status `completed`

Removed all three `WrongChain` guards and wrote the suite: `SwarmTest.t.sol` plus
three mock helpers (`MockERC20`, `MockBlocklistedERC20`, `MockReentrantERC20`).

**It reported "Tests complete" with no output at all.** The workspace said otherwise:
`cache/test-failures` named `test_ReentrancyOnClaim`, and there was a persisted fuzz
counterexample for `testFuzz_Conservation` with args `55, 60`. Both turned out to be
**stale artifacts** from earlier in the same turn rather than the final state — the
suite was in fact green — but there was no way to know that from the reply, which is
the problem. A suite reported green without evidence is worth nothing.

## Turn 2b — the actual test output

Prompt: [`studio/prompts/turn-02b-test-results.md`](studio/prompts/turn-02b-test-results.md)
Result: [`studio/runs/turn-02b.json`](studio/runs/turn-02b.json) · status `completed`

Asked for the complete unedited output and got it, matching a local run
figure-for-figure. **19 passed, 0 failed**, with conservation, uniform-price and
no-dead-end each fuzzed at 256 runs. `settle(100 buyers)` is **1,475,504 gas**.

It also agreed `test_ReentrancyOnClaim` was badly structured and rewrote it. The
original built a 51-buyer scenario, settled it, decided the scenario was "not
interesting" because the reentrant buyer's refund came out at zero, then called
`setUp()` from inside the test body and started again — leaving the first half as
dead code whose gas still counted. Rewritten as one scenario, its gas fell from
**21.8M to 9.7M**, and Studio's own read was that the earlier recorded failure was
most likely that mid-test `setUp()` leaving the etched mock and the settler address
mismatched.

**The habit that paid off here:** the suite is now run locally with
`arc-forge test`, against `forge-std` pulled from the workspace and OpenZeppelin
5.1.0 from `node_modules`. Test results come from this machine, not from a
description of them. Nine other tests still call `setUp()` mid-body for
parameterised scenarios — it works and they pass, but it inflates their gas and is
worth tidying if time allows.

## Turn 3 — frontend

Prompt: [`studio/prompts/turn-03-frontend.md`](studio/prompts/turn-03-frontend.md)
Result: [`studio/runs/turn-03.json`](studio/runs/turn-03.json) · status `completed`

**The turn outlived the CLI.** The attached run hit the 30-minute timeout and the
local log ends with "It may still be running". It was: the turn had finished
server-side, and `arc-studio ls` showed the whole `src/swarm/` tree sitting in the
workspace. Nothing had to be re-run. Worth knowing that a CLI timeout says nothing
about whether the work completed — check `ls` before spending another turn.

**Studio generated** 19 files, ~4,400 lines: `DealRoom`, `PriceHero`,
`TierProgress`, `CommitFlow`, `SupplierView`, `ProofPage`, plus `config`, `abis`,
`hooks`, `useEventLog` and `utils`. tsc and oxlint clean in the sandbox.

**What it got right, including the hard part.** The withdrawal precondition is
replicated client-side correctly — `computeClearingPrice` and the lowest-escrow
scan in `utils.ts` match `_clearingPriceAt` and `_lowestEscrowedExcluding` branch
for branch, including the `newCount == 0` guard. The button is disabled with a
plain-language reason before anything is signed, which is what the prompt asked
for and the thing most likely to have been fudged. All seven event signatures
match the compiled ABIs exactly, checked against `out/*.json` rather than against
the prompt. `SupplierView` mirrors every one of `postDeal`'s validation rules.
Configuration is centralised rather than buried in components, and the log scanner
pages with backoff.

**What it got wrong, and I caught in review.**

- **The network configuration was inverted, and it is the worst defect in the
  project so far.** The verified testnet addresses were recorded as `mainnet`,
  while the `testnet` entry held `0x70e334…`, `0x257d…`, `0x9c5cfe…` — Studio's
  own sandbox deployment from Turn 1d, the one it could not wire — labelled
  "v3 testnet deployment (wired externally)". It had read its own `deployments`
  list and treated it as fact. Combined with `ACTIVE_NETWORK` defaulting to
  `'mainnet'`, the app shipped pointing at chain 5042 at three addresses holding
  **zero bytecode**, where the first thing a visitor is asked to do is approve
  USDC. Verified from chain in both directions: the real set passes all 15
  `verify-deploy` checks on testnet, Studio's set fails the four wiring checks
  (`settlerSet: false`, so `commit` and `withdraw` revert), and the default
  config fails all 14 on mainnet. Mainnet is now explicitly `deployed: false`
  with zero addresses, the default is testnet, and a banner plus a
  `DEPLOYMENT_READY` flag refuses the undeployed case.
- **`useBlockCountdown` read the browser clock** — the prompt said block
  timestamps specifically, the function was named for them, and its comment
  rationalised the shortcut ("the deadline IS a unix timestamp"). But the contract
  decides with `block.timestamp`, so a viewer whose clock runs fast sees "Ended"
  while commits still succeed, and one running slow is offered a button that
  reverts. Replaced with `useChainNow`, which anchors on the latest block and
  ticks from measured elapsed time rather than the clock's absolute value.
  `SupplierView` had the same bug where it mattered more — it set each deal's
  deadline from `Date.now()`, so a skewed clock would have skewed the real
  duration of every campaign.
- **`approve()` was for the exact price on screen.** The contract escrows the
  live price when the commit lands, and a withdrawal can un-break a tier and push
  that price *up* between the two transactions — the commit then reverts on
  allowance. Now approves `tiers[0]`, the curve's maximum, which the contract's
  strictly-descending rule guarantees is an upper bound on what it can pull.
- **An allowance failure was reported as "Insufficient USDC balance"**, because
  the generic `insufficient` branch sat above any allowance check. That sends
  someone to top up a wallet that was never short.
- **The default deal was id 0**, which cannot exist — ids start at `++dealCount`.
  A first-time visitor saw a nonexistent deal rendered as expired, with a "Settle
  deal" button. Now lands on the newest deal, with a real empty state when there
  are none.
- **The nav overflowed at 375px**, clipping the wallet button off-screen, in a
  build whose prompt begins "mobile-first" and whose demo is filmed on a phone.

**One thing it did that I would rather it had not.** Facing lint errors in the
obsolete `scripts/wire-swarm*.ts`, it added them to `ignorePatterns` and the
tsconfig excludes to get a green check. The scripts are genuinely dead — wiring
moved out of Studio in Turn 1c — so deleting them was available and honest.
Suppressing a check to make it pass is a habit worth catching early in something
that will be reviewed.

The pulled frontend passes `tsc --noEmit` and `oxlint --type-aware` locally after
these fixes, builds, and was exercised against the verified testnet deployment in
a browser: deal room, tier builder with its live curve chart, and the proof page
all render, and the nav fits at 375px.

Local toolchain note: the sandbox uses bun, and `npm install` fails outright here
because `vite-plugin-node-polyfills@0.22.0` declares a peer range of vite ≤5
against this project's vite 6. bun does not enforce peer ranges, so it never
surfaced in Studio. `npm install --legacy-peer-deps` is correct — the plugin works
under vite 6; the metadata is just stale.

## Turn 3b — review fixes, and what the live run found

Prompt: [`studio/prompts/turn-03b-review-fixes.md`](studio/prompts/turn-03b-review-fixes.md)
with [`turn-03b-review-fixes.patch`](studio/prompts/turn-03b-review-fixes.patch), sent as a
read-only file under `context/`
Result: [`studio/runs/turn-03b.json`](studio/runs/turn-03b.json) · status `completed` · ~2% of the 30-day limit

Two reasons for this turn. First, the Turn 3 review fixes were made locally, so
the Studio workspace and the repo had diverged in eight files — and a later turn
touching any of them could not have been pulled cleanly. The patch puts them back
in step, and it goes through Studio rather than around it so the workspace stays
the source of the frontend.

Second, running the whole lifecycle against live testnet deals
([`docs/testnet-lifecycle.md`](docs/testnet-lifecycle.md)) found two defects the
review had not: "Recent commits" renders storage order, which swap-and-pop
scrambles on the first withdrawal; and the `/proof` scanner reads
`rate limit exceeded` as a range error and retries with no delay, which causes
the very rate limiting it is reacting to. Both were measured before being
written up, so the prompt carries real window sizes rather than guesses.

**Result.** The patch landed: pulled back and diffed against the repo, four of
the eight patched files came back byte-identical, and the others differ only
where the new work touched them. Its summary said the patch was applied
"exactly", which was not quite true and was better than true: rather than keep my
effect that copied the newest deal id into state, it derived the id during
render — same behaviour, one less piece of state, and it satisfies the React
compiler's lint rule that my version only skirted. It also deleted the two dead
wiring scripts and removed their lint and tsconfig exclusions, as asked. tsc and
oxlint output were pasted verbatim, also as asked; that request is now a
standing line in every prompt.

The scanner fix is right: distinct error classes instead of substring matching,
"rate limit" tested before "range", exponential backoff on throttling, and the
window grows back after clean fetches. **Measured in the browser, the full proof
scan from the deploy block fell from a projected ~8 minutes to 33 seconds.**

The activity list is right in approach — events instead of storage order, a single
filter on the indexed `dealId`, links to transactions — and on deal #1 it renders
the true order: buyer 6, 5, buyer 1 marked "left", then 4, 3, 2, each at the price
they paid. But it has an ordering bug that a two-minute test deal cannot show:
the backfill walks backwards window by window and applies each window as it
arrives, so a withdrawal in a newer window than its commit is dropped and the
buyer is shown as still in. Reproduced in isolation with the hook's own
`applyLogs`. Any deal longer than one 5,000-block window — about 42 minutes — is
exposed, which includes the 48-hour campaign.

**And the scan being fast exposed something worse.** With all 23 events loaded,
the proof page reported deal #1 as **"Conservation FAILED"** — refunds $0.00 —
on a deal the lifecycle script had verified to conserve exactly, and showed the
fully refunded deal #2 as "Open". The cause dates from Turn 3, not 3b: `settle()`
emits one `Settled` event carrying `totalRefunds`, and per-buyer `Refunded`
events come only from `refundAll()`; the page summed `Refunded`. It could not
surface until there was a settled deal to scan. The review read this code and
did not catch it — the event signatures matched, so the aggregation looked
plausible. Reading code against an ABI checks the shapes; only running it against
real events checks the meaning.

Both go to Turn 3c.

## Turn 3c — the proof page, and activity ordering across windows

Prompt: [`studio/prompts/turn-03c-proof-and-history.md`](studio/prompts/turn-03c-proof-and-history.md)
Result: [`studio/runs/turn-03c.json`](studio/runs/turn-03c.json) · status `completed`

Both fixes are correct, and this time the code bore out the summary.

The proof page now adds `Settled.totalRefunds` into the deal's refunds, marks a
deal refunded when `Refunded` events arrive, and checks conservation for refunded
deals too. Scanned in the browser from the deploy block, in 25 seconds: deal #1
**$3.75 = $2.50 + $1.25, conservation verified**; deal #2 **refunded, $1.00 =
$0.00 + $1.00, verified**; total refunded $2.25; total claimed $5.75, which is
every claim in the lifecycle run summed. Those are the figures the lifecycle
script had already checked from chain, now reproduced by the page from events
alone.

The activity list now keeps every log it has collected and rebuilds its state
from an empty map in chronological order after each window, so arrival order no
longer matters. Tested rather than read: its shipped `buildEntries`, stripped of
types with esbuild and fed windows newest-first, now reports a buyer whose
withdrawal sits in a later window than their commit as having left, and a buyer
who left and rejoined at their latest price. The same input made the Turn 3b
version show the leaver as still in. Polling now starts only once the backfill has
finished, `lastBlock` only moves forward, and both hooks share one classified
`rpcFetch` in a new `rpc.ts` rather than two copies. The scanner's last hot loop —
retrying forever when even the 500-block floor is refused — now surfaces as an
error.

One judgement call worth recording: if the backfill hits an error that is
neither a rate limit nor a range limit, it keeps the partial list visible and
continues polling rather than clearing it. That is a reasonable choice for a live
screen, but it means a partial history is not flagged as partial.


## Turn 4 — gasless commits

Prompts: [`turn-04-gasless.md`](studio/prompts/turn-04-gasless.md) ·
[`turn-04b-tests.md`](studio/prompts/turn-04b-tests.md) ·
[`turn-04b2-gasless-tests-file.md`](studio/prompts/turn-04b2-gasless-tests-file.md)
Results: [`turn-04`](studio/runs/turn-04.json) · [`turn-04b`](studio/runs/turn-04b.json) ·
[`turn-04b2`](studio/runs/turn-04b2.json)

**The prompt was rewritten before it ran.** The 20 October draft specified
`transferWithAuthorization`. Anyone who sees such a signature can submit it
straight to USDC, landing the buyer's money in the pool with no commit recorded —
funds the contract's accounting never sees and nobody can claim. The rewrite
required `receiveWithAuthorization`, which only the payee can execute, and a
signature bound to a single deal. It also replaced an open question with facts
read from both chains: the USDC domain is `{name "USDC", version "2", chainId,
0x3600…}` on mainnet and testnet alike, the separator matches, and
`receiveWithAuthorization` exists. The draft had hardcoded chain id 5042, which
would have invalidated every testnet signature. And it named the purpose
honestly: on Arc gas is USDC, so a wallet holding USDC can always pay gas; the
gain is committing an entire balance without holding some back.

**The design came back right.** `commitWithAuthorization` uses
`receiveWithAuthorization`; the authorization nonce is
`keccak256(pool, dealId, buyer, salt)`, so a signature cannot be pointed at another
deal or pool; both commit paths share one precondition function; a price that rose
after signing reverts `PriceRoseBeyondAuthorization(newPrice)` before any state
changes; a price that fell escrows the live price and credits the excess through
the existing pool-only `creditWithdrawal`, with an `ExcessCredited` event so the
proof page can account for it.

**Three turns to get there, and why.** Turn 4 and Turn 4b both stopped mid-turn
with no error, each while rewriting the whole of `SwarmTest.t.sol` — the
nineteen existing tests plus the new ones — in a single write; neither reached
`forge test`. Turn 4b2 put the new tests in their own file and left the original
untouched, and finished. The useful lesson is about shape, not effort: ask for
additions as new files, and for a test run before more writing.

Between the stops, Studio did two good things. It turned `AuthorizationAlreadyUsed`
— declared in Turn 4 but never raised — into a real check of `authorizationState`
before the transfer, ordered so a replay gets that error rather than
`AlreadyCommitted`. And it caught a bug in its own test token that review had
missed: the mock computed its EIP-712 domain at construction, but the tests etch
its bytecode onto the USDC address, so the baked-in `verifyingContract` was wrong
and every test signature would have failed. It now rebuilds the domain after the
etch.

**27 tests pass, run locally** in WSL with `arc-forge`, not taken from the pasted
output — the 19 originals unchanged and 8 gasless tests: signer recorded rather
than relayer, excess credited when the price falls, named revert when it rises,
replay, wrong deal, blocklisted buyer, and a fuzz property mixing both commit
paths with excess credits.

Two things to note rather than fix now:

- **`via_ir = true` is now on for the whole project**, added to get past a
  stack-depth error in a test helper. It also changes how the production
  contracts compile — `settle(100 buyers)` moved from 1,475,504 to 1,483,728 gas.
  The cleaner fix is a helper that returns a struct; worth doing before mainnet
  rather than shipping a compiler-pipeline change made for test scaffolding.
- **`test_Gasless_TransferWithAuthCannotCommit` proves an adjacent case.** It has
  the buyer sign a *transfer* authorization, which our flow never asks for. The
  threat that matters is the buyer's *receive* signature being submitted as a
  transfer; that is blocked by EIP-3009's distinct typehashes, which real USDC
  enforces, but this test does not demonstrate it.

## Turn 4c — relayer and gasless frontend

Prompt: [`turn-04c-relayer-frontend.md`](studio/prompts/turn-04c-relayer-frontend.md)
Result: [`turn-04c`](studio/runs/turn-04c.json) · status `completed`

Finished in one turn: a `relayer/` Node service, `GaslessCommitFlow.tsx`, the
regenerated ABI, and `ExcessCredited` on the proof page. tsc and lint clean, both
in its output and run here. The parts that are easiest to get wrong were right:
the 20 gwei floor is applied to both the fee estimate and every bump, priority
fee is 0, the service refuses to start on a chain-id mismatch or a placeholder
key, the key is never interpolated into output, and the two hardcoded event
topic hashes match keccak of the signatures.

Review found the rest needed another pass, queued as Turn 4d:

- **It signs for the curve maximum.** Reasoning carried over from the approve
  flow, where approving the maximum is harmless because an approval is only a
  ceiling. A `receiveWithAuthorization` moves the whole signed amount, so a buyer
  joining at $0.50 would need — and lose to the contract until claimed — $1.00.
  That defeats the feature's one purpose.
- **One failed send poisons the queue.** Sends are serialised by reassigning a
  single promise chain; a throw leaves it rejected and every later send skips.
- **A failed send leaves a nonce gap** that blocks every later transaction.
- **The replacement loop bumps the fee every two seconds** once it starts,
  because the next replacement time is never moved forward: about fifteen bumps,
  ending near fifteen times the starting fee.
- **A mined original is reported as a failure** when a replacement was sent,
  because only the latest hash is checked.
- A fixed 300,000 gas limit instead of estimating after the simulation it already
  runs; and CORS defaulting to `*`.

None of these appear in a single happy-path request, which is exactly the test
that would have passed.

## Turn 4d — relayer hardening

Prompt: [`turn-04d-relayer-hardening.md`](studio/prompts/turn-04d-relayer-hardening.md)
Result: [`turn-04d`](studio/runs/turn-04d.json) · status `completed`

All seven fixes landed and read correctly: the send queue chains on a promise
that cannot reject, a failed send resets the nonce and re-reads it with the
`pending` tag, the replacement timer moves forward with a 5x fee cap, every hash
sent for a nonce is checked for a receipt, gas is estimated with a 20% margin,
and CORS refuses by default. The frontend now signs for the clearing price at
the current count — I had asked for count plus one, but this is the safe
direction: if the buyer's own commit breaks a tier, they pay less and the
difference is credited back.

**Then it was run, not just read.** The contracts were redeployed to testnet for
the new pool, the relayer was started against it, and
[`tools/gasless-testnet.mjs`](tools/gasless-testnet.mjs) drove a deal through it
with each case forced by the order of events:

- a plain gasless commit: the buyer's balance fell by **exactly $1.00** — the
  price and nothing else, so the buyer paid no gas;
- signed at $1.00, landed after another buyer broke a tier: escrowed **$0.50**,
  **$0.50** credited back and visible in `claimable`;
- settlement at $0.75: **$1.75 committed = $1.50 supplier + $0.25 refunds**,
  every claim matched, the pool ended at **$0**;
- the relayer spent **$0.0155** on gas for three relays, about half a cent each,
  and its log held deal, buyer, transaction, block, price, excess and gas cost —
  no key, no signature.

And one failure, which reading the code had missed: with the price risen above the
authorization, the contract reverted `PriceRoseBeyondAuthorization(750000)` in
simulation exactly as designed, nothing was broadcast, the buyer's balance did not
move — and the relayer answered **400 with viem's whole error text instead of
409**. viem's revert error carries `data` already decoded; the relayer passed it to
`decodeErrorResult` as if it were hex, which threw, and the raw error fell through.
So no named contract error ever reached the status mapping, and the frontend's
re-sign flow, which only runs on 409, could never have fired. A replay was refused
the same way. Queued as Turn 4e.

## Turn 4e — relayer error mapping

Prompt: [`turn-04e-relayer-errors.md`](studio/prompts/turn-04e-relayer-errors.md)
Result: [`turn-04e`](studio/runs/turn-04e.json) · status `completed` · `relayer/server.ts` only, as scoped

The relayer now walks viem's error chain to the `ContractFunctionRevertedError`
and reads its already-decoded name, so named contract errors reach the status
mapping. Anything unrecognised returns an opaque 500 and is logged server-side
only; viem's message text, which echoes the buyer's signature, no longer reaches
a client. A field sent as the number 0 is accepted, and a rejected replacement
now advances the bump timer like a successful one.

Verified by running, not reading. The same end-to-end scenario on testnet, with
the checks tightened:

- price risen after signing: **`409 {"error":"PriceRoseBeyondAuthorization","requiredPrice":"750000"}`**
  — exactly what the frontend's re-sign flow keys off, and checked to carry no
  viem text or signature;
- replay: **`400 {"error":"AuthorizationAlreadyUsed"}`**, the name and nothing else;
- the re-signed commit sent with `validAfter` as the number 0, accepted;
- every money check from the first run passed again.

That closes the gasless work: contract, 27 tests, relayer and frontend, each
proven on a live chain.


## Turn 5 — pre-mainnet cleanup

Prompt: [`turn-05-pre-mainnet-cleanup.md`](studio/prompts/turn-05-pre-mainnet-cleanup.md)
Result: [`turn-05`](studio/runs/turn-05.json) · status `completed` · two files, as scoped

`via_ir` is out of `foundry.toml`; the stack-depth problem it papered over is
fixed in the test instead, by having the signing helper return a struct. The
production contracts compile as they did before Turn 4b2: `settle(100 buyers)` is
back to **1,475,533** gas from 1,483,728.

The `transferWithAuthorization` test now proves the case that matters. It signs a
`ReceiveWithAuthorization` exactly as the gasless flow does, submits that same
signature to `transferWithAuthorization` on the token, and asserts it reverts with
the buyer's balance, the pool's balance and the buyer count all unchanged — then
shows the same signature still commits through `commitWithAuthorization`. The two
authorization types have different typehashes, so a signature for one cannot
verify as the other.

27/27, run here. The testnet deployment from 22 October was compiled with
`via_ir`; mainnet will be compiled from this source. Behaviour is the same, and
the suite proves it, but the bytecode is not identical.

## Turns 6–13

| Turn | Intent | Prompt · result | Outcome |
|---|---|---|---|
| 6a | Swarm v2 contracts: buyers choose quantities, unit-based tiers, goods delivered as tokens, Swarm Pass | [turn-06a-v2-contracts.md](studio/prompts/turn-06a-v2-contracts.md) · [turn-06a](studio/runs/turn-06a.json) | Five contracts rewritten from docs/mechanism-v2.md; its own smoke test found that settlement needed the factory to release goods to the settler, and it added that. |
| 6b | SafeERC20 for goods, and the v2 core suite | [turn-06b-v2-core-tests.md](studio/prompts/turn-06b-v2-core-tests.md) · [turn-06b](studio/runs/turn-06b.json) | 36/36 locally. |
| 6c | v2 gasless suite (EIP-3009 with quantity bound into the nonce) | [turn-06c-v2-gasless-tests.md](studio/prompts/turn-06c-v2-gasless-tests.md) · [turn-06c](studio/runs/turn-06c.json) | 45/45 locally. |
| 6d1 | v2 buyer frontend | [turn-06d1-v2-buyer-frontend.md](studio/prompts/turn-06d1-v2-buyer-frontend.md) · [turn-06d1](studio/runs/turn-06d1.json) | Quantity picker, unit-based tier progress, token delivery shown to buyers. |
| 6d2 | Supplier view, proof page and relayer for v2 | [turn-06d2-v2-supplier-proof-relayer.md](studio/prompts/turn-06d2-v2-supplier-proof-relayer.md) · [turn-06d2](studio/runs/turn-06d2.json) | Deployed to testnet from our deployer and verified end to end; deal #4 opened for hands-on testing. |
| 7a | v2.1: buyers can add to an order | [turn-07a-topup-contract.md](studio/prompts/turn-07a-topup-contract.md) · [turn-07a](studio/runs/turn-07a.json) | Each lot priced at its own tier; refunds use the buyer's cheapest lot. 56/56 locally. |
| 7b | Top-up frontend, plus a patch of fixes made outside Studio after testing with MetaMask | [turn-07b-topup-frontend.md](studio/prompts/turn-07b-topup-frontend.md) · [turn-07b](studio/runs/turn-07b.json) | Patch applied as given; testnet redeployed as v2.1. |
| 8a | v2.2: partial withdrawals, paid straight to the wallet | [turn-08a-partial-withdraw.md](studio/prompts/turn-08a-partial-withdraw.md) · [turn-08a](studio/runs/turn-08a.json) | Falls back to a claimable credit for a blocklisted address. 67/67 locally. |
| 8b | One order panel, partial-withdraw UI, always-visible claims, deal list | [turn-08b-frontend-ux.md](studio/prompts/turn-08b-frontend-ux.md) · [turn-08b](studio/runs/turn-08b.json) | Testnet redeployed as v2.2 and verified end to end. |
| 9 | Sync only: homepage with live stats, light/dark theme, auto-settlement copy, newest-first proof page | [turn-09-sync-local-work.md](studio/prompts/turn-09-sync-local-work.md) · [turn-09](studio/runs/turn-09.json) | Patch of local work applied exactly; Studio's src/ pulled back and diffed: identical to the repo. Contracts already identical. Studio returned no prose for this turn, so the diff is the evidence. |
| 10 | EURC replaces Swarm Pass as the good sold on mainnet; token amounts shown in whole tokens; EURC picker on the Sell page | [turn-10-eurc.md](studio/prompts/turn-10-eurc.md) · [turn-10](studio/runs/turn-10.json) | tsc and oxlint clean (its own output). Pulled and reviewed; formatter checked in the running app (1000000 at 6 decimals shows as "1"). Contracts unchanged: they already sell any ERC-20. Rehearsed on a local mainnet fork with real EURC: lifecycle 42/42, gasless 33/33, top-up 32/32, keeper 3/3, and a frozen-buyer case where settlement still succeeds for everyone. |
| 11 | Repoint the app at the mainnet deployment and make mainnet the default | [turn-11-repoint-mainnet.md](studio/prompts/turn-11-repoint-mainnet.md) · [turn-11](studio/runs/turn-11.json) | Exactly two files changed; the three addresses match the deployment. Deployed from our own deployer with tools/deploy-mainnet.sh (Studio cannot deploy to mainnet); runtime bytecode on chain identical to the tested build. Mainnet build checked in the browser: chain 5042, EURC, live stats from chain, no testnet wording. |
| 12 | Sell-page fixes from mainnet testing: EURC per unit accepts decimals, short durations, no premature balance warning, copy | [turn-12-sell-page-fixes.md](studio/prompts/turn-12-sell-page-fixes.md) · [turn-12](studio/runs/turn-12.json) | The real bug: parseInt("0.5") || 1 posted 1 EURC per unit while the page showed 0.5. Now parseUnits, one value for display, deposit, approval and postDeal. Checked in the running mainnet build: 0.5 per unit x 4 units = 2 EURC deposit, 0.5 h accepted ("Closes in 30 minutes"), no warning on open. |
| 13 | RPC load: the live site hit HTTP 429 from the public Arc RPC (85 requests in 20 s from one tab) | [turn-13-rpc-load.md](studio/prompts/turn-13-rpc-load.md) · [turn-13](studio/runs/turn-13.json) | Root cause it found: the chain clock fetched every block (~2/s). Now one block a minute plus a local tick; Multicall3 batching on; polling from named constants (10 s / 15 s / 30 s); nothing polls in a hidden tab; retries with backoff. |
| 13b | Spread reads across all four official Arc RPC endpoints | [turn-13b-rpc-fallback.md](studio/prompts/turn-13b-rpc-fallback.md) · [turn-13b](studio/runs/turn-13b.json) | viem fallback() over the endpoints in viem's own Arc chain definition; all four checked from here to answer chain 5042 and allow the site's origin. Measured on a deal page: 19 JSON-RPC requests in 30 s (0.63/s), every contract read in one multicall. |
| 14 | Price per token everywhere, market comparison, typeable quantity with +10/+100/Max, five tokens to sell (EURC, GBPA, MXNB, cirBTC, WETH) | [turn-14-price-clarity-tokens.md](studio/prompts/turn-14-price-clarity-tokens.md) · [turn-14](studio/runs/turn-14.json) | Prompted by a real test: a 0.5 EURC unit priced at 1.13 sold EURC at about twice market without the buyer noticing. Those mainnet deals now read "2.22 USDC per EURC (+98% vs market)". Token addresses checked on Arc's explorer first; four of the nine stablecoins we wanted had only look-alike contracts, so they were left out. Homepage volume unchanged ($462.96). |
| 14b | Market rates from CoinGecko instead of Coinbase | [turn-14b-coingecko-rates.md](studio/prompts/turn-14b-coingecko-rates.md) · [turn-14b](studio/runs/turn-14b.json) | Coinbase's endpoint failed from the site's origin in the browser; CoinGecko answered (EUR 1.119, matching Uniswap). |
| 15 | Full-width layout (deal grid with token filter, two-column deal room and Sell page), original hexagon logo and favicon, decorative icons removed | [turn-15-layout-logo.md](studio/prompts/turn-15-layout-logo.md) · [turn-15](studio/runs/turn-15.json) | Checked at 1440 px and 375 px: no sideways scroll. Mainnet numbers unchanged. |
| 15b | Token picker as a dropdown; "Use market price" fills the tiers from the market rate (+2% down to market); logo in the site's accent | [turn-15b-token-dropdown-market-fill.md](studio/prompts/turn-15b-token-dropdown-market-fill.md) · [turn-15b](studio/runs/turn-15b.json) | From user testing: a seller pricing 0.05 WETH units at 1.17 was listing at -99% vs market. |
| 16a | Full-width stats band, "assets on Arc" copy, sell any token by address (reads symbol/decimals on chain, unverified warning) | [turn-16a-stats-copy-custom-token.md](studio/prompts/turn-16a-stats-copy-custom-token.md) · [turn-16a](studio/runs/turn-16a.json) | Deal list and proof page resolve unlisted tokens' decimals on chain too. |
| 16b | Drag-to-edit price curve (mouse, touch, keyboard), synced with the tier inputs, market line | [turn-16b-drag-curve.md](studio/prompts/turn-16b-drag-curve.md) · [turn-16b](studio/runs/turn-16b.json) | Testing it in the app found two bugs, fixed in 16c. |
| 16c | Drag fixes: arrow keys rounded back to the same cent; the chart rescaled mid-drag so dragging up lowered the price | [turn-16c-drag-fixes.md](studio/prompts/turn-16c-drag-fixes.md) · [turn-16c](studio/runs/turn-16c.json) | Scale frozen during a drag, pointer capture. Re-tested: up raises, down lowers, keys step one cent, units capped at stock. |
| 16d | Curve fitted to the prices instead of starting at $0; taller chart | [turn-16d-curve-scale.md](studio/prompts/turn-16d-curve-scale.md) · [turn-16d](studio/runs/turn-16d.json) | A 5-cent ladder was a near-flat line before. |
| 17a | Drag editor kept a stale copy of the tiers (dragging one point reset the others; dragging after "Use market price" restored $1 defaults); no default prices | [turn-17a-drag-stale-state.md](studio/prompts/turn-17a-drag-stale-state.md) · [turn-17a](studio/runs/turn-17a.json) | Reported by the user on a phone. Re-tested the exact sequence: market fill 1.14/1.13/1.12, drag tier 3 to 1.11, drag tier 1 to 1.15: all values kept. |
| 17b | Homepage: live deal beside the headline, price-fall animation, how a deal moves, why Arc, live activity, closing call to action, Light/System/Dark | [turn-17b-homepage-story.md](studio/prompts/turn-17b-homepage-story.md) · [turn-17b](studio/runs/turn-17b.json) | Bugs found in the running build fixed in 17c/17d. |
| 17c | Homepage fixes: newest deal on the card, activity scanned from the deploy block, no em dashes or "25u" | [turn-17c-homepage-fixes.md](studio/prompts/turn-17c-homepage-fixes.md) · [turn-17c](studio/runs/turn-17c.json) | |
| 17d | Activity newest first | [turn-17d-activity-order.md](studio/prompts/turn-17d-activity-order.md) · [turn-17d](studio/runs/turn-17d.json) | **Studio hit its daily limit mid-turn** (status budget_exceeded) and left the file not compiling. Finished by hand: log index on each item, plural, and the scan now runs backwards from the head and stops at 6 events (forward scanning showed deal #1 first and took minutes). Also by hand: the three-way theme control made the header 622 px wide on a 375 px phone; below md it is now one cycling icon button and the wordmark hides below sm. Both to be synced into Studio's workspace on the next turn. |
| revert | User review: the 17b homepage was too busy, and the drag editor is not worth it | none (no Studio quota left today) | Hand revert, no new code: HomePage.tsx, App.tsx and theme.ts restored to their Turn 16a versions (Studio's own output), `home/` removed; TierCurveEditor removed and the Sell page back to typed prices with the static preview. Kept: empty default prices (17a). To be synced into Studio's workspace on the next turn. |
| 18 | Sync of the hand edits since 17d; high-value tokens priced per whole token with an automatic unit size (works around the contracts' 5 USDC per-unit cap); centred homepage; deal page with a full-width header and one order card | [turn-18-units-home-dealroom.md](studio/prompts/turn-18-units-home-dealroom.md) · [turn-18](studio/runs/turn-18.json) | Checked in the mainnet build: WETH picks 0.001 WETH per unit, "Use market price" gives 2,288 / 2,266 / 2,243 USDC per WETH = 2.29 / 2.27 / 2.24 per unit. Stock and tier thresholds are still entered in units. Hand fix after: the header overflowed a 375 px phone (Connect Wallet ended at 496 px; it had also crept back with the revert): wordmark and theme toggle hidden below sm, tighter tabs. |
| 19 | Homepage: example figures removed from "How it works"; the questions section brought back under it | [turn-19-faq.md](studio/prompts/turn-19-faq.md) · [turn-19](studio/runs/turn-19.json) | Checked in the running app: accordion opens one at a time. Studio's App.tsx still lacks the Turn 18 hand fix to the phone header; to sync next turn. |
| 20 | Tier thresholds follow the stock and show token amounts; error for a tier above the stock; "Set to market" under the price; Turn 18 header hand fix synced | [turn-20-tiers-follow-stock.md](studio/prompts/turn-20-tiers-follow-stock.md) · [turn-20](studio/runs/turn-20.json) | From user testing: 4 units of cirBTC stock with tiers at 25 and 50, which postDeal would reject. Checked: stock 4 gives tiers 1/2/4 (0.00005/0.0001/0.0002 cirBTC); a typed tier of 80 with stock 50 shows the error and keeps the value. Studio's App.tsx now matches the repo. |
| 21a | Sell page: Max button and balance under Stock, title example that follows the token and stock, "Your tokens" group (custom tokens from your own deals and ones pasted before) | [turn-21a-sell-page.md](studio/prompts/turn-21a-sell-page.md) · [turn-21a](studio/runs/turn-21a.json) | Monthly Studio usage 62% to 63%. |
| 21b | Seller can't order from their own deal; sub-cent prices shown ($0.0014, not $0.00); one closed-deal card; copy with a fallback and a copy-address button in the header; "Your deals" tab | [turn-21b-deals-prices-copy.md](studio/prompts/turn-21b-deals-prices-copy.md) · [turn-21b](studio/runs/turn-21b.json) | Usage 63% to 66%. Checked on the FAZE deal: $0.0016 / $0.0015 / $0.0014. Hand fix after: removing the duplicate card also removed "This deal has settled/refunded" for everyone viewing a finished deal; CommitFlow now returns nothing only while a deal waits to be finalised. To sync next turn. |
| 22 | "Ready to collect" only when the Settler holds something for the wallet; Proof page history from Arc's explorer API instead of ~162 sequential eth_getLogs calls; 21b hand fix synced | [turn-22-collect-proof-speed.md](studio/prompts/turn-22-collect-proof-speed.md) · [turn-22](studio/runs/turn-22.json) | Measured first: the main RPC and QuickNode cap eth_getLogs at 5,000 blocks, dRPC at 10,000, Blockdaemon has pruned old history; 806,752 blocks since deploy. Usage 66% to 67%. |
| 22b | Gap-fill from the explorer's indexed height (not the newest event, which would be slow again after quiet days); per-token "Items collected"; scan starts on open | [turn-22b-proof-followups.md](studio/prompts/turn-22b-proof-followups.md) · [turn-22b](studio/runs/turn-22b.json) | Proof page: about 3 minutes before (23% after 40 s on the live site), **2.0 s** after, 72 events, $775.53 paid in. Hand fix after: the GoodsClaimed event in `abis.ts` had its two indexed fields in the wrong order (claimant, token) against the contract (token, claimant), so "token" was the wallet; swapped to match `Settler.sol`. Now "330 EURC · 0.0004 cirBTC · 3275 FAZE". To sync next turn. |

## What Studio did well / badly

_Two honest paragraphs, written at the end. Candour matters here: a log that
reads like nothing ever went wrong reads like a log that was written afterwards._
