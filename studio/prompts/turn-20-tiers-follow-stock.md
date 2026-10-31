Sell page tier fixes in `src/swarm/SupplierView.tsx`, plus one header sync. Edit in place.

From user testing with cirBTC: stock is 4 units (= 0.0002 cirBTC) but the default tiers start at 1, 25 and 50 units. Tiers 2 and 3 can never be reached and `postDeal` will revert (last tier must be <= stock), yet nothing on the page says so. Tier thresholds also don't show the token amount the way stock does.

1. Tier thresholds follow the stock.
- While the seller has not edited any "From N units" field, keep the default thresholds spread across the current stock: 1 tier → [1]; 2 → [1, ceil(stock/2)]; 3 → [1, ceil(stock/2), stock], removing duplicates (with stock 1 there is one tier; with stock 2, two). Recompute whenever stock changes. Once the seller types in a threshold, stop auto-adjusting.
- Any threshold above the stock gets an inline error under it: "Starts at 50 units but stock is 4. Lower it or raise the stock." and Post stays disabled (this is the contract's rule).
- "Add tier" proposes a threshold between the last tier and the stock when there is room; if the last tier is already at the stock, show "Raise the stock to add another tier" instead of adding an unreachable one.

2. Show token amounts for thresholds like stock does. Under each "From N units" field show "= 0.00125 cirBTC" (threshold × tokens per unit, formatted with the token's decimals), same style as "= 0.0002 cirBTC deposited". Skip it when the unit is exactly 1 token.

3. Layout: "Set to market" sits under the units field today, which reads as if it belongs to units. Move it under the price field, right-aligned or after the per-unit line, so each column's helper text sits under its own input.

4. Header sync (a fix made outside Studio after Turn 18; `src/App.tsx`): on phones the header overflowed 375 px. Make these exact changes: header row `gap-2 sm:gap-3`; the "Swarm" wordmark span gets `hidden sm:inline`; the tab container `flex gap-0 sm:gap-1 ml-0 sm:ml-4`; each tab button `px-1.5 sm:px-3`; the theme toggle button `hidden sm:flex` (instead of `flex`).

Run the type check and the linter and paste the actual output.
