Reading all three affected files in full before touching anything. Good. I have both files completely. Now reading ProofPage to understand how `refunded` and `conserved` are rendered: I have everything. The bugs are clear. Now setting up todos and executing all changes: Starting with the shared `rpc.ts` module, then rewriting both hooks. All three are interdependent so I'll write them together: Writing `rpc.ts` first, then both hooks: Now rewrite `useEventLog.ts` with all three fixes applied:
1. `Settled` case: add `totalRefunds` from the event's `totalRefunds` field
2. `Refunded` case: also set `deal.refunded = true`
3. Conservation check runs on both `settled` AND `refunded` deals (with the right formula for each)
4. `MIN_LOG_WINDOW` floor + range error = surface as real error
5. Import from shared `rpc.ts` Now rewrite `useDealHistory.ts` with the three fixes:
1. Accumulate all backfill logs; rebuild from scratch (empty map) after each window in chronological order
2. No poll starts until backfill completes; `lastBlockRef` never moves backwards
3. RPC errors during backfill: rate-limit = backoff + retry; range = shrink + retry; other = surface and stop
4. Import from shared `rpc.ts` Now update `ProofPage.tsx` to show the conservation check for refunded deals and label them correctly: Also update the description line to mention both settle and refundAll: Now run the checks: Clean. Dev server still up: Actual check output:

```
$ oxlint --type-aware src scripts --fix; s=$?; oxlint --fix .; exit $((s>0?s:$?))
Found 0 warnings and 0 errors.
Finished in 1.3s on 26 files with 57 rules using 4 threads.
Found 0 warnings and 0 errors.
Finished in 221ms on 29 files with 34 rules using 4 threads.
$ tsc --noEmit

[Command succeeded with exit code 0]
```

---

Here is what changed and why each fix is correct:

**`src/swarm/rpc.ts` (new shared module)**

`RateLimitError` and `RangeTooLargeError`, `rpcFetch`, `getLatestBlock`, and the window-arithmetic constants (`SCAN_MAX_WINDOW`, `SCAN_MIN_WINDOW`, `RATE_BASE_MS`, `RATE_MAX_MS`, `GROW_AFTER`, `growWindow`, `shrinkWindow`) are now in one place. Both hooks import from here; there is no second copy.

**`useEventLog.ts` — Bug 1 (conservation failure on a settled deal)**

The `Settled` case now reads `a.totalRefunds` from the event and adds it to both `deal.refundsOut` and `s.totalRefunds`. That is the only place refunds from `settle()` are recorded: the contract never emits `Refunded` inside `settle()`, so the previous code counted $0 for every settled deal's refunds.

The `Refunded` case now also sets `deal.refunded = true`. The conservation check was already written to handle the `refunded` path but was never reached because the flag was never set.

The conservation check now fires for `deal.settled || deal.refunded`. For a refunded deal the invariant is `commitsIn === refundsOut` (supplier credit stays zero). ProofPage renders the check row for both, and labels a refunded deal "Refunded in full" (that badge was already in the template; the `refunded` flag now gets set).

**`useEventLog.ts` — floor + range error**

If `window <= SCAN_MIN_WINDOW` when a `RangeTooLargeError` arrives, the loop now throws a descriptive error rather than retrying forever with no delay.

**`useDealHistory.ts` — Bug 2 (cross-window misordering)**

`allLogs` is a flat accumulator. After every backfill window the hook calls `buildEntries(allLogs)`, which sorts the full collected set chronologically and replays it through a fresh empty map. A `Withdrawn` that arrives in a newer window is stored in `allLogs`, but when the older window containing its `Committed` arrives, the rebuild reapplies both in the correct order. No entry is ever dropped because of arrival order.

The incremental poll is started in a `.then()` on the backfill promise, so it cannot race. The poll only advances `lastBlock` forward; it checks `head > lastBlock` before assigning.

RPC errors during backfill: `RateLimitError` backs off and retries the same window; `RangeTooLargeError` halves the window and retries; any other error sets `lastBlock` to head (so the poll can keep the list live) and returns, leaving the partial list visible rather than clearing it silently.