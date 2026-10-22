Fixes to the relayer and the gasless signing flow from the last turn. Do not touch the contracts or `src/swarm/config.ts` addresses. The topic hashes in `relayer/server.ts`, the 20 gwei floor in both `currentMaxFeePerGas` and `bumpFee`, the chain-id refusal, and the key handling are all correct — keep them.

1. SIGN FOR THE PRICE ON SCREEN, NOT THE CURVE MAXIMUM

`GaslessCommitFlow.tsx` signs for `tiers[0].pricePerUnit`, reasoning from the approve flow. That reasoning does not carry over. An ERC-20 approval is a ceiling — the contract pulls only the live price. A `receiveWithAuthorization` moves the full signed amount out of the buyer's wallet, and the excess waits in the contract to be claimed. Signing for the maximum means a buyer joining a $0.50 deal needs $1.00 in their wallet and watches $1.00 leave it — which defeats the purpose of the feature, committing an exact balance.

Sign for the price the buyer will pay: the clearing price at the current buyer count plus one, computed with `computeClearingPrice`. That is at most what the contract charges, and if another commit breaks a tier first the small difference is credited back. If a withdrawal pushes the price up, the 409 re-sign path you already built handles it. Show the buyer the exact amount they are signing for.

2. ONE FAILED SEND BREAKS EVERY LATER SEND

`sendMutex = sendMutex.then(async () => { ... })`: if the callback throws, `sendMutex` is a rejected promise, and every later `.then` skips its callback, so every later relay fails until restart. Chain on a promise that cannot reject — for example `const run = sendMutex.then(work); sendMutex = run.catch(() => {}); await run;` — so each request gets its own outcome and the queue keeps moving.

3. A FAILED SEND LEAVES A NONCE GAP

`consumeNonce()` advances the nonce before sending. If `writeContract` throws before the transaction is accepted, that nonce is never used and every later transaction waits behind it forever. On any send failure, reset `nextNonce = null` so the next send re-reads `getTransactionCount` with the `pending` block tag.

4. THE REPLACEMENT LOOP BUMPS THE FEE EVERY TWO SECONDS

After 30 seconds the loop re-sends at +20% on every 2-second poll, because `replaceAt` is never moved forward — about fifteen bumps, ending near fifteen times the starting fee, paid from the relayer's float. After each replacement, set the next replacement time 30 seconds later, and cap the fee at a sane ceiling (say 5x the initial fee) beyond which it stops bumping and reports the stall.

5. A COMMIT THAT LANDED CAN BE REPORTED AS FAILED

The loop checks only the receipt of the latest replacement hash. If the original transaction is the one mined, that check never succeeds, and the request errors on a commit that went through. Keep every hash sent for this nonce and treat a receipt for any of them as confirmation; return the hash that was actually mined.

6. ESTIMATE GAS INSTEAD OF A FIXED 300,000

You already simulate before sending. Use `estimateContractGas` (or the simulation's request) and add a 20% margin, rather than a fixed limit that will revert — and still spend gas — if a commit ever needs more.

7. CORS

Default `ALLOWED_ORIGIN` to refusing cross-origin requests rather than `*`, and log at startup which origin is allowed. Testnet will set it explicitly.

Run tsc and the linter for the frontend and typecheck the relayer, and paste the actual output.
