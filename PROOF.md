# Proof — every Swarm transaction on Arc mainnet

Chain 5042 · explorer: https://explorer.arc.io

> Status: deployed 26 October 2026 at block 28,005,197. Deals sell **EURC**, Circle's
> euro stablecoin, paid for in USDC. Every figure below is read from chain; the live
> `/proof` page recomputes them in the browser.

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
| `DealFactory` | [`0x27F8…0e2a`](https://explorer.arc.io/address/0x27F8863e5e52f1DacF699f063f6dAe79690D0e2a) | [tx](https://explorer.arc.io/tx/0xc08ef106026f9e05a150b0ce7109a42b4bcf70a31942fec3e99a43ad24b86579) | byte-identical to the tested build |
| `DemandPool` | [`0x7A87…E78f`](https://explorer.arc.io/address/0x7A8754dB7B0d629841523c0694A7788221e9F78f) | [tx](https://explorer.arc.io/tx/0x3aabd8bda29b81be4826918e95d5a5d0a6a6326e0dbe8a0bd81dba500f1a9882) | byte-identical to the tested build |
| `Settler` | [`0x2401…96Ac`](https://explorer.arc.io/address/0x2401F31355A8D1EA713BE0C83bE193C79b6F96Ac) | [tx](https://explorer.arc.io/tx/0x9d26dd8d4f4c2630c7ef16f2cd57417cae6546fcfb55d0cd4b0069a128f4c17f) | byte-identical to the tested build |

Gasless orders are part of `DemandPool` (`commitWithAuthorization`), so there is no
separate relayer contract. Wiring (three one-time owner calls) was checked from chain
after deploy: factory ↔ pool ↔ settler links agree in both directions. "Byte-identical"
means the runtime bytecode on chain equals the local build the 67-test suite runs,
with only constructor-set immutable addresses masked.

## Phase 1 — the open house deal

A permanent deal with a $0.25 floor, open to anyone from deploy day, relisted as
it settles. Anyone can commit in thirty seconds and watch their own commit
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
