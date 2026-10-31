# Proof: Swarm on Arc mainnet

Chain 5042 · explorer: https://explorer.arc.io · live, always-current version: the app's **Proof** page (https://swarm-zeta-one.vercel.app → Proof), which recomputes everything below from chain events in your browser.

The figures here were read from the contracts on **31 October 2026**.

## Deployment

| Contract | Address | Deploy tx |
|---|---|---|
| `DealFactory` | [`0x27F8…0e2a`](https://explorer.arc.io/address/0x27F8863e5e52f1DacF699f063f6dAe79690D0e2a) | [tx](https://explorer.arc.io/tx/0xc08ef106026f9e05a150b0ce7109a42b4bcf70a31942fec3e99a43ad24b86579) |
| `DemandPool` | [`0x7A87…E78f`](https://explorer.arc.io/address/0x7A8754dB7B0d629841523c0694A7788221e9F78f) | [tx](https://explorer.arc.io/tx/0x3aabd8bda29b81be4826918e95d5a5d0a6a6326e0dbe8a0bd81dba500f1a9882) |
| `Settler` | [`0x2401…96Ac`](https://explorer.arc.io/address/0x2401F31355A8D1EA713BE0C83bE193C79b6F96Ac) | [tx](https://explorer.arc.io/tx/0x9d26dd8d4f4c2630c7ef16f2cd57417cae6546fcfb55d0cd4b0069a128f4c17f) |

Deployed 26 October 2026 at block 28,005,197. The runtime bytecode on chain equals the local build the test suite runs (constructor-set immutables masked), and the wiring between the three contracts was checked from chain in both directions after deploy. The wiring can only be set once; the owner's only other power is pausing new deals and orders. No function lets anyone move escrowed funds.

## Totals

| | |
|---|---|
| USDC volume settled | **$873.31** |
| Units sold | 4,496 |
| Deals | 13 (10 settled, 3 refunded) |
| Distinct wallets | 5 |
| Assets sold | EURC, cirBTC, and one unlisted token (FAZE) |
| Overpayments refunded to early buyers | $0.62 |

Most of this volume is our own team testing the contracts end to end with our own funds.

## Every deal

| # | Asset | 1 unit | Price ladder (USDC per unit) | Sold | Buyers | Outcome | Final price |
|---|---|---|---|---|---|---|---|
| 1 | EURC | 1 EURC | 1.20 / 1.17 at 2+ | 1 of 2 | 1 | Settled | 1.20 |
| 2 | EURC | 1 EURC | 1.13 / 1.12 at 25+ / 1.11 at 50+ | 60 of 60 | 2 | Settled | 1.11 |
| 3 | EURC | 0.5 EURC | 1.13 / 1.12 / 1.11 | 0 of 178 | 0 | Refunded (no orders) | |
| 4 | EURC | 0.5 EURC | 1.13 / 1.12 / 1.11 | 178 of 178 | 3 | Settled | 1.11 |
| 5 | EURC | 0.5 EURC | 1.13 / 1.12 / 1.11 | 178 of 178 | 3 | Settled | 1.11 |
| 6 | EURC | 0.5 EURC | 0.5711 / 0.5599 | 0 of 2 | 0 | Refunded (no orders) | |
| 7 | cirBTC | 0.00005 cirBTC | 3.9453 / 3.9066 / 3.8680 | 0 of 4 | 0 | Refunded (no orders) | |
| 8 | cirBTC | 0.00005 cirBTC | 3.9473 / 3.9086 / 3.8700 | 4 of 4 | 1 | Settled | 3.86995 |
| 9 | FAZE | 1 FAZE | 0.0016 / 0.0015 / 0.001448 | 875 of 875 | 1 | Settled | 0.001448 |
| 10 | FAZE | 1 FAZE | 0.132 / 0.130 / 0.128 / 0.125 / 0.123 | 800 of 800 | 1 | Settled | 0.123 |
| 11 | FAZE | 1 FAZE | 0.135 / 0.125 / 0.123 | 800 of 800 | 1 | Settled | 0.123 |
| 12 | FAZE | 1 FAZE | 0.150 / 0.125 / 0.123 | 800 of 800 | 1 | Settled | 0.123 |
| 13 | FAZE | 1 FAZE | 0.145 / 0.140 / 0.123 | 800 of 800 | 1 | Settled | 0.123 |

Deals 4 and 5 are the ones where a 0.5 EURC unit was priced at 1.11 USDC: about twice the market rate per EURC. That test is why every price in the app is now also shown per whole token and against the market rate.

## What has been exercised on mainnet

- **Settlement at one price.** Ten deals settled in a single transaction each, every buyer at the final price, goods delivered and the seller paid together.
- **The difference back.** Buyers who joined at a higher tier were refunded the difference ($0.62 in total) when later orders moved the deal down the ladder.
- **Refund path.** Three deals closed below their minimum and were refunded with `refundAll`, returning the seller's stock. None of them had buyers, so refunding real buyers on mainnet has not happened yet; that path is covered by the test suite and was run end to end on Arc testnet and on a local mainnet fork with real EURC.
- **Automatic settlement.** The relayer's keeper settled or refunded deals after their deadlines; nobody had to press a button.
- **Conservation.** For every deal, USDC paid in equals what the seller received plus what buyers got back, to the last cent. The Proof page checks this for each deal from chain events.
- **Any token.** A token outside the app's list (FAZE, 18 decimals) was sold through the "other token" path, and sub-cent prices settled exactly.

## Tested off mainnet

67 Foundry tests, including fuzzed conservation for orders, gas-free orders, top-ups and partial withdrawals; end-to-end scripts in `tools/` for the full lifecycle (42 checks), gas-free orders (33), top-ups (32) and the keeper, run on Arc testnet and on a local fork of mainnet with real EURC; and a fork test where a buyer's address is frozen by the token issuer, in which settlement still succeeds for everyone else.
