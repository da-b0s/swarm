Frontend only: layout, logo and icons. No contract, config-address or data-logic changes; every number and button keeps working as now. Edit files in place section by section rather than rewriting a whole large file in one write; put new pieces in new files.

1. USE THE SCREEN WIDTH

Today everything sits in `max-w-2xl` in the middle of the page, so on a laptop it looks like a narrow ticket with empty space on both sides.
- App shell: header and main content use a wide container (`max-w-6xl`, comfortable side padding; 16px on phones). Header: logo left, nav centre or left, theme toggle and wallet right, spread across that width.
- Deals list: a responsive grid of deal cards (1 column on phones, 2 on tablets, 3 on desktop). Active/Ended tabs and a "Post a deal" button sit in a row above the grid, plus a simple token filter (All, EURC, GBPA, MXNB, cirBTC, WETH) built from `GOODS_TOKENS`.
- Deal room: two columns from `lg` up. Left (wider): title, token line, price hero with per-token price, price curve and tier table, activity. Right (sticky on scroll): the order panel / claims. Stacks to one column on phones with the order panel directly after the price.
- Sell page: two columns from `lg` up. Left: the form. Right (sticky): a live preview of the price curve, per-token prices, deposit and "You receive" summary.
- Homepage: hero left-aligned on desktop with the stats beside or under it, using the full width; "How it works" and "Built to be fair" as wider rows. Proof page: use the width for its tables.
- Nothing may scroll sideways at 375px.

2. A LOGO

Make a simple, original mark for Swarm as an inline SVG component `SwarmLogo.tsx` (takes `size` and uses `currentColor` plus one accent from the theme): a small cluster of 3-7 hexagons or dots converging into one shape, reading as "many come together". No letters inside it, no stock icon. Use it in the header next to the wordmark "Swarm" in place of the current icon tile.
- Export the same mark as `public/favicon.svg` (with fixed colours that read on both light and dark browser tabs) and `public/apple-touch-icon.png` is not required. Link it in `index.html` (`<link rel="icon" type="image/svg+xml" href="/favicon.svg">`), set `<meta name="theme-color">`, and set the page title to "Swarm - Buy together, pay less".

3. FEWER GENERIC ICONS

Remove decorative icons that only repeat the text next to them — they read as template/AI-made: the icons on the homepage "How it works" and "Built to be fair" cards, the icons in the nav items (Deals, Sell, Proof), and any icon that sits in front of a heading or label purely for decoration. Use the step numbers, type and spacing instead. Keep icons that do a job: theme toggle, back arrow, copy, external link, close, +/- controls, status dots, the "Built with Arc Studio" badge.

Run the type check and the linter and paste the actual output.
