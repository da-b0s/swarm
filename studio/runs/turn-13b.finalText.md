Reading the current `src/config.ts` before editing. First verify what the viem chain definitions actually export for `rpcUrls.default.http`: All four endpoints are present and in the right order. Now write the updated config: **Actual output:**

```
oxlint: Found 0 warnings and 0 errors
tsc --noEmit:  exit 0
```

`fallback` imported from `wagmi`. `arcFallback(urls)` maps each URL in `arc.rpcUrls.default.http` / `arcTestnet.rpcUrls.default.http` to `http(url, endpointOpts)` and wraps them with `fallback(..., { rank: false })`. The primary endpoint (`rpc.mainnet.arc.io`) stays first; on any failure or 429 viem moves to the next one automatically. Both Arc chain entries now use the four-endpoint fallback; the mainnet ENS transport is unchanged.