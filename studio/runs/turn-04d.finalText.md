Reading the current relayer and GaslessCommitFlow in full before touching anything. I have both files completely. Seven fixes needed. I'll apply them in parallel: `GaslessCommitFlow.tsx` gets one surgical edit (sign for `clearingPrice` not `tiers[0].pricePerUnit`); `server.ts` gets six fixes. Fix 1 — GaslessCommitFlow: remove the max-price logic and sign for `clearingPrice` directly. The `tiers` prop and its comment go away; the price shown and signed are both `priceToSign` which defaults to `clearingPrice`: Now remove the now-unused `tiers` dependency from the `useCallback` dep array and from the component signature — `tiers` is still a prop used by the parent, but `GaslessCommitFlow` itself no longer uses it. Check if it's used anywhere else in this component: `tiers` appears in the Props interface, destructuring, and dep array but is no longer used in the component body. Remove it from all three, and remove the `DealTier` import since it's only used for `tiers`: Now find where GaslessCommitFlow is called in CommitFlow to remove the `tiers` prop: Good. Now the six server.ts fixes. I'll rewrite the nonce manager + relay function in one targeted block:

**Fix 7 — CORS default**: change `ALLOWED_ORIGIN` default from `'*'` to `''` (refuse) and log at startup: **Fix 2, 3, 4, 5, 6 — rewrite the nonce manager and the relay `send` block in one replacement:** Now rewrite the entire send block in `relay()`: There's now a stale `// 4. Wait for the confirmed receipt.` line that was the old step 4 — it needs to be removed since the receipt is now in `confirmedReceipt`: Now also remove the old step number comments that are now wrong, and update the gas cost comment to reference step 6: Now update the startup log to show the CORS origin: Now run both checks: Actual output:

**Frontend (`bash scripts/check.sh`):**
```
$ oxlint --type-aware src scripts --fix; s=$?; oxlint --fix .; exit $((s>0?s:$?))
Found 0 warnings and 0 errors.
Finished in 1.4s on 27 files with 57 rules using 4 threads.
Found 0 warnings and 0 errors.
Finished in 231ms on 31 files with 34 rules using 4 threads.
$ tsc --noEmit

[Command succeeded with exit code 0]
```

**Relayer (`cd relayer && npx tsc --noEmit`):**
```
[Command succeeded with exit code 0]
```

---

Here is what changed and why each fix is correct:

**Fix 1 — sign for `priceToSign` (= `clearingPrice`).** The comment in the previous version was wrong: "the pool only pulls the live price" applies to `transferFrom` approvals (which are ceilings), not to `receiveWithAuthorization` (which transfers exactly the signed amount). Signing for `tiers[0].pricePerUnit` would transfer the full top-tier price out of the buyer's wallet regardless of what tier they're actually joining. `tiers` is removed from Props, the import, the destructuring and the dep array entirely.

**Fix 2 — mutex never poisons the queue.** The pattern is now `const run = sendMutex.then(work); sendMutex = run.catch(() => {})`. `sendMutex` always resolves, so the next caller's `.then(work)` always fires. Each caller `await run`s its own promise and gets its own error if the send failed.

**Fix 3 — nonce reset on send failure.** `sendAtFee` calls `resetNonce()` in its `catch` block before re-throwing. The next `resolveNonce()` call re-reads `getTransactionCount({ blockTag: 'pending' })`, which returns the first unused nonce as the mempool sees it, skipping any gap.

**Fix 4 — bump timer advances after each replacement.** `nextReplace = Date.now() + REPLACE_INTERVAL_MS` is reassigned inside the bump branch. A `feeCap` of `5 × initFee` is enforced; bumping stops when the fee hits the cap.

**Fix 5 — all hashes tracked.** `allHashes: Hex[]` collects every hash submitted for this nonce. The confirmation loop checks all of them on each poll. After the send work completes, the receipt-finding loop iterates `allHashes` to locate which one was actually mined and returns that hash to the caller.

**Fix 6 — `estimateContractGas` + 20% margin.** The simulation is followed immediately by `estimateContractGas` using the same args. The result multiplied by `120n / 100n` is used as the `gas` limit for every `writeContract` call. The fixed 300,000 is gone.

**Fix 7 — CORS defaults to empty string.** An empty `ALLOWED_ORIGIN` means the `Access-Control-Allow-Origin` header is sent as `""`, which browsers treat as a refusal. The startup log prints the effective origin so operators can confirm it at a glance.