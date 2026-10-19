Answering the pricing tradeoff: FIX FIRST — collateralize at the top-tier price.

Here is the reasoning, because it changes the mechanism and I want it implemented precisely.

Commit-time escrow cannot coexist with withdrawals that un-break a tier. You found one consequence; there are three, and together they rule it out:

- Per-buyer `min(escrowed, clearing)` is solvent, but it means different buyers pay different amounts for the same deal. The entire product claim is that every buyer settles at ONE clearing price. I am not willing to make that claim 99.5% true.
- Clamping the clearing price down to the lowest escrowed price keeps one price, but it is gameable: a coalition commits while volume is high to escrow the bottom tier, then mass-withdraws, dragging the settlement price down to the bottom tier for everyone at the supplier's expense.
- Commit-time escrow also breaks gasless commits. An EIP-3009 authorization is signed for a specific amount; if the live price falls between signing and the relayer submitting, the authorization is stale and the commit fails. A fixed collateral amount cannot race.

So: every buyer escrows `tiers[0].pricePerUnit` — the highest price on the curve — regardless of when they commit.

Required behaviour after the change:

- `commit(dealId)` pulls exactly `tiers[0].pricePerUnit` from every buyer. No buyer can ever be underwater, so no refund subtraction can underflow.
- `clearingPrice(dealId)` is unchanged: the lowest tier price unlocked by the current buyer count. This is the live price the frontend shows and the price everyone actually pays.
- `settle(dealId)`: clearing = clearingPrice(finalCount). Credit every buyer `topTierPrice - clearing` — a uniform refund, identical for all of them. Credit the supplier exactly `clearing * buyerCount`. Conservation is then trivially exact: `topTier * n == clearing * n + (topTier - clearing) * n`.
- `withdraw(dealId)` returns the full `topTierPrice` and is never restricted. A tier un-breaks freely, the live price goes back up, and no buyer is left unable to pay it.
- `refundAll(dealId)` returns `topTierPrice` to every buyer.
- Remove the `min(escrowed, clearing)` logic and any per-buyer paid-price storage that is now redundant. Keep a single `collateral` value per deal.
- The v1 cap of 5 USDC now applies to `tiers[0].pricePerUnit`, which is the amount actually pulled.

Three further corrections from reviewing the Turn 1 output:

1. `TierBroken` is emitted on the wrong event. `commit()` never emits it, so the downward break — the entire point of the product — produces no event at all, while `withdraw()` emits it only for upward moves. Emit `TierBroken` from both `commit()` and `withdraw()` whenever the live price changes, with the new price in the payload. The frontend and the /proof page both key off this event.

2. `withdraw()` pushes USDC directly with `USDC.transfer(msg.sender, amount)`. Arc reverts transfers to blocklisted addresses, so a blocklisted buyer cannot withdraw at all. Credit the claimable mapping and let them pull, exactly as settle and refundAll do. Pull payments everywhere, no exceptions.

3. Replace the bare `assert(...)` conservation check with a named custom error. A failing `assert` raises Panic(0x01) and burns all remaining gas, turning a detectable accounting bug into an expensive mystery.

Confirm in your reply that `claimable` accumulates across deals and is never reset per deal.

Then deploy to Arc testnet (chain 5042002) and report, for each contract, the address and the block number it was deployed in.
