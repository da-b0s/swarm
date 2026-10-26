Frontend only. No contract changes, no deploy, and do not change any Swarm contract address in `src/swarm/config.ts`.

Decision: on mainnet, Swarm deals sell **EURC**, Circle's euro stablecoin, instead of Swarm Pass. The contracts already sell any ERC-20; this turn makes the app present EURC properly. Other tokens are planned for later. Swarm Pass stays deployed on testnet only and should no longer be offered anywhere in the UI.

1. CONFIG

In `src/swarm/config.ts` add the goods tokens per network, read only from here:

    mainnet: EURC 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1  (6 decimals)
    testnet: EURC 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a  (6 decimals)

Export it as `GOODS_TOKENS`, a list of `{ symbol, name, address, decimals }` with EURC as the only entry, so adding a token later is one line.

2. SHOW TOKEN AMOUNTS IN WHOLE TOKENS

Goods amounts are stored in the token's base units. Today the buyer side prints them raw, so 10 EURC would show as "10000000 EURC". Add one helper in `utils.ts`, `formatTokenAmount(raw: bigint, decimals: number): string`, which trims trailing zeros (10000000 with 6 decimals → "10", 1500000 → "1.5"), and use it with the token's decimals from `useGoodsTokenMeta` everywhere a goods amount is shown:
- the deal room's "1 unit = … " line,
- "You'll receive …" in the order preview and in the buyer's order summary,
- every "Claim … " goods button (deal room claim panels and the global claims banner),
- the activity list and proof page wherever goods are shown, including the per-deal goods note.
While decimals are still loading, show nothing rather than a raw number.

3. SELL PAGE

Replace the free-text goods token address with a token picker listing `GOODS_TOKENS` (today just EURC, preselected), showing the symbol, name and the wallet's balance of it, and a short line under it: "More tokens are coming soon." Remove the Swarm Pass default and the "Get test passes" faucet button. Keep everything else: approve-then-post, balance check, validation, the curve preview. Change the default tiers to suit EURC: $1.20 from 1 unit, $1.17 from 25, $1.15 from 50, with 1 EURC per unit. Do not hardcode any market rate in copy.

When the seller's wallet has no EURC, say so plainly: "You need EURC to sell. Units you don't sell are returned to you when the deal closes."

4. COPY

Keep it short and consumer-facing — no hackathon or test wording.
- Homepage: keep "Buy together. Pay less." Under it, make clear what is sold today: "Group deals on EURC, Circle's euro stablecoin. The more people buy, the better everyone's rate." Add one FAQ entry, "What can I buy?": "Today every deal sells EURC, Circle's euro stablecoin, paid for in USDC. More tokens are coming soon."
- Anywhere copy says "items" or "passes", say "EURC" or "tokens" as fits.

Run the type check and the linter for the frontend and paste the actual output.
