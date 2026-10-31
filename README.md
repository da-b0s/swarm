# Swarm

**Group deals on Arc: the more people buy, the better everyone's price.**

A seller posts a price ladder instead of a price. Buyers join with USDC at the current price. As volume grows the deal moves into cheaper tiers, and the cheaper price applies to everyone, including the people who joined first. When the deal closes, one transaction settles it: every buyer pays the same final price and gets back the difference, the seller is paid, and the goods are delivered. If the deal doesn't reach its minimum, every buyer is refunded in full and the seller gets their goods back.

Nobody holds anybody's money. The contracts do.

> Live on Arc mainnet since 26 October 2026: **https://swarm-zeta-one.vercel.app**

---

## How it works

```
postDeal(...)            seller sets the asset, units, price ladder, minimum,
                         stock and deadline, and deposits the stock up front
        │
commit(dealId, units)    buyer pays the CURRENT tier price for their units
commitWithAuthorization  same, gas-free: one EIP-3009 signature, a relayer submits
        │                every order can break a tier: the price falls for everyone
withdraw(dealId, units)  buyers can leave (in part) before the deadline
        │
   at the deadline (the relayer's keeper does this automatically):
     units sold <  minimum  →  refundAll(dealId)   every buyer whole, stock returned
     units sold >= minimum  →  settle(dealId)
        │
settle(dealId)   final price = the tier the final volume unlocked
                 each buyer is credited what they paid minus the final price
                 the seller is credited final price × units sold
                 unsold stock goes back to the seller
                 ── ONE TRANSACTION ──
        │
claim() / claimGoods(token)   buyers collect refunds and goods, the seller collects USDC
```

A buyer never pays more than the price they saw, and everyone ends up paying the same final price.

### Example

Ladder: **1.13 USDC per EURC from 1 unit, 1.12 from 25, 1.11 from 50**. Minimum 10, 178 units of stock.

Three buyers order 26, 72 and 80 units. The first pays 1.13 per unit, but by the time the deal closes 178 units have sold, so the final price is 1.11. Everyone pays 1.11; the first buyer gets 0.02 per unit back. The seller receives 178 × 1.11 USDC, and every buyer collects their EURC, in the same transaction.

## What you can sell

Deals sell ERC-20 assets on Arc for USDC. The app lists EURC, GBPA (British pound), MXNB (Mexican peso), cirBTC and WETH, each checked on Arc's explorer, and accepts any other token by address with an "Unverified token" warning.

A unit can be any amount of the token (for example 0.5 EURC or 0.001 WETH). Every price in the app is also shown per whole token and against the market rate, so a small unit can't disguise a high price.

## Why Arc

- **USDC is the gas.** Buyers only ever hold one token.
- **One signature to join.** Gas-free orders use EIP-3009 `transferWithAuthorization`; the relayer submits and pays gas but can only move what the buyer signed.
- **Deals settle themselves.** The relayer's keeper settles or refunds each deal shortly after its deadline.
- **Sub-second finality**, so the price on screen is the price on chain.

## Deployed addresses

| Contract | Arc Mainnet (5042) |
|---|---|
| `DealFactory` | [`0x27F8863e5e52f1DacF699f063f6dAe79690D0e2a`](https://explorer.arc.io/address/0x27F8863e5e52f1DacF699f063f6dAe79690D0e2a) |
| `DemandPool` | [`0x7A8754dB7B0d629841523c0694A7788221e9F78f`](https://explorer.arc.io/address/0x7A8754dB7B0d629841523c0694A7788221e9F78f) |
| `Settler` | [`0x2401F31355A8D1EA713BE0C83bE193C79b6F96Ac`](https://explorer.arc.io/address/0x2401F31355A8D1EA713BE0C83bE193C79b6F96Ac) |

Deployed at block 28,005,197. The runtime bytecode on chain matches the build the tests run (immutables masked), and the wiring between the three contracts was checked from chain after deploy. Every transaction is listed on the app's Proof page and in [PROOF.md](PROOF.md).

| Contract | Responsibility |
|---|---|
| `DealFactory` | Posts deals and holds the seller's stock until settlement |
| `DemandPool` | Orders, gas-free orders, top-ups, withdrawals, live price |
| `Settler` | Settlement at one price, refunds, payouts and goods delivery |

## The invariant

```
seller credit + sum(all buyer refunds) == sum(all payments)
seller credit == final price × units sold
```

Both hold exactly, to the smallest unit of USDC, for any sequence of orders, top-ups, gas-free orders and withdrawals. They are checked by Foundry fuzz tests and independently by `tools/scenarios.mjs`, a model of the mechanism in plain integer arithmetic.

## Tests

67 Foundry tests, including fuzzed conservation properties for orders, gas-free orders, top-ups and partial withdrawals:

```bash
cd onchain && arc-forge test --remappings "@openzeppelin/=node_modules/@openzeppelin/" -vv
```

End-to-end scripts in `tools/` run the full lifecycle, gas-free orders, top-ups and the keeper against Arc testnet or a local mainnet fork. One fork test freezes a buyer's address at the token issuer and shows settlement still succeeds for everyone else.

## Limits

- **Up to 100 buyers per deal,** so settlement fits comfortably in one block.
- **Up to 5 USDC per unit.** For high-value assets like cirBTC or WETH, use a small unit (for example 0.001 WETH).
- **Tokens only.** Nothing on chain can force delivery of a physical item; escrowed deals for goods and services are on the roadmap.
- Tokens that take a fee on transfer or change balances on their own are not supported.
- The relayer is a hot wallet with a small float, its key held only in its environment.

## Running it

Frontend:

```bash
cd web
npm install --legacy-peer-deps
npm run dev
```

`--legacy-peer-deps` is needed because `vite-plugin-node-polyfills` declares an old vite peer range; it works under vite 6. The app targets mainnet by default; set `VITE_SWARM_NETWORK=testnet` for testnet.

Relayer (gas-free orders and the keeper): see [relayer/](relayer/) and [docs/hosting.md](docs/hosting.md).

## Repo layout

```
onchain/          contracts and Foundry tests
web/              the app (React, wagmi, viem)
relayer/          gas-free order relayer and settlement keeper
tools/            deploy, verification, end-to-end and proof scripts
docs/             mechanism spec, Arc chain facts, deploy and hosting notes
studio/           the prompts and results of every Arc Studio turn
STUDIO.md         how this was built in Arc Studio, turn by turn
PROOF.md          mainnet deployment and transactions
```

## Built with Arc Studio

Contracts, tests, relayer and frontend were written in [Arc Studio](https://docs.arc.io/ai/arc-studio), driven from the terminal. Every turn's prompt and result is in `studio/`, and [STUDIO.md](STUDIO.md) records what Studio got right, what it got wrong, and every place code was edited by hand.

## Roadmap

Escrowed deals for goods and services, released on delivery · token launches through Swarm deals · more assets as issuers bring supply to Arc · paged settlement for larger deals · notifications when a deal you joined moves a tier or closes.
