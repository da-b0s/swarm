Frontend fixes from hands-on testing on mainnet. No contract changes, no deploy, no address changes. Keep every existing safeguard.

1. TOKENS PER UNIT ACCEPTS DECIMALS — this one is a real bug

`SupplierView.tsx` reads the "EURC per unit" field with `parseInt(unitsPerToken) || 1`. A seller who types 0.5 sees "1 unit = 0.5 EURC" on the page, but `parseInt('0.5')` is 0, the `|| 1` fallback turns it into 1, and the deal is posted at 1 EURC per unit. The page must never post a different amount from the one it shows.
- Compute `tokensPerUnit` with viem's `parseUnits(value, decimals)` so any amount the token's decimals allow works (0.5, 2.25, 10).
- Allow decimals in the input (`step="any"`, `min` just above 0). Reject empty, zero, negative, or more decimal places than the token has, with a plain message, and disable Post until it is valid. No silent fallback to 1.
- Label the field "EURC per unit" (drop "whole tokens"). Keep the "1 unit = X EURC" line, computed from the same parsed value that is posted, formatted with `formatTokenAmount`.
- The deposit line and every stock calculation use the same `tokensPerUnit`.

2. DURATION CAN BE SHORT

The duration input has `min="1"`, so the browser says "Value must be greater than or equal to 1" for 0.5 hours. The contracts accept any deadline in the future. Allow any positive duration (`step="any"`, `min` just above 0); keep the existing "Duration must be positive" validation. Show the closing time underneath in plain words, e.g. "Closes in 30 minutes" or "Closes in 3 days".

3. NO RED WARNING BEFORE THE SELLER HAS DONE ANYTHING

The "You need EURC to sell" error shows as soon as the page opens, because the balance is compared with the default stock of 50.
- When the wallet's balance has loaded, default the stock to what the seller can afford: `min(50, floor(balance / tokensPerUnit))`, but only until the seller edits the stock field themselves.
- Show "You need EURC to sell. Units you don't sell are returned to you when the deal closes." only when the balance is zero.
- When the balance is above zero but below the deposit, show a calm note next to the stock field, not a red error at the top: "Your balance covers up to N units at X EURC each." Post stays disabled until it fits.

4. SMALL COPY FIXES
- `TierProgress.tsx`: "1 more units needed to meet the deal minimum of 1" → correct singular/plural ("1 more unit needed to reach the minimum of 1 unit").
- Deal room: "min 1 units" → "minimum 1 unit" (singular/plural).
- Sell page subtitle: replace "Buyers escrow the live unit price; everyone settles at one clearing price." with "Buyers pay the current price. When the deal closes, everyone pays the same final price and gets the difference back."
- Title and description counters: show characters left ("62 left") instead of "0/80 bytes"; keep the byte limit check underneath.

Then sweep the rest of the Sell page and the deal room for any other place where a number shown to the user differs from the number sent on chain, and fix it the same way. Run the type check and the linter and paste the actual output.
