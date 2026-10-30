Two files to patch: Clean. The fetch logic:

- **EUR/GBP/MXN**: derived as `usd-coin.usd / usd-coin.<fiat>` so the reference is always USDC (what buyers actually pay), not a raw USD/fiat rate. This means if USDC is trading at 0.999 rather than exactly 1.000, the comparison still reflects real buying power.
- **BTC/ETH**: directly `bitcoin.usd` and `ethereum.usd`.
- Any field that is missing, zero, or non-finite is skipped rather than producing a bad rate. If the entire response is empty the hook returns `null` and keeps whatever stale data it had.