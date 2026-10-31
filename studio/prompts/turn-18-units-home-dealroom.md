Frontend only; no contract or address changes. Edit in place, new pieces in new files, no full-file rewrites of large files. Keep the UI calm and uncluttered: the owner rejected a busy homepage, so fewer, larger elements.

0. SYNC FIRST (changes made outside Studio since Turn 17d)
Your workspace is behind the repo. Make it match before anything else:
- Delete `src/swarm/home/` (all files) and `src/swarm/TierCurveEditor.tsx`. In `SupplierView.tsx` remove the `TierCurveEditor` import and its usage (the "Interactive curve editor" block); tier prices are typed, start empty, and "Use market price" stays.
- Theme goes back to the two-state light/dark toggle (one sun/moon icon button in the header) as it was before Turn 17b; drop `useThemeMode`/`setTheme`/`ThemeMode` and the three-way pill.

1. HIGH-VALUE TOKENS: HIDE THE 5 USDC UNIT CAP
The contracts cap the price of one unit at 5 USDC (`MAX_PRICE_USDC`). Today a seller listing WETH (about $2,200) or cirBTC must invent a tiny unit themselves, and the only feedback is "price exceeds the $5 cap". Make units an internal detail for these tokens:
- When a token with a market rate is selected (or the seller changes token), set the "per unit" amount automatically to a round amount of the token worth between about $0.50 and $5 at the market rate: the largest of 1, 0.5, 0.1, 0.05, 0.01, 0.005, 0.001, 0.0005, 0.0001 (and so on) whose value is at most $5. EURC/GBPA stay at 1, MXNB becomes a round number like 10 or 50 (that is still worth under $5), WETH 0.001, cirBTC 0.00005 or similar. The seller can still edit it; if they do, keep their value.
- Let the seller enter tier prices per WHOLE token ("Price per WETH") when the unit is not exactly 1 token; convert to price per unit for the contract (price per unit = price per token × tokens per unit, rounded down to micro-USDC) and show the per-unit figure small underneath. "Use market price" fills per-token prices.
- Stock and per-buyer limits are entered in tokens ("Stock: 0.5 WETH"), converted to units; reject amounts that aren't a whole number of units with a plain message ("Stock must be a multiple of 0.001 WETH").
- If a per-unit price would still exceed 5 USDC, the message says what to do: "One unit would cost more than $5. Use a smaller unit, for example 0.001 WETH."
- Buyer side (order panel): for these deals, quantity is entered and shown in tokens ("0.1 WETH"), with the unit count small underneath ("100 units"); Max, +/- step by one unit. Deal cards and deal room headline the price per token.

2. HOMEPAGE: CENTRED AND CALM
Restyle the homepage (keep the copy, stats and how-it-works content):
- Hero centred: a large headline "Buy together. Pay less." (two lines), the subtitle under it, centred, on a soft dark-blue gradient with a faint radial glow behind the centre (light theme: a soft pale-blue equivalent).
- Centrepiece under the subtitle: one wide rounded card (max ~720px) that acts as the way in: a search-style field "What do you want to buy?" that filters/opens deals, with a primary "Browse deals" button on its right; under the card a row of small token chips (EURC, GBPA, MXNB, cirBTC, WETH) that open the deal list filtered to that token, and a quiet "or sell on Swarm" text link.
- Then the stats band (as now, full width), then "How it works" as three cards in one large rounded container. Generous vertical spacing. No other sections, no icons added.

3. DEAL ROOM: ALIGNED AND TIDY
On the deal page the left column and the right order panel start at different heights and the right side has loose text links floating between boxes ("Pay the network fee yourself instead", "Add Arc to wallet") and a separate share box.
- Put the back link, title, token and unit line in a full-width header row above both columns, so both columns' first cards start on the same line and share the same top edge.
- Right column is ONE card: quantity, price summary, the order button, then (inside the card, under a thin divider) "Pay the network fee yourself" and "Add Arc to wallet" as small secondary buttons side by side, and the share/next-tier line as the card's footer with its copy button.
- Equal gaps (the same spacing token) between all cards in both columns; the stats cards (Units sold / Time left) align with the bottom of the order card where heights allow; card corner radius and padding consistent across the page.

Run the type check and the linter and paste the actual output.
