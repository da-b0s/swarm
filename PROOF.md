# Proof — every Swarm transaction on Arc mainnet

Chain 5042 · explorer: https://explorer.arc.io

> Status: nothing deployed yet. This file is filled from chain, not by hand —
> see `tools/proof.mjs` (pending) and the live `/proof` page.

## Totals

| Metric | Value |
|---|---|
| USDC moved | _pending_ |
| Distinct wallets | _pending_ |
| Commits | _pending_ |
| Tier breaks | _pending_ |
| Deals settled | _pending_ |
| Deals refunded in full | _pending_ |
| Total mainnet transactions | _pending_ |

## Deployments

| Contract | Address | Tx | Verified |
|---|---|---|---|
| `DealFactory` | _pending_ | | |
| `DemandPool` | _pending_ | | |
| `Settler` | _pending_ | | |
| `CommitRelayer` | _pending_ | | |

## Phase 1 — the open house deal

A permanent deal with a $0.25 floor, open to anyone from deploy day, relisted as
it settles. A reviewer can commit in thirty seconds and watch their own commit
move the price for everybody.

| Deal | Curve | Buyers | Clearing | Settlement tx |
|---|---|---|---|---|
| _pending_ | | | | |

## Phase 2 — the 48-hour campaign

One real deal, a curve of $1.00 at 10 buyers / $0.75 at 25 / $0.50 at 50,
minimum 10.

| Event | Buyer count | Price | Tx |
|---|---|---|---|
| _pending_ | | | |

Commits over time, with tier breaks marked: _chart pending_

## Phase 3 — the deliberately failed deal

A deal posted below its own minimum on purpose, settled with `refundAll` on
mainnet. The all-or-nothing refund path matters more than the happy path: it is
what shows the mechanism is real.

| Deal | Buyers | Minimum | Refund tx | Every buyer made whole |
|---|---|---|---|---|
| _pending_ | | | | |

## Phase 4 — gasless cohort

Buyers committing from wallets with a zero native balance, via EIP-3009. Gas
billed to the relayer.

| Buyer | Authorization | Relayed tx | Gas paid by relayer |
|---|---|---|---|
| _pending_ | | | |

## Conservation, checked on mainnet

For every settled deal, `supplier credit + all refunds == sum of commits`, read
back from chain events rather than asserted in a test.

| Deal | Commits in | Supplier credited | Refunds | Balances |
|---|---|---|---|---|
| _pending_ | | | | |

## Disclosures

Written plainly because concealment is what looks bad, not funding.

- _Participants funded with $1 USDC each to remove the onboarding barrier: pending.
  All of their decisions were their own._
- _No wallet in this log is controlled by the author except the deployer, the
  relayer and the supplier account, each labelled as such._
