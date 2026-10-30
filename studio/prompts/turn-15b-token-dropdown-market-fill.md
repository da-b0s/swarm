Two Sell-page changes from user testing, plus one small logo fix. Frontend only; edit in place, no full-file rewrites.

1. TOKEN PICKER AS A DROPDOWN

Five large token cards stacked on the Sell page take a whole screen. Replace them with one compact select-style control (custom, accessible: button with aria-expanded, list with role listbox, keyboard up/down/enter/escape, closes on outside click). Closed it shows the selected token's symbol, name and the wallet's balance of it. Open it lists every `GOODS_TOKENS` entry with symbol, name and balance, the selected one marked. Keep "More tokens are coming soon." underneath. Keep the existing behaviour on selection (stock default, validation, labels).

2. FILL PRICES FROM THE MARKET RATE

Sellers have to work out a sensible price per unit by hand; with units like 0.05 WETH that is easy to get badly wrong (we saw "-99% vs market"). Using `useMarketRates()` and the selected token's `marketSymbol`:
- Above the tier rows, a button "Use market price". It sets each existing tier's price from the market rate for the current tokensPerUnit: first tier = market +2%, last tier = market, tiers in between evenly spaced between those, each rounded to the cent (USDC 6 decimals, display 2 dp; if a unit is worth under $1 round to 4 dp so prices stay distinct). The seller can then edit any price as usual.
- Under each tier's price input, next to the per-token line, a small text button "Set to market" that sets only that tier to the market price per unit.
- Show the rate used: "Market: 1 EURC = 1.119 USDC (CoinGecko, updated 2 min ago)".
- If there is no rate (token without marketSymbol, or the fetch failed), hide the buttons and show nothing; never invent a rate.
- Recompute the per-unit price whenever "per unit" amount changes only when the user presses the button again (do not silently overwrite typed prices).
- The per-token line and the "vs market" label must also show on the first tier row (today it is missing on row 1).

3. LOGO COLOUR

`SwarmLogo` and `public/favicon.svg` use green (#1a8047) while the site's accent is blue. Use the theme accent in the app (CSS var) and the same blue as fixed colours in the favicon; set `<meta name="theme-color">` to match.

Run the type check and the linter and paste the actual output.
