Follow-up to the RPC-load fix. Only `src/config.ts`. No other changes.

viem's own Arc chain definitions list four official RPC endpoints per network, and all four mainnet ones answer chain 5042 and allow browser requests from our site:

    mainnet: https://rpc.mainnet.arc.io, https://rpc.blockdaemon.mainnet.arc.io,
             https://rpc.drpc.mainnet.arc.io, https://rpc.quicknode.mainnet.arc.io
    testnet: https://rpc.testnet.arc.io, https://rpc.blockdaemon.testnet.arc.io,
             https://rpc.drpc.testnet.arc.io, https://rpc.quicknode.testnet.arc.io

Replace the single `http()` transport for each Arc chain with viem's `fallback()` over an `http()` per endpoint, taken from `arc.rpcUrls.default.http` / `arcTestnet.rpcUrls.default.http` rather than hardcoded. Keep JSON-RPC batching and the retry settings on each `http()`. Use `fallback(..., { rank: false })` so a rate-limited or failing endpoint is skipped and the next one is used. Keep `rpc.mainnet.arc.io` first.

Do not touch `src/swarm/rpc.ts` (the proof page's log scanner); it uses the primary endpoint on purpose.

Run the type check and the linter and paste the actual output.
