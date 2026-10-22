Two parts: bring the workspace in line with fixes made in review, then fix two defects found by running the app against live testnet deals.

PART 1 — APPLY THE REVIEW FIXES

I pulled your Turn 3 frontend, reviewed it against the contracts, and fixed six defects locally. The workspace does not have those fixes yet, so it and my copy have diverged in eight files. Apply the attached unified diff — it is at `context/turn-03b-review-fixes.patch`, with paths relative to the app root — exactly, so the two match again before any further frontend work. What it changes, so you can check it rather than apply it blind:

- `src/swarm/config.ts`: the network table was inverted. The verified, wired testnet addresses (0x5b646D21…, 0x2Eab29C0…, 0xB4dFC8b4…, block 68162131) had been put under `mainnet`, and `testnet` held 0x70e334…, 0x257d…, 0x9c5cfe… — your own sandbox deployment from an earlier turn, which was never wired (`settlerSet` reads false, so `commit` reverts). With the default set to mainnet, the app pointed at chain 5042 at addresses with no code. Mainnet is now `deployed: false` with zero addresses, the default is testnet, and `DEPLOYMENT_READY` is exported. Please do not take addresses from your own `deployments` list in future: it reports deploys that were never wired.
- `src/swarm/hooks.ts`: `useBlockCountdown` used the browser clock. New `useChainNow` anchors on the latest block timestamp (via `useBlock` with `watch`) and ticks from elapsed time; the countdown returns `undefined` until chain time is known.
- `src/swarm/CommitFlow.tsx`: deadline gate uses `useChainNow`; `approve` is for `tiers[0].pricePerUnit` (the curve's maximum) instead of the price on screen, because a withdrawal can raise the live price between approve and commit.
- `src/swarm/SupplierView.tsx`: deal deadline computed from chain time, not `Date.now()`.
- `src/swarm/utils.ts`: allowance failures are matched before the generic "insufficient" branch, which was reporting them as a balance problem.
- `src/swarm/useEventLog.ts`: refuses to scan when `deployBlock` is 0 rather than scanning from genesis.
- `src/swarm/DealRoom.tsx`: renders "—" until chain time is known.
- `src/App.tsx`: banner when the active network is not deployed; lands on the newest deal (ids start at 1, so deal 0 never exists) with an empty state when there are none; nav fits at 375px.

Also delete `scripts/wire-swarm.ts` and `scripts/wire-swarm-v3.ts` and remove them from `.oxlintrc.json` `ignorePatterns` and the tsconfig excludes. They are dead — wiring is done outside Studio — and excluding them from the checks to get a green result is not something I want in the repo.

PART 2 — TWO DEFECTS FROM THE LIVE RUN

I ran the full lifecycle on testnet (deals #1 and #2 on the addresses above): commits, two tier breaks, a refused withdrawal, a permitted one, settle, refundAll, claims. The contracts were exact. The app had two problems.

1. RECENT COMMITS IS NOT CHRONOLOGICAL

`DealRoom` renders `getBuyers()` reversed. The contract removes a withdrawing buyer by swap-and-pop, so storage order is scrambled by the first withdrawal: after the run it showed buyers 6, 5, 3, 2, 4 where newest-first is 6, 5, 4, 3, 2. Rows also link to the buyer's address, not the transaction.

Build the list from events instead. `Committed` and `Withdrawn` both have `dealId` as their first indexed topic, as does `DealPosted` on the factory, so one `eth_getLogs` filter on `[[DealPosted, Committed, Withdrawn], dealIdTopic]` across the factory and pool returns only this deal's history. Scan backwards from head until the deal's `DealPosted` is found (or the deploy block is reached), then follow forward incrementally from the last block seen rather than rescanning. Show newest first: the address, the price paid from the event, a "left" marker for withdrawals, and a link to the transaction on the explorer.

2. THE /PROOF SCANNER MISTAKES A RATE LIMIT FOR A RANGE LIMIT

The RPC returns two different errors: `requested range too large` and `rate limit exceeded`. `useEventLog` treats any message containing "limit" as a range problem, halves the window and retries immediately. That zero-delay retry is what trips the rate limiter, so the window collapses to its 500-block floor and never recovers — the scan of ~320k blocks was heading for about 8 minutes.

Measured from this machine with requests spaced normally: 2,000- and 5,000-block windows are accepted with the seven-topic filter across the three contracts; 10,000 and above return `requested range too large`. A burst of 20 back-to-back requests was not rate-limited at all.

So:
- Start at 5,000 blocks.
- On `requested range too large`, halve the window and retry.
- On `rate limit exceeded` (or HTTP 429), keep the window and wait before retrying, with exponential backoff starting around 500 ms and a cap; never retry instantly.
- After several consecutive successes, grow the window back toward 5,000.
- Treat any other error as a real failure and surface it.

Done looks like: the full scan from block 68162131 finishes in well under a minute, shows deals #1 and #2, and the conservation row for deal #1 reads commits in $3.75 = supplier credited $2.50 + refunds out $1.25.

Do not redeploy or touch the contracts. Run tsc and the linter at the end and paste their actual output, not a summary of it.
