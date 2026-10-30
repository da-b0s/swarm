Reading all four files in full before touching anything. Now read the other home components for copy fixes: Good. I have everything. Let me now make all the targeted edits: **Fix 1: LiveDealCard — three bugs in one edit block.**

1. `settledBest` overwrites on first match only (`!settledBest`) → now always overwrites, so the last settled id wins (highest id).
2. Active = `state === 0 AND deadline > now` — past-deadline open deals excluded.
3. Price line: `"= {ppt} per {symbol}"` → when `tokensPerUnit === 1e(decimals)` (exactly one token per unit), show only `"per {symbol}"`; otherwise `"per unit · {ppt} per {symbol}"`. For settled show closed-at line instead. Now also add `now` to the `useMemo` deps (it was missing): Now fix the price hero section — replace `"= {ppt} per {symbol}"` with the correct logic and add a settled summary line: Now replace the price hero JSX: Now add skeleton loading state. The component currently returns `null` immediately if `!picked` — but `null` for "loading" and `null` for "no deals" look the same. I need to distinguish: if `countRaw` is still `undefined` (wagmi hasn't resolved yet) or `dealsRaw` hasn't come back, show a skeleton. The existing logic also has a problem: if count=0 `dealsRaw` will never be fetched (query disabled), so "no deals" is quick to detect: **Fix 3: LiveActivity — full historical scan from deploy block, proper loading/empty/error states.**

The spec says to prefer reusing `useEventLog` directly. But `useEventLog` is scan-on-demand (user-triggered, no auto-start). The right approach is a dedicated hook that auto-runs the same chunked scan pattern from `deployBlock`, the same way `useDealHistory` does. This keeps the homepage independent of the proof-page scan state.

I'll rewrite `LiveActivity.tsx` with a `useRecentActivity` hook that scans from `deployBlock` chunked, collects the newest 6 events across the full history, and properly tracks loading/done/error states: Now fix all copy issues in the three components: **HowADealMoves.tsx** — fix step numbering (`01 — Post` → `1. Post`), copy fixes: Fix the step label rendering — `{num} — {label}` → `{num} {label}`: **PriceFallAnimation.tsx** — fix `{t.minUnits}u → {t.price}` SVG label: **LiveActivity.tsx** — the `"View all on the Proof page →"` already had the arrow removed in the rewrite. Check `ClosingCta.tsx` for any en/em dashes: Em dashes in code comments are fine. User-visible ones in JSX need fixing: `WhyArc.tsx` body text has two, and `PriceFallAnimation.tsx` settled banner has one: Now check `LiveDealCard.tsx` for dashes in user-visible text: Both are in code comments only. Now run the check: ```
oxlint: Found 0 warnings and 0 errors.
tsc --noEmit: exit 0
``` Summary of every change:

**`home/LiveDealCard.tsx` (three bugs fixed + skeleton):**
- Settled fallback: removed the `!settledBest` guard so every settled deal overwrites the previous, leaving the highest-id settled deal when the loop ends.
- Active definition: `state === 0 AND Number(deal.deadline) > now`. Past-deadline open deals (waiting for the keeper) are skipped. `now` added to `useMemo` deps.
- Price line: computed `oneTokenPerUnit = tokensPerUnit === 10^decimals`. For active deals: `"per {symbol}"` when 1:1, otherwise `"per unit · {ppt} per {symbol}"`. For settled: `"Closed at $1.11 per EURC · 60 units"` using `&middot;` as separator.
- Skeleton: `countLoading || (count > 0 && !dealsRaw)` renders a `min-h-[280px]` pulsing skeleton that holds the card's space while the first RPC round-trip is in flight.

**`home/LiveActivity.tsx` (full rewrite of the scan hook):**
- Scans from `CONTRACTS_ACTIVE.deployBlock` in bounded chunks using the same `SCAN_MAX_WINDOW / RangeTooLargeError / RateLimitError / growWindow` pattern as `useDealHistory` and `useEventLog`.
- Progressive display: after each chunk, the top-6 items (newest first) are shown so the user sees results arriving immediately.
- Three explicit UI states: `loading` (6 skeleton rows), `done+empty` ("No activity yet."), `error` ("Could not load activity. View the Proof page."). The loading state is never shown once the scan finishes.
- Polling phase: after the full scan, re-fetches the last 500 blocks every `POLL_LIST` ms and dedupes by txHash to pick up new events.
- Relative times: approximation via block number difference labelled "about X ago" (or "just now"), making the approximation explicit.

**Copy fixes across home components:**
- `HowADealMoves`: `01 — Post` to `1. Post`, `25 buyers → 1.17` to `25 units sold: 1.17`, `in one tx` to `in one transaction`, em dashes removed from step labels.
- `WhyArc`: two em dashes in body text replaced with full stops/commas.
- `PriceFallAnimation`: SVG tier label `25u → $1.17` to `25 units: $1.17`; settled banner `— refunds sent` to `. Refunds sent.`