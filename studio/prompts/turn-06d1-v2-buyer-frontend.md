Frontend for v2, buyer side. The contracts and tests are done; `context/mechanism-v2.md` is the specification. The supplier view, proof page and relayer come in the next turn — do not start them here.

FIRST: apply `context/turn-06d-local-fixes.patch` exactly. It holds two fixes made outside Studio and verified in a browser: wagmi's chain list now starts with the active network (with Arc mainnet first, connecting on the testnet build switched the wallet to mainnet), and the next-tier hint skips tiers that are not cheaper than the live price.

Do not change the contract addresses in `src/swarm/config.ts`; new deployments are recorded outside Studio. Add a `SwarmPass` address field to each network's entry, set to the zero address for now.

1. Regenerate the ABIs in `src/swarm/abis.ts` from the compiled `DealFactory`, `DemandPool`, `Settler` and `SwarmPass`. Add a minimal ERC-20 metadata ABI (`symbol`, `decimals`, `balanceOf`) for reading any goods token.

2. Deal room:
   - Show the deal's **title and description**, and what is being sold: the goods token's symbol, and "1 unit = N SYMBOL" from `tokensPerUnit` and the token's decimals.
   - Units, not buyers: "37 of 50 sold", and tier chips like "$0.50 each from 20 units". The next-tier hint and the share line count units: "8 more units and everyone pays $0.40" — still skipping tiers that are not cheaper.
   - Keep the buyer count visible as a second figure.

3. Ordering, in both the gasless and the approve-then-commit paths:
   - A quantity picker, bounded by the per-buyer limit and the remaining stock, with clear messages at each bound.
   - Show the total the buyer will pay: `priceAt(totalUnits + units) × units` — the price **including their own order**. When their order alone breaks a tier, say so: "Your order unlocks $0.40 for everyone."
   - Gasless signs for exactly that total; read the nonce with `authorizationNonce(dealId, buyer, units, salt)`; on 409 show the new total and ask to sign again.
   - Approve-then-commit approves `tiers[0].pricePerUnit × units`, the most it can cost, and calls `commit(dealId, units)`.

4. A committed buyer sees their order: units, per-unit price paid, escrow, and the refund waiting at the current price. The withdraw pre-check uses the units-based strand rule, mirroring the contract's `_priceAt` and `_lowestPaidExcluding` exactly, and disables the button with the plain explanation when blocked.

5. After settlement or refund, show both claims — USDC, and the goods token with its symbol — each with its own button, calling `claim()` and `claimGoods(token)`.

6. The activity list reads the v2 `Committed` and `Withdrawn` events: each row shows units and the per-unit price, newest first, linking to the transaction.

Everything must work logged out, fit at 375px, and use chain time (`useChainNow`) for anything time-based. Run tsc and the linter and paste the actual output.
