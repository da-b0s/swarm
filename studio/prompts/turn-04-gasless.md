Add gasless commits via EIP-3009: a buyer signs once, a relayer submits and pays gas, and the buyer is recorded as the committer.

WHY, PRECISELY

On Arc, gas is paid in USDC, so a wallet holding USDC can always pay gas. The value here is narrower and real: a buyer can commit their entire balance — exactly $1.00 for a $1.00 tier — without holding back an amount for gas they cannot predict, and never sees a gas prompt at all. Design for that, not for "wallets with no native balance", which cannot exist on Arc.

VERIFIED FACTS — use these, do not re-derive them

I read these from both chains today:

- USDC at `0x3600000000000000000000000000000000000000` on both mainnet (5042) and testnet (5042002) is a proxy to the same implementation, `0xc6ad664ac6679f4ce74e10e91449c93ec1ae3ca6`.
- `name()` is "USDC" and `version()` is "2" on both. `DOMAIN_SEPARATOR()` equals the EIP-712 hash of `{ name: "USDC", version: "2", chainId, verifyingContract: 0x3600… }` on both, so the domain differs between networks only by chainId.
- `transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization` and `isBlacklisted` are all present.

The chainId in the signing domain must come from the active network config, never a constant. A testnet signature made with chainId 5042 is invalid.

USE receiveWithAuthorization, NOT transferWithAuthorization

This is the most important design rule in the turn. A `transferWithAuthorization` signature can be submitted directly to USDC by anyone who sees it. The buyer's USDC would then arrive at the pool with no commit recorded — funds the contract's accounting does not know about, which no one can withdraw or claim. `receiveWithAuthorization` only succeeds when called by the payee (`to`), so only the pool can execute it, and only as part of a commit.

BIND THE SIGNATURE TO THE DEAL

An EIP-3009 authorization says nothing about which deal it is for. The contract must make it impossible to use a buyer's signature for any deal other than the one they chose. Derive the authorization nonce from the deal — for example `nonce = keccak256(abi.encode(address(this), dealId, buyer, salt))` with the salt passed alongside — and require the contract to recompute and match it. Explain in your reply what you chose and why a relayer cannot redirect a commit.

THE CONTRACT CHANGE

Add `commitWithAuthorization` to `DemandPool`. It must apply exactly the same checks as `commit` — settler configured, deal open, before deadline, not already committed, under cap, not paused — so refactor both into one internal function rather than duplicating them. The buyer is the signer, never `msg.sender`.

The price race. An authorization is for a fixed amount, but a commit escrows the live price when it lands:

- If the authorized amount is at least the live price, escrow the live price and credit the excess to the buyer's claimable balance in the same transaction, using the existing `ISettler.creditWithdrawal` path. The price only falls as volume grows, so signing for a price that then falls must succeed.
- If a withdrawal has un-broken a tier and the live price is now above the authorized amount, revert with a named error carrying the new price, so the relayer can re-quote and ask the buyer to re-sign.
- Emit `Committed` exactly as `commit` does, with the buyer and the price actually escrowed, so the activity list and /proof work unchanged. Also emit an event for any excess credited, with deal, buyer and amount, so /proof can account for every dollar the pool received.

A reused authorization nonce must revert with a named error. USDC itself rejects replays; surface it clearly rather than relying on the token's revert string.

Do not change `Settler` or `DealFactory` unless you must, and if you must, say exactly why.

DO NOT DEPLOY

Changing `DemandPool` means a new deployment of all three contracts, because the factory's pool address is set once. We deploy and wire from our own deployer outside Studio — your sandbox cannot send the owner wiring transactions, which is why deployment left Studio in Turn 1d. Do not deploy, do not wire, and do not put any address into the frontend config. Do not take addresses from your own deployments list for anything; it has reported deployments that were never wired.

TESTS

Extend `SwarmTest.t.sol`. All 19 existing tests must still pass. Add a mock USDC with a real EIP-3009 implementation — EIP-712 signature verification and `receiveWithAuthorization`'s payee check, signed in tests with `vm.sign` — rather than a mock that accepts anything. Cover at least:

- a gasless commit is recorded for the signer, not the relayer;
- the price falls between signing and landing: commit succeeds, excess credited, conservation holds at settlement;
- the price rises above the authorization: named revert carrying the new price;
- a replayed authorization: named revert;
- a signature for one deal cannot commit to another;
- `transferWithAuthorization` called directly on the token cannot produce a commit;
- the existing conservation fuzz property extended to mix ordinary and gasless commits, including excess credits.

Paste the complete, unedited `forge test` output at the end. Not a summary.

THE RELAYER

A small Node service in `relayer/` using viem, separate from the frontend so the key never ships to a browser. It reads `RELAYER_KEY`, the RPC URL, chain id and pool address from the environment; the key must never be logged, committed or returned in any response or result document.

`POST /commit` takes the deal id, the authorization fields and the signature. Before sending anything it must:

- simulate the call and refuse anything that would revert — never broadcast a transaction you can already tell will fail — returning the decoded error to the caller; on the price-rose error, return HTTP 409 with the new price;
- screen both the buyer and the relayer with `isBlacklisted`; a blocklisted party makes the transfer revert and still burns gas;
- cap requests per buyer address to something sensible.

Fees: `maxFeePerGas` never below 20 gwei, `maxPriorityFeePerGas` 0. On Arc a transaction below the 20 gwei floor vanishes with no error and no receipt. Track nonces explicitly, and if a transaction has not confirmed in a reasonable time, replace it at a higher fee rather than resubmitting at the same one.

For each relayed commit, append a JSON line with the deal, buyer, transaction hash and gas cost in USDC — `gasUsed * effectiveGasPrice / 1e12` — so the cost can be published on the proof page.

THE FRONTEND

Read the relayer URL from `VITE_RELAYER_URL`. When it is unset, the gasless option does not appear and everything works as now. When set, the commit panel offers committing without gas as the primary path:

- the wallet signs EIP-712 typed data for `ReceiveWithAuthorization` with the domain above, for the price on screen, with a validity window of about ten minutes measured from chain time (use `useChainNow`, not `Date.now()`);
- on 409, show the new price and ask the buyer to sign again — a retry with a reason, never an unexplained failure;
- if the price falls before it lands, tell the buyer the difference is waiting for them to claim;
- keep the approve-then-commit path available as a fallback.

Standing instructions: run tsc and the linter at the end and paste the actual output, and do not touch the contract addresses in `src/swarm/config.ts`.
