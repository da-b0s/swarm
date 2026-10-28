Reading all files I need before writing anything. Now read the hooks file and every file with polling intervals: Now read the remaining files with polling: I now have a complete picture. Let me also check CommitFlow for `refetchInterval` values and also check what `arc`/`arcTestnet` look like from viem to know if they already include Multicall3: Good. Now I have the complete inventory. Both `arc` and `arcTestnet` viem chain definitions already include `multicall3` at the canonical address. Now I know exactly what needs to change:

**Changes:**
1. `src/swarm/config.ts` — add poll-cadence constants `POLL_DEAL_ROOM`, `POLL_MY_ORDER`, `POLL_LIST`, `POLL_CHAIN_CLOCK_MS`
2. `src/config.ts` — enable `batch: { multicall: true }` in `createConfig`, add `retryCount: 4` + exponential backoff to http transports, `refetchOnWindowFocus: false` for tab-hidden
3. `src/swarm/hooks.ts` — replace all hardcoded `refetchInterval` with the constants; fix `useChainNow` to poll at `POLL_CHAIN_CLOCK_MS` (once per 60s instead of `watch:true`); add `refetchIntervalInBackground: false` everywhere
4. `src/swarm/DealList.tsx` — replace hardcoded intervals
5. `src/swarm/useSwarmStats.ts` — replace hardcoded interval
6. `src/swarm/GlobalClaimsBanner.tsx` — replace hardcoded interval
7. `src/swarm/FundingNotice.tsx` — replace hardcoded interval
8. `src/swarm/SupplierView.tsx` — replace hardcoded interval
9. `src/swarm/RetiredClaims.tsx` — replace hardcoded interval

The `useDealHistory.ts` `setInterval` is for the proof page event log scan — left alone per spec.

Let me now make all the changes: Now update `src/config.ts` — enable multicall batching, add retry with backoff: Now rewrite `hooks.ts` with all polling constants and the new `useChainNow` that polls at `POLL_CHAIN_CLOCK_MS` instead of `watch: true`: Now update all the remaining files. Starting with `DealList.tsx`, `useSwarmStats.ts`, `GlobalClaimsBanner.tsx`, `FundingNotice.tsx`, `SupplierView.tsx`, and `RetiredClaims.tsx` in parallel: Now update the actual interval values in those files: Now fix `FundingNotice.tsx` and `SupplierView.tsx` and `RetiredClaims.tsx`: Now fix `SupplierView.tsx` balance read interval: Now run the check: `retryDelay` on viem's `http` transport doesn't accept a function — it's a fixed number. Fix by computing the delay statically or just removing the custom delay (the default backoff already uses exponential delays internally): Zero warnings, zero errors. Dev server still running: **Actual output:**

```
oxlint: Found 0 warnings and 0 errors
tsc --noEmit:  exit 0
```

---

Here is exactly what changed:

**`src/swarm/config.ts`** — four new exported constants: `POLL_DEAL_ROOM = 10_000`, `POLL_MY_ORDER = 15_000`, `POLL_LIST = 30_000`, `POLL_CHAIN_CLOCK_MS = 60_000`. Every `refetchInterval` in the app now reads from these.

**`src/config.ts`** — three changes. (1) Multicall3 batching enabled: `batch: { multicall: true }` in `createConfig` — wagmi now aggregates concurrent `useReadContract` / `useReadContracts` calls into a single `eth_call` through Multicall3 (already at `0xcA11bde…` on both arc and arcTestnet per their viem chain definitions). (2) `retryCount: 4, retryDelay: 500` on both Arc transports — up to 4 retries at 500 ms intervals before an error surfaces. (3) Both Arc transports share one `arcTransport` constant to keep them in sync.

**`src/swarm/hooks.ts`** — all hardcoded intervals replaced with the named constants. `useBlock({ watch: true })` replaced with `useBlock({ query: { refetchInterval: POLL_CHAIN_CLOCK_MS, refetchIntervalInBackground: false } })` — one block fetch per minute instead of every block (~2/s). Between fetches the local clock advances the timestamp smoothly so countdowns remain accurate. Every query gains `refetchIntervalInBackground: false` so polling stops when the tab is hidden. Poll assignment: `useDeal`, `useBuyerCount`, `useTotalUnits`, `useClearingPrice` → `POLL_DEAL_ROOM` (10 s); `useUnitsOf`, `usePaidPerUnit`, `useEscrowed`, `useTierCounts`, `useClaimable`, `useGoodsClaimable` → `POLL_MY_ORDER` (15 s); `useDealCount` → `POLL_LIST` (30 s).

**`src/swarm/DealList.tsx`** — deal structure reads use `POLL_LIST`; units sold (live fill bar) uses `POLL_DEAL_ROOM`; both add `refetchIntervalInBackground: false`.

**`src/swarm/useSwarmStats.ts`** — uses `POLL_LIST` with `refetchIntervalInBackground: false`.

**`src/swarm/GlobalClaimsBanner.tsx`** — `goodsClaimables` read uses `POLL_LIST`.

**`src/swarm/FundingNotice.tsx`** — USDC balance uses `POLL_MY_ORDER`.

**`src/swarm/SupplierView.tsx`** — goods token balance uses `POLL_MY_ORDER`.

**`src/swarm/RetiredClaims.tsx`** — retired-settler claimable reads use `POLL_LIST`.