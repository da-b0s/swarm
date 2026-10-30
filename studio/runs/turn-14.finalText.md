Reading all files I need before writing anything. Now read SupplierView and DealList to see where per-unit prices appear: Good. Now I have a complete picture. Let me plan precisely what needs to be done:

**1. config.ts** — expand `GOODS_TOKENS` mainnet to 5 tokens; add `marketSymbol` field to `GoodsToken`; `POLL_MARKET_RATES = 5 * 60 * 1000`

**2. utils.ts** — add `pricePerToken(pricePerUnit, tokensPerUnit, decimals)` helper; improve `formatTokenAmount` for large-decimal tokens (cap at 6 significant fractional digits)

**3. New `useMarketRates.ts`** — fetches Coinbase exchange-rates API once on load + every 5 min, maps currency symbols to USD rate

**4. New `PricePerToken.tsx`** — reusable component that shows "2.26 USDC per EURC" (or "x% above/below market") next to a per-unit price

**5. DealList** — add per-token price to each card

**6. DealRoom** — add per-token price to the price hero / header area

**7. CommitFlow** — order confirmation sentence "You pay up to X USDC for Y EURC (Z USDC per EURC)"

**8. SupplierView** — add per-token price next to each tier price as seller types

**9. Quantity: text input** — replace the `Minus`/`Plus`-only picker with a text input + buttons + quick-add buttons (+10, +100, Max) in `CommitFlow.tsx` (`OrderPreviewCard` and the withdraw section)

**10. Remove EURC hardcoding** — `validate()` error message "EURC per unit" → "tokens per unit"; label `{symbol} per unit`; `useGoodsTokenMeta` fallback for unknown tokens

**11. HomePage** — update copy

Let me set up todos and work through this: Now update utils.ts — add `pricePerToken` and improve `formatTokenAmount` for large decimals: Now write `useMarketRates.ts`: Now write `PricePerToken.tsx` — reusable inline component: Now I need to update `hooks.ts` to ensure `useGoodsTokenMeta` falls back to chain reads for unknown tokens (it probably already does). Let me check: Good — `useGoodsTokenMeta` already does on-chain fallback for any token via `symbol()` and `decimals()`. Now I need to add "Unverified token" label for tokens not in `GOODS_TOKENS`. I'll handle that in the display layer by checking against `GOODS_TOKENS` in `DealRoom.tsx`. Actually, the `useGoodsTokenMeta` result is used in `DealRoom` — I should add a `verified` flag. But let me keep it simple: the `DealRoom` will check if the token is in `GOODS_TOKENS` and show "Unverified token" in a label if not.

Now I also need the `marketSymbol` for use in the market-rate lookup. I'll compute it in each component that needs it by looking up `GOODS_TOKENS.find(t => t.address.toLowerCase() === goodsToken.toLowerCase())?.marketSymbol`.

Now update `CommitFlow.tsx` — this is the biggest change: The key changes to `CommitFlow.tsx`:
1. `OrderPreviewCard`: replace `<span>{units}</span>` + `Minus`/`Plus` with a text input + buttons + quick-add (+10, +100, Max)
2. Add order confirmation sentence to `OrderPreviewCard`
3. Add `PricePerToken` to the price line in `OrderPreviewCard`
4. Add `marketRate` prop (looked up from `useMarketRates` in parent)
5. Withdraw section: same text input instead of pure button picker
6. Remove any remnant `AlreadyCommitted` handling

I'll edit the key sections rather than rewriting the whole file: Now add market rate lookup in the main component and thread it to `OrderPreviewCard`: Now update the withdraw section to use a text input instead of pure buttons, and default to full (myUnitsN): Now update the withdraw section render — replace `Minus`/`Plus` span with a text input: Also disable the withdraw button when there's an input error: Also update the strand-check block to show the right message (input error is shown above, not here): Now update `OrderPreviewCard` — replace the `<span>{units}</span>` with a text input + quick-add buttons, add the order confirmation sentence, and add `PricePerToken`: I need to import `pricePerToken` and `useState`/`useEffect` into `OrderPreviewCard`. The `useState`/`useEffect` are already imported at the top. `pricePerToken` needs to be added to the utils import: Now pass `marketRate` down to `OrderPreviewCard` in both call sites: Also update the disconnected state `OrderPreviewCard` call: Now update `DealList.tsx` — add per-token price on deal cards. The `DealSummary` needs `tokensPerUnit` and `goodsToken` decimals. Currently `DealSummary` has `goodsToken` address but not `tokensPerUnit`. I need to add that: Add `tokensPerUnit` to `DealSummary` and populate it from the deal data: Populate `tokensPerUnit` in the `deals` useMemo: Now add `useMarketRates` to `DealList` component and pass `deal` data to `DealCard`: Pass `marketRates` to `DealCard`: Update `DealCardProps` and `DealCard` to show per-token price: Add per-token rate lookup and display in the card: Now add the per-token price to the card's price line: Now update `DealRoom.tsx` — add per-token price in the header and mark unverified tokens: Add `useMarketRates` to `DealRoom` and use it in the price hero and goods-info line: Now update the goods-info line in the DealRoom header to show per-token price and "Unverified token" badge: Now add `PricePerToken` below the `PriceHero` in the hero card: Now also add `PricePerToken` to the activity list `@` price line: Now update `SupplierView.tsx` — add per-token price next to each tier, remove EURC-specific hardcoding in error messages and labels: Fix EURC-specific error messages in `validate` and `handleApprove`/`handlePost`: Now add `useMarketRates` to the component and show per-token price next to each tier's price input: Add per-token price display inline in the tier row, after the price input: The inline IIFE for market deviation is ugly but avoids a re-import. Actually let me simplify by importing `marketDeviation` from utils instead: Now simplify the inline IIFE to use `marketDeviation`: Now update `HomePage.tsx`: Now look at the complete `utils.ts` to make sure `pricePerToken` and `marketDeviation` are properly exported: Good — both `pricePerToken` and `marketDeviation` are exported from utils. Now read `PricePerToken.tsx` and `useMarketRates.ts` to verify they're complete: Good. Now run lint + typecheck: Two issues:
1. `CommitFlow.tsx:892` — `setRawInput` called synchronously inside `useEffect` (linter error in the existing `OrderPreviewCard`). I need to see that code.
2. `SupplierView.tsx:484` — missing `symbol` in `handlePost`'s deps array.

Fix both: The `setRawInput(String(units))` in `useEffect` is an error. The right fix: derive `rawInput` by controlling it only from user input events, and when `units` changes from outside (Max click), update via the event path instead. The cleanest lint-safe approach: track whether the input is "user-driven" vs "external-driven" by using a ref as a guard.

Actually the simpler fix is: keep `rawInput` controlled from user input only, and when `units` changes from outside (i.e. `onUnits` was called from a quick button), just let `units` be the "truth" — `rawInput` becomes stale until the user types again. We only show `rawInput` in the text box; the actual value used is parsed from `rawInput` when it's valid, or falls back to `units`.

Simplest fix: remove the effect and instead update `rawInput` in the quick-button `onClick` calls directly: Now ensure the quick-add buttons also call `setRawInput` alongside `onUnits`. Let me read that section: The quick buttons already call `setRawInput` directly. Now fix the `symbol` dep in `SupplierView.tsx`: Zero warnings, zero errors. Dev server check: All done, clean lint and types. Here's what landed:

**New files:**
- `src/swarm/useMarketRates.ts` — fetches Coinbase exchange-rates once on mount and every 5 min while the tab is visible; returns a `Map<marketSymbol, USDperToken>`, silently keeps stale data on failure, never polls while hidden.
- `src/swarm/PricePerToken.tsx` — reusable inline component. Shows "2.26 USDC per EURC" when `tokensPerUnit != 1 whole token`. When a market rate is available, appends "+8% vs market" in amber or red for deals priced significantly above market (>5% amber, >15% red). Suppresses the price line when `pricePerUnit` matches exactly 1 whole token (no redundant "X USDC per token = X USDC per unit" duplication).

**utils.ts:**
- `pricePerToken(pricePerUnit, tokensPerUnit, tokenDecimals)` — returns "2.26 USDC" using pure bigint arithmetic; no float rounding.
- `marketDeviation(...)` — returns `{ pct, label, severity }` or null when deviation is under 0.5%.
- `formatTokenAmount` now caps at 6 significant fractional digits so 18-decimal tokens (WETH) don't show 18-digit strings.

**Per-token price displayed in:**
- Deal list cards (beside price/unit and fill count)
- Deal room hero price area and activity list entries
- SupplierView: under each tier's price input (also shows ±% vs market so sellers can see how their price compares)
- CommitFlow order preview card

**Other changes:**
- All EURC-hardcoded error messages replaced with `${symbol}` in SupplierView.
- Quantity picker in CommitFlow: text input with −/+ buttons and +10, +100, Max quick-add buttons (valid range enforced inline without silent clamps).
- Withdraw picker: text input with −/+ and "All" button; strand-check block only shows when withdrawal is truly blocked, input errors show inline.
- `GOODS_TOKENS` mainnet: five tokens (EURC, GBPA, MXNB, cirBTC, WETH) each with `marketSymbol`. `POLL_MARKET_RATES = 5 * 60 * 1000`.
- Unverified token badge in DealRoom header for any token not in `GOODS_TOKENS`.
- HomePage copy updated.