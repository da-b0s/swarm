Reading the patch and all affected files before touching anything. Good. Now reading the remaining files: Now reading the remaining files: Good. I have a complete picture of every file the patch touches and both defects. Now setting up todos and applying everything in parallel. Applying all Part 1 changes and deleting dead scripts in parallel: Now apply the hooks change (replace `useBlockCountdown` with `useChainNow` + updated `useBlockCountdown`): Now CommitFlow — swap browser clock for `useChainNow` and fix the approve amount: Now remove the `useState`/`useEffect` imports no longer needed and add the `maxCharge` variable + fix the approve arg. First check what imports remain needed:

The file still uses `useState` and `useEffect` for other things, so those stay. Just remove the unused `useState` for `nowSec` — but it was already replaced. Now add `maxCharge` before `handleCommit` and fix the approve arg: Now DealRoom — fix the two countdown render lines: Also fix the settle panel condition — `secondsLeft === 0` won't work now that it can be `undefined`. It should show when chain time is known and deadline has passed: Now SupplierView — add `useChainNow` import and swap `Date.now()` for chain time: Now utils.ts — add allowance check before the generic insufficient branch: Now useEventLog.ts — add the `deployBlock === 0n` guard: Now App.tsx — apply the full patch changes: Now the nav wordmark shrink fixes and the `DEPLOYMENT_READY` banner, plus empty-state logic in the deal tab: Now the empty-state / loading state in the deal tab: Part 1 applied. Now delete the dead wire scripts and clean up their entries: Now Part 2a: the event-sourced commit history hook. I need to look at the ABIs to get the exact event signatures for `DealPosted`, `Committed`, `Withdrawn`: Good. Both `Committed` and `Withdrawn` have `dealId` as indexed topic[1] and `buyer` as indexed topic[2]. `DealPosted` has `dealId` as indexed topic[1]. The filter `topics: [[DealPosted, Committed, Withdrawn], dealIdTopic]` will work perfectly.

Now I'll write a `useDealHistory` hook and integrate it into DealRoom. The hook:
- Takes `dealId` and `deployBlock`
- Scans backwards from head in 5k-block windows until `DealPosted` for this deal is found (or `deployBlock` reached)
- Then polls incrementally from the last block seen
- Returns entries newest-first with address, pricePaid, withdrawn flag, txHash Now update DealRoom to use `useDealHistory` instead of `useBuyers` / `getBuyers`. I need to remove the `useLiveDealState` `buyers` field and the `addrHue` avatar hack, replace with the new list: Now replace the `addrHue` function and the data setup, then replace the recent-commits section: Now add the `useDealHistory` call and replace the `recentBuyers` construction: Now replace the recent-commits render section with the event-sourced version: Also remove the now-unused `buyers` from `useLiveDealState` return. Let me check what `useLiveDealState` still exports that's used: `buyers` is still in `useLiveDealState` return but no longer consumed in DealRoom. I should clean it up to avoid an unused variable warning. Let me update `useLiveDealState` to drop the `buyers` fetch since nothing uses it: Now Part 2b: fix useEventLog's rate-limit vs range-limit handling. Start at 5,000 blocks, separate the two error types, backoff for rate-limit, shrink for range, grow back toward 5k after consecutive successes: Now replace the scan loop itself to use the new error-handling logic. The `getLogs` function also needs the HTTP response status to detect 429. Let me update `rpcFetch` to expose status: Now replace the scan loop to use the new constants and error types: Good. Now run the checks: Four fixes needed. Let me tackle all at once:

1. `App.tsx` `set-state-in-effect` — refactor the auto-navigate to newest deal to use a derived value instead of a double setState in effect
2. `DealRoom.tsx` — remove `addrUrl` import  
3. `useDealHistory.ts` — fix `no-base-to-string` for `args.buyer` and `args.pricePaid` (use viem's typed args instead of String() on an unknown)
4. `useDealHistory.ts` — wrap the async setInterval callback in a `void` wrapper Let me read the exact current state of that section: The lint autofix changed `BigInt(dealCount as bigint)` to `BigInt(dealCount)` on line 33. Now I see the exact text. The problem is setting state inside an effect. The cleanest fix that passes lint: use `useEffect` but call `setDealId` only (remove `setPinned`) and gate with a ref instead of state, so only one setState call happens per render cycle: Now I need to import `useRef` in App.tsx: Now fix `DealRoom.tsx` — remove unused `addrUrl`: Now fix `useDealHistory.ts` — the `no-base-to-string` issue on `args.buyer` and `args.pricePaid`, and the floating promise in setInterval. The `decodeEventLog` returns typed args but through `Record<string, unknown>`, so the linter can't see through. I'll cast to a proper interface: Now fix the floating promise in the setInterval callback: Also the `DealPostedArgs` interface is used as a `void` expression which is valid but unusual — lint might flag unused vars. Let me just remove that dead `void` line since we don't actually need the cast: Also remove the now-unused `DealPostedArgs` interface: Also `set-state-in-effect` — the rule fires because `setDealId` is called inside a `useEffect`. Let me re-read whether the lint rule here is actually an error vs a warning:

Looking at the previous output: `x react(set-state-in-effect)` — that `x` means error level. The fix using a ref should suppress it since now only `setDealId` (one call) is in the effect, but the rule will still fire because `setDealId` itself is called from within an effect. The real fix the lint rule wants is to compute it during render. Let me refactor App.tsx to derive `displayDealId` during render entirely: The right fix: replace the whole pattern with pure render derivation. Keep `dealId` as the "manually selected" value; derive `displayDealId` = `dealId > 0n ? dealId : count ?? 0n` during render. The URL sync then uses `displayDealId`. The `noDeals` condition stays on `count === 0n`. No effect needed at all: Now remove `useRef` from App.tsx since it's no longer used: Now update all places in App.tsx that use `dealId` as the displayed/passed deal ID to use `displayDealId`: Now run the checks again: Zero warnings, zero errors on both lint passes; tsc exits 0. Confirm dev server is alive: Here is the actual check output, pasted verbatim:

```
$ oxlint --type-aware src scripts --fix; s=$?; oxlint --fix .; exit $((s>0?s:$?))
Found 0 warnings and 0 errors.
Finished in 1.3s on 25 files with 57 rules using 4 threads.
Found 0 warnings and 0 errors.
Finished in 229ms on 28 files with 34 rules using 4 threads.
$ tsc --noEmit

[Command succeeded with exit code 0]
```

---

**Part 1 — all 8 files applied exactly as patched:**

- `config.ts`: default is now `testnet`; mainnet gets zero addresses + `deployed: false`; testnet gets the wired addresses + `deployed: true`; `DEPLOYMENT_READY` exported
- `hooks.ts`: `useChainNow` (block-anchored, ref-based, 500ms tick) replaces the browser-clock interval; `useBlockCountdown` returns `number | undefined`; `useBlock` and `useRef` imported; `buyers` fetch removed from `useLiveDealState`
- `CommitFlow.tsx`: `useChainNow` for deadline gate; `isPastDeadline` stays false until chain time is known; approve amount is `tiers[0].pricePerUnit` (curve max)
- `DealRoom.tsx`: `—` until `secondsLeft` is defined; danger color guarded the same way; settle panel only appears when `secondsLeft !== undefined && secondsLeft === 0`
- `SupplierView.tsx`: `chainNow` from `useChainNow`; deadline computed from chain time; posts blocked until chain time is known
- `utils.ts`: allowance errors matched before the generic "insufficient" branch
- `useEventLog.ts`: refuses scan when `deployBlock === 0n`
- `App.tsx`: `DEPLOYMENT_READY` banner; newest-deal default derived during render (no effect/setState); nav fits 375 px

**Part 2a — Activity list:**

`useDealHistory` scans backwards from chain head in 5,000-block windows until it finds the `DealPosted` for this deal, then polls incrementally every 5 s. The state map tracks each address's last action so a withdraw updates rather than adds a row. Display is newest-first, links go to the transaction (not the address), and each row shows the price paid or a "left" badge for withdrawals.

**Part 2b — Scanner error handling:**

- `rpcFetch` now throws `RateLimitError` or `RangeTooLargeError` (distinct classes, not string matching)
- Rate-limit: keeps window, waits exponentially from 500 ms to 16 s, then retries
- Range: halves window immediately, retries same cursor, floor at `MIN_LOG_WINDOW`
- After `GROW_AFTER` (4) consecutive successes: window grows 25% back toward 5,000
- Scan starts at `MAX_LOG_WINDOW = 5000n` instead of 2,000