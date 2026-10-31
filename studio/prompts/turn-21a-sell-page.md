Sell page improvements from user testing, all in `src/swarm/SupplierView.tsx` (new small helpers in new files if useful). Edit in place; no contract or address changes. Keep the page calm: no new sections.

1. STOCK: MAX AND BALANCE
Testing with a pasted token (FAZE, balance 875.399089) the stock silently filled 50, because the default is min(50, balance).
- Keep the default of 50 (or less if the balance is smaller).
- Under the Stock field show "Balance: 875.399 FAZE" (token symbol, trimmed decimals) next to the existing "= 50 FAZE deposited" line.
- Add a small "Max" button inside or next to the Stock field: sets stock to the largest whole number of units the balance covers (floor(balance / tokensPerUnit)). Tier thresholds follow it as they already do when untouched.

2. TITLE EXAMPLE
The title placeholder "e.g. Group buy: EURC at a discount" reads oddly. Make it follow the selected token and stock: "e.g. 50 EURC, weekend batch" (stock in tokens, formatted with formatTokenAmount; "e.g. 0.05 WETH, weekend batch" for WETH). If stock is empty: "e.g. EURC weekend batch". Leave the description placeholder as it is.

3. YOUR TOKENS IN THE DROPDOWN
Pasted ("Other token…") tokens are forgotten. Add a "Your tokens" group in the token dropdown between the listed tokens and "Other token…":
- Unlisted goodsToken addresses from deals whose supplier is the connected wallet (read via the DealFactory deal data the app already loads with batched multicall; no event-log scans), plus addresses pasted in this browser before (localStorage key `swarm.customTokens`, wrap every read/write in try/catch, keep at most 10, newest first).
- Each entry shows symbol, name, the wallet's balance and a small "Unverified" tag; resolve symbol/name/decimals/balance on chain in one multicall. Selecting one behaves exactly like a pasted custom token (same warning, same validation).
- Never include tokens from other people's deals.
- Hide the group when it is empty.

Run the type check and the linter and paste the actual output.
