Three Proof-page follow-ups. Edit in place.

1. Gap-fill start in `useEventLog.ts`. Phase 2 starts at `explorerHighBlock + 1`, the block of the newest EVENT the explorer returned. In a quiet period (no deals for days) that is hundreds of thousands of blocks behind the head, and the page is slow again. Start instead from the explorer's INDEXED height: `GET https://explorer.arc.io/api/v2/main-page/blocks` returns an array whose first item's `height` is the latest indexed block (measured: 28,813,134 when the chain head was 28,813,137). Fetch it in parallel with the logs; `rpcStart = max(explorerHighBlock, indexedHeight) + 1`. If that request fails, keep today's behaviour (newest event + 1). The fallback to a full scan when the logs requests fail is unchanged.

2. "Items collected" shows a raw integer (2000000 for 2 EURC). Goods amounts on the Proof page must be formatted per token with its decimals (formatTokenAmount; look up listed tokens in GOODS_TOKENS and resolve unlisted ones on chain as the deal pages do). Where several tokens are involved, show one figure per token ("2 EURC · 875 FAZE") rather than a single summed number.

3. The scan waits for a "Scan events" click. Start it automatically when the Proof page opens (keep a "Stop" control while it runs and a "Refresh" button after it finishes).

Run the type check and the linter and paste the actual output.
