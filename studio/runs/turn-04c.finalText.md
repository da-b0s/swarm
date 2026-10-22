Reading everything needed before writing a line. Good. I have everything. Now reading the remaining frontend files: Good. Reading the rest of useEventLog, utils, and the App.tsx to understand structure: Good. I have complete picture of everything. Now setting up todos and executing all work in parallel: Now update useEventLog to track ExcessCredited and add it to per-deal and global totals. Also need to add ExcessCredited to TOPICS and update the conservation model to account for excess: Now update the ProofStats and DealProof interfaces, and the aggregation logic: Now update the derived stats to initialise and aggregate `excessIn` and `totalExcess`, and update the conservation check: Now add the `ExcessCredited` case to the aggregation switch and update the conservation check: Now write the relayer service: Now update the frontend config to expose `VITE_RELAYER_URL`, then write the gasless commit flow: Now write `GaslessCommitFlow.tsx`. This component handles the sign-and-submit path:
- Generates a random 32-byte salt
- Reads `authorizationNonce` from the pool
- Signs `ReceiveWithAuthorization` EIP-712 typed data with `signTypedData`
- Posts to the relayer
- Handles 409 (price rose) with re-sign prompt
- Shows excess credited after success Now update `CommitFlow.tsx` to import and conditionally render `GaslessCommitFlow` as the primary path when `RELAYER_URL` is set, with the existing flow as fallback: Now add a `showFallback` state and render the gasless path first when the relayer is set: Also add a "switch to gasless" link at the bottom of the approve path when relayer is configured: Now also update ProofPage to display `excessIn` per deal. Let me check its current render: Now update ProofPage to show `excessIn` per deal and add `ExcessCredited` badge + summary in the event log, and show `totalExcess` in global stats: Now add `excessIn` to the per-deal row and add `ExcessCredited` to the event log badge/summary: Now add `ExcessCredited` to the event colors and EventSummary: Now run the frontend checks and relayer tsc simultaneously: All 14 errors are the same two issues. Fix `CommitFlow.tsx`: move all hooks before the conditional return; fix `config.ts`: add a type assertion on `VITE_RELAYER_URL`. I'll do both in one pass by rewriting CommitFlow's top section to hoist all hooks before the conditional: Now add the conditional return after all hooks are called. First I need to find where it should go — after `maxCharge` definition. Let me find the spot right after all hooks and derived values, before the handlers: The conditional return needs to go after all hooks are called. I'll place it after `maxCharge` (the last derived value) and before the handlers: Now fix the `config.ts` unsafe-any: Frontend is clean. Now typecheck the relayer: Four type errors to fix:

1. `privateKeyToAccount` is in `viem/accounts`, not `viem` root
2. `nextNonce` type clash — needs to track `number` not `bigint` for nonce (wagmi uses number nonces) 
3. `sendMutex` assignment issue — `txHash` declared with `!` but used before assignment; the mutex is a `Promise<void>` but `sendMutex =` reassigns it  
4. `publicClient.decodeEventLog` doesn't exist — that's a viem utility function, not on the client Fix the nonce type (`number`, not `bigint`): Now fix the relay function — `txHash` and `gasPrice` need to be properly scoped, and the mutex reassignment needs to handle the promise type correctly. Also remove the dead `decoded` assignment (the `decodeEventLog` from `publicClient` which doesn't exist): Now fix the `decodeEventLog` usage — remove the dead `decoded` variable and use raw topic matching directly: Confirm the frontend dev server is still up: Actual check output:

**Frontend (`bash scripts/check.sh`):**
```
$ oxlint --type-aware src scripts --fix; s=$?; oxlint --fix .; exit $((s>0?s:$?))
Found 0 warnings and 0 errors.
Finished in 1.3s on 27 files with 57 rules using 4 threads.
Found 0 warnings and 0 errors.
Finished in 209ms on 31 files with 34 rules using 4 threads.
$ tsc --noEmit

[Command succeeded with exit code 0]
```

**Relayer (`cd relayer && npx tsc --noEmit`):**
```
[Command succeeded with exit code 0]
```

---

Here is what was built and why each decision is correct.

**`src/swarm/abis.ts`**

`commitWithAuthorization` and `authorizationNonce` added as functions; `ExcessCredited` added as an event with `dealId` and `buyer` indexed and `amount` non-indexed; `PriceRoseBeyondAuthorization(uint64)`, `AuthorizationAlreadyUsed()`, and `Blocklisted()` added as errors. All entries match the compiled artifact verbatim.

**`src/swarm/useEventLog.ts`**

`ExcessCredited` is now a tracked topic with its own keccak256 hash. The aggregation switch adds `excessIn` to the per-deal struct and `totalExcess` to global stats. The conservation equation is unchanged (`commitsIn = supplierCredited + refundsOut` for settled, `commitsIn = refundsOut` for refunded) because excess enters and exits the pool atomically in the same transaction: `receiveWithAuthorization` transfers the full authorized amount in, then `creditWithdrawal` immediately credits the excess out to the buyer's claimable balance. The pool's net accounting sees only the escrowed portion, so excess cancels out of the conservation equation. It is displayed separately so every dollar received is visible.

**`relayer/server.ts`**

The nonce is tracked as a `number` (matching viem's `getTransactionCount` return type) and managed through a promise-chain mutex so concurrent requests never see the same nonce. The send loop bumps the fee by 20% if the transaction has not confirmed within 30 seconds, using the same nonce. `privateKeyToAccount` is imported from `viem/accounts` (not the root `viem` export). Log parsing uses raw topic matching against the known keccak256 hashes rather than `publicClient.decodeEventLog` (which does not exist on the client object). The key is never logged, returned, or interpolated into any string.

**`src/swarm/GaslessCommitFlow.tsx`**

Signs for `tiers[0].pricePerUnit` (the curve maximum), not the live price. This is the same reason `CommitFlow` approves the max: the price can rise between signing and submit, and the contract will charge the live price at that moment. If the price falls, the excess is immediately credited via `creditWithdrawal` and shown to the buyer after the relayer returns the confirmed receipt. `validBefore` is computed from `useChainNow()` so it tracks chain time, not the browser clock. On a 409 response, a fresh salt is generated and `authorizationNonce` is re-fetched before re-displaying the sign button with the new price — the buyer always signs a fresh nonce for the fresh price.

**`src/swarm/CommitFlow.tsx`**

All hooks are now called unconditionally before any conditional return, satisfying rules-of-hooks. The conditional return (`if (RELAYER_URL && !showFallback)`) sits after `maxCharge`, the last derived value, where no hook can follow it.