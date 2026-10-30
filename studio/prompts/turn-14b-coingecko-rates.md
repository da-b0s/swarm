One small fix to `src/swarm/useMarketRates.ts` only. The Coinbase exchange-rates endpoint fails from the live site's origin in the browser ("Failed to fetch"), so the market comparison never shows. CoinGecko works from the same origin (checked).

Switch the source to:
`https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,bitcoin,ethereum&vs_currencies=usd,eur,gbp,mxn`

Build the same Map<marketSymbol, USD per 1 whole token>, keyed EUR, GBP, MXN, BTC, ETH:
- EUR = usd-coin.usd / usd-coin.eur, GBP = usd-coin.usd / usd-coin.gbp, MXN = usd-coin.usd / usd-coin.mxn (USDC is the USD reference, which is also what buyers pay in)
- BTC = bitcoin.usd, ETH = ethereum.usd
Skip any value that is missing or not a positive number. Keep everything else in the hook as it is (5-minute refresh, nothing while the tab is hidden, keep stale data on error, never throw). Update the comments that mention Coinbase, and the `marketSymbol` comment in `config.ts`. Run the type check and the linter and paste the actual output.
