One bug found by running the relayer end to end on testnet, plus three small items. Change only `relayer/server.ts`. No contract, frontend or config changes.

The run, against the redeployed testnet pool through the real relayer: a plain gasless commit moved exactly the price out of the buyer's wallet and nothing more; a commit signed at $1.00 that landed after a tier break escrowed $0.50 and credited $0.50 back; settlement conserved exactly and the pool ended at $0; three relays cost $0.0155 in gas. Turn 4d's queue, nonce, replacement and receipt fixes held. One thing did not:

1. NO NAMED CONTRACT ERROR EVER REACHES THE 409 / 403 MAPPING

With the price risen above the authorization, the contract correctly reverted `PriceRoseBeyondAuthorization(750000)` in simulation and nothing was broadcast — but the relayer answered HTTP 400 with viem's whole error text instead of 409 with `requiredPrice`. The frontend's re-sign flow only runs on 409, so a buyer would see a wall of error text instead of "the price is now $0.75, sign again". A replayed authorization came back the same way.

Cause, in the simulation `catch`: it reads `e.cause.data` and passes it to `decodeErrorResult`. But viem's `simulateContract` throws a `ContractFunctionExecutionError` whose cause is a `ContractFunctionRevertedError`, and that error's `.data` is already decoded — an object with `errorName` and `args`, not hex. `decodeErrorResult` throws on it, the fallback rethrows the raw error, and no `code` is ever set.

Fix: use `e.walk(err => err instanceof ContractFunctionRevertedError)` and read `.data.errorName` and `.data.args` from it. Then:

- `PriceRoseBeyondAuthorization` → 409 `{ error: "PriceRoseBeyondAuthorization", requiredPrice }`
- `Blocklisted` → 403
- every other named contract error → 400 `{ error: "<ErrorName>" }`
- anything unrecognised → 500 `{ error: "Relay failed" }`, with the detail logged server-side only

Never return viem's message text to the client. It echoes the full call — the buyer's signature, the relayer address, internal URLs — and it is not something a browser should show.

2. A FIELD WHOSE VALUE IS THE NUMBER 0 IS REJECTED AS MISSING

`if (!body[f])` treats `validAfter: 0` as absent. The frontend happens to send strings, but any other client sending a number gets "Missing field: validAfter". Check for `undefined`, `null` or empty string instead.

3. A REJECTED REPLACEMENT BUMPS THE FEE AGAIN ON THE NEXT POLL

When a replacement send throws, `nextReplace` is not advanced, so the loop bumps again two seconds later. No transaction goes out at those fees, so nothing is spent, but the fee reaches its cap without ever being tried. Advance `nextReplace` whether the replacement succeeded or not.

4. THE STARTUP COMMENT STILL SAYS `ALLOWED_ORIGIN — CORS origin (default *)`

The default is now to refuse cross-origin requests. Correct the comment.

Typecheck the relayer and paste the actual output.
