Three frontend changes from user review. Edit in place; no full-file rewrites; no contract or address changes.

1. HOMEPAGE COPY
Hero subtitle becomes: "Group deals on assets on Arc. The more people buy, the better everyone's rate." Sweep the homepage FAQ and meta description for "stablecoins and tokens" / stablecoin-only wording and use "assets on Arc" the same way.

2. STATS AS A FEATURE, NOT A SIDEBAR
Today the five stats are small tiles squeezed to the right of the hero with a big empty gap between them and the headline, and a lonely fifth tile. We want to present them.
- Hero back to one column (headline, subtitle, buttons), full width.
- Directly under it, a full-width stats band: all five stats in one row on desktop (grid of 5 equal columns), 2 columns on phones with the fifth spanning both. Numbers large (around text-4xl/5xl, bold, tabular figures), label underneath in muted text. One shared card or subtle dividers between stats, not five separate small boxes.
- Order: Volume, Units sold, Buyers, Deals, Saved by buyers. Keep "Live from the blockchain, updated every few seconds." under the band.
- No layout shift while loading: keep skeleton numbers at the same size.

3. SELL ANY TOKEN BY ADDRESS
In the Sell page's token dropdown, add a last option "Other token…". Choosing it shows an address input.
- On a valid address, read `symbol()`, `name()`, `decimals()` and the wallet's `balanceOf` from chain (one multicall). If any read fails or decimals > 36, show "This address isn't a standard token on Arc." and keep Post disabled.
- When it reads, treat it exactly like a listed token everywhere on the page (labels, per-unit parsing with its decimals, deposit, approval, balance checks), with a visible amber note: "Unverified token. Check the address is the one you mean. Tokens that take a fee on transfer or change balances on their own will not work with Swarm."
- If the address matches a `GOODS_TOKENS` entry, just select that entry.
- No market rate for custom tokens, so the market buttons stay hidden and no "vs market" label shows.
- Deal pages already show an "Unverified token" badge for unlisted tokens; make sure the deal list cards and the proof page also resolve symbol/decimals on chain for unlisted tokens instead of assuming 6 decimals.

Run the type check and the linter and paste the actual output.
