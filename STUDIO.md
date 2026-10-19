# How Swarm was built in Arc Studio

Project: _pending — from `arc-studio apps --json`_
Turns: _in progress, from 19 October 2026_

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

_Studio generated:_ _pending_
_What I kept:_ _pending_
_What I corrected:_ _pending_

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
