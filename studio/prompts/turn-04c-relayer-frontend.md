The contract work for gasless commits is done and its tests pass. This turn builds the two pieces that use it: the relayer service and the frontend signing flow. Do not change any contract, do not deploy, and do not edit the addresses in `src/swarm/config.ts` — the pool is being redeployed outside Studio, and the new addresses go in afterwards.

THE ABI

Regenerate the `DemandPool` ABI in `src/swarm/abis.ts` from the compiled contract so it includes `commitWithAuthorization`, `authorizationNonce`, `ExcessCredited`, and the errors `PriceRoseBeyondAuthorization(uint64)`, `AuthorizationAlreadyUsed()` and `Blocklisted()`. Add `ExcessCredited` to the /proof scanner so the excess credited to buyers is shown and counted: the pool received it, and every dollar received has to appear on that page.

THE RELAYER — `relayer/`

A small Node service using viem, separate from the frontend so the key never ships to a browser. Its own `package.json`. Configuration from the environment: `RELAYER_KEY`, `RPC_URL`, `CHAIN_ID`, `POOL_ADDRESS`, `ALLOWED_ORIGIN`, `PORT`. The key must never be logged, written to a file, or returned in a response or in your result document. Refuse to start if `CHAIN_ID` does not match what the RPC reports.

`POST /commit` takes `{ dealId, buyer, authorizedAmount, validAfter, validBefore, salt, signature }`. Before broadcasting anything:

- Simulate `commitWithAuthorization`. Never broadcast a transaction you can already tell will revert. Return the decoded error name to the caller; on `PriceRoseBeyondAuthorization`, return HTTP 409 with the new price.
- Screen both the buyer and the relayer with `isBlacklisted`.
- Limit requests per buyer address to something sensible.

Fees: `maxFeePerGas` never below 20 gwei, and `maxPriorityFeePerGas` 0. On Arc a transaction under the 20 gwei floor disappears with no error and no receipt. Track the nonce explicitly; if a transaction has not confirmed in a reasonable time, replace it at a higher fee rather than resubmitting at the same one. Serialise sends so two concurrent requests cannot take the same nonce.

For each relayed commit, append a JSON line to a log file with deal, buyer, transaction hash, block, and gas cost in USDC — `gasUsed * effectiveGasPrice / 1e12`. Return the transaction hash to the caller once it is mined, with the escrowed price and any excess credited, read from the receipt's events rather than assumed.

Add `GET /health` returning the chain id, pool address, relayer address and its USDC balance — never the key.

THE FRONTEND

Read `VITE_RELAYER_URL` in the network config. When it is unset, the gasless option is not shown and everything works as now. When it is set, the commit panel offers committing without gas as the primary path, keeping approve-then-commit as a fallback:

- Generate a random 32-byte salt, read `authorizationNonce(dealId, buyer, salt)` from the pool, and have the wallet sign EIP-712 typed data for `ReceiveWithAuthorization` with domain `{ name: "USDC", version: "2", chainId, verifyingContract: 0x3600000000000000000000000000000000000000 }`. Take `chainId` from the active network config; a testnet signature made with 5042 is invalid. Sign for the price on screen, with `validAfter` 0 and `validBefore` about ten minutes ahead in chain time (`useChainNow`, not `Date.now()`).
- On 409, show the new price and ask the buyer to sign again: a retry with a reason, never an unexplained failure.
- If the price fell before the commit landed, tell the buyer how much is waiting for them to claim, using the figure the relayer read from the receipt.
- The withdrawal precondition and all other existing behaviour must be unchanged.

At the end, run tsc and the linter for the frontend and typecheck the relayer, and paste the actual output.
