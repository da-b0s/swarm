Two bugs, both found by running the app against the settled testnet deals #1 and #2. Do not touch the contracts or redeploy.

1. /PROOF REPORTS A CONSERVATION FAILURE ON A DEAL THAT CONSERVED

Scanning from the deploy block, the proof page shows deal #1 as "Commits in $3.75, Supplier $2.50, Refunds $0.00 — Conservation FAILED". The deal conserved exactly: settlement refunded $1.25 in total, and $3.75 = $2.50 + $1.25. It also shows deal #2 as "Open" when it was refunded in full by `refundAll`.

Cause, in `useEventLog.ts`: `Settler.settle()` emits a single `Settled(dealId, clearingPrice, buyerCount, totalRefunds)` and no per-buyer events. Per-buyer `Refunded` events are emitted only by `refundAll()`. The aggregation sums `Refunded` amounts into `refundsOut`, so a settled deal's refunds are never counted, and the `refunded` flag is never set by anything.

Fix:
- In the `Settled` case, add `totalRefunds` to that deal's `refundsOut` and to the global `totalRefunds`.
- In the `Refunded` case, also mark the deal `refunded = true`.
- Run the conservation check for refunded deals too: for those, commits in (net of withdrawals) must equal refunds out, with supplier credit zero.
- Show a refunded deal as "Refunded in full", not "Open".

Done looks like: deal #1 reads $3.75 = $2.50 + $1.25 with conservation passing; deal #2 reads "Refunded in full", $1.00 = $0.00 + $1.00, passing; total refunded across the page is $2.25.

2. THE ACTIVITY LIST MIS-ORDERS EVENTS ACROSS WINDOWS

`useDealHistory` backfills backwards from head in 5,000-block windows and applies each window to the state map as it arrives, newest window first. Sorting within a window does not help across windows. If a buyer's `Committed` is in an older window and their `Withdrawn` in a newer one, the `Withdrawn` is processed first, finds no entry, and is dropped; the older `Committed` then sets `withdrawn: false`, and a buyer who left is shown as still in. A 5,000-block window is about 42 minutes on Arc, so any deal longer than that is exposed — the 48-hour campaign spans about 70 windows. I reproduced it by feeding the hook's `applyLogs` the two windows in backfill order; it reports the buyer as not withdrawn, while applying the same logs together reports them correctly.

Two further problems in the same hook:
- The 5-second incremental poll starts before the backfill finishes, so it can apply new events ahead of older ones, and its `lastBlockRef` can then be overwritten by the backfill's older head, causing ranges to be re-applied.
- Any error during backfill ends the scan silently and still marks history as complete, so one rate-limit response leaves a permanently partial list.

Fix:
- Accumulate all backfilled logs, then rebuild the state map from scratch by applying the whole set in chronological order. It is fine to rebuild after each window for progressive display, as long as each rebuild starts from an empty map and applies everything collected so far in order.
- Do not start incremental polling until the backfill has finished, and never let the backfill move `lastBlockRef` backwards.
- Use the same error handling as the /proof scanner: on `rate limit exceeded` wait with exponential backoff and retry the same range; on `requested range too large` halve the window. Share one implementation rather than duplicating it — move the classified `rpcFetch` and the error classes into a small module both hooks import.

Also, while in `useEventLog.ts`: if a window is already at `MIN_LOG_WINDOW` and the node still returns `requested range too large`, the loop retries forever with no delay. Surface that as an error instead.

Run tsc and the linter at the end and paste their actual output.
