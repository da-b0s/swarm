Frontend only. No contract changes, no deploy, no address changes for the Swarm contracts. Keep every existing safeguard, and keep all existing deals, stats and claims working exactly as now (the homepage volume must not change).

1. PRICE PER TOKEN, EVERYWHERE — a real safety issue

A seller can set "1 unit = 0.5 EURC" and price the unit at 1.13 USDC. Buyers see "1.13 per unit" and assume it is the EURC rate, so they pay twice the market price without noticing. We saw this happen in testing. Units of any size stay allowed; the page must make the real rate impossible to miss.
- Add a helper `pricePerToken(pricePerUnit, tokensPerUnit, decimals)` that returns USDC per 1 whole token (bigint math, no floats for the value itself; format for display only).
- Deal cards in the deal list, the deal room header, the order panel and the tier table all show, next to every per-unit price, the per-token price in equal or larger type: "1 unit = 0.5 EURC · 2.26 USDC per EURC". When tokensPerUnit is exactly 1 whole token, show it once ("1.13 USDC per EURC").
- Order confirmation (before the wallet opens) states it in one plain sentence: "You pay up to 3.39 USDC for 1.5 EURC (2.26 USDC per EURC). You get the difference back if the price drops."
- Sell page: the tier editor shows the per-token price beside every tier price as the seller types, using the same helper and the same tokensPerUnit that is posted.
- Market comparison: add `useMarketRates()` that fetches `https://api.coinbase.com/v2/exchange-rates?currency=USD` once on load and every 5 minutes (no polling in a hidden tab), and gives USD per token for EURC (EUR), GBPA (GBP), MXNB (MXN), cirBTC (BTC) and WETH (ETH). Map each goods token to its currency with a `marketSymbol` field in config. Where a rate exists, show "x% above market" / "x% below market" next to the per-token price; amber when more than 5% above, red when more than 15% above, and in the order confirmation add one line: "This is 103% above the market rate for EURC." If the fetch fails or a token has no rate, show nothing extra — never block an order, never guess a rate.

2. QUANTITY: TYPE IT IN

Buying 100+ units means 100+ clicks on the plus button. In the order panel:
- Make the quantity a text input that accepts typed whole numbers (inputMode numeric). Keep the − and + buttons.
- Add quick buttons: +10, +100 and Max. Max = the most this wallet can order now: the smallest of remaining stock, the per-buyer limit minus what the buyer already holds, and what the buyer's USDC balance covers at the current price for that quantity (account for the price falling as units are added; when unsure, use the current price, which is the safe upper bound).
- Invalid input (empty, zero, decimals, above the limit) shows a short plain message under the box and disables the button; never silently change what the user typed. Remove any slider for quantity.
- Same for the top-up and partial-withdraw amount fields.

3. MORE TOKENS TO SELL

In `config.ts`, `GOODS_TOKENS` for mainnet becomes these five (addresses verified on Arc mainnet; keep the testnet list as it is):
- EURC, Circle euro, `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`, 6 decimals, market EUR
- GBPA, Agant British pound, `0xbBe6aAB0Ed76e90AeA0d1cd978EC231c8AdCDF8b`, 6 decimals, market GBP
- MXNB, Mexican peso (Bitso), `0xF197FFC28c23E0309B5559e7a166f2c6164C80aA`, 6 decimals, market MXN
- cirBTC, Circle wrapped Bitcoin, `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0`, 8 decimals, market BTC
- WETH, bridged Ether, `0x128cC466B61f542da60c70e3aA11c10e19B84EDB`, 18 decimals, market ETH
Then remove every remaining place that assumes EURC: labels like "EURC per unit" use the selected token's symbol; the Sell page's token picker lists all five with balance; deal pages, the proof page and the event log read the token from the deal and look up its symbol and decimals (fall back to reading `symbol()` and `decimals()` on chain for any token not in the list, and label it "Unverified token"). Homepage copy: "Group deals on stablecoins and tokens on Arc" instead of the EURC-only sentence. Volume stays in USDC, so the stats are unaffected.
- Formatting: 18-decimal and 8-decimal amounts must display sensibly (trim trailing zeros, up to 6 significant decimals), and parsing must use each token's own decimals.

Then sweep the order panel, deal room and Sell page for any other place where a number shown differs from the number sent on chain, or where a per-unit price is shown without its per-token price. Run the type check and the linter and paste the actual output.
