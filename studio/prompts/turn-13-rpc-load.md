Performance fix found on the live mainnet site. No contract changes, no deploy, no address changes, no visual changes.

PROBLEM

The public Arc mainnet RPC (https://rpc.mainnet.arc.io) rate-limits per visitor. One open tab of the hosted site made 85 RPC requests in 20 seconds and 15 came back HTTP 429, so prices and balances intermittently fail to load. JSON-RPC batching is already on in `src/config.ts`, but each `eth_call` inside a batch still counts, and several reads poll every 3–4 seconds.

TARGET

One idle visitor on any page stays under 1 RPC request per second on average, measured over 30 seconds, with no 429s. The live price still feels live.

CHANGES

1. Multicall. Turn on wagmi's multicall batching in `createConfig` (`batch: { multicall: true }`) so concurrent `readContract`/`useReadContracts` calls on Arc are aggregated through Multicall3 (deployed on Arc mainnet and testnet at 0xcA11bde05977b3631167028862bE2a173976CA11; make sure the chain definitions used include it). Keep JSON-RPC batching on the transport.

2. Polling.
   - Deal room live state (price, units sold, buyer count): 10 s.
   - The connected wallet's own order, balances and claimables: 15 s, and refetch immediately after any transaction of theirs confirms (this already happens in places; make sure it is consistent).
   - Deal list, homepage stats, global claims banner: 30 s.
   - Nothing polls while the tab is hidden.
   Find every `refetchInterval` and every `setInterval`/polling hook and set it from one small set of named constants in `src/swarm/config.ts`, so the cadence is tuned in one place.

3. Chain clock. `useChainNow` should read the latest block timestamp once (and again every 60 s), then advance it locally each second with the browser clock, instead of fetching blocks continuously. Countdowns must still use chain time, not the visitor's clock alone.

4. Resilience. On the http transports set `retryCount: 4` with exponential backoff starting at 500 ms, so an occasional 429 is retried quietly instead of surfacing as an error.

5. The proof page's log scan is user-triggered; leave its behaviour alone, but make sure it stops its requests when the visitor leaves the page.

Do not change what any number on screen means. Run the type check and the linter and paste the actual output.
