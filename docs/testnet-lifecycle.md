# Testnet lifecycle run — 22 October 2026

The whole Swarm lifecycle, run against the verified testnet deployment by
[`tools/lifecycle-testnet.mjs`](../tools/lifecycle-testnet.mjs) and checked from
chain at every step. **32 transactions, 33 checks, 0 failures**, $0.086 of gas in
total.

Supplier: the deployer, `0x3CF9D6ca7118431810D6D9Cc7DE8f9acAe9A829f`. Buyers: six throwaway testnet wallets generated for
the run and funded with $2 each; their keys are in `secrets/`, which is gitignored.

## What was exercised

**Deal #1 — happy path.** Curve $1.00 at 1 buyer / $0.75 at 3 / $0.50 at 5,
minimum 2, cap 10.

| Step | Count | Price | Result |
|---|---|---|---|
| Buyers 1, 2 commit | 2 | $1.00 | each escrows $1.00 |
| Buyer 3 commits | 3 | **$0.75** | tier breaks |
| Buyer 1 tries to withdraw | — | — | **refused, `WouldStrandBuyer`** — leaving would put the price back to $1.00, above buyer 3's $0.75 |
| Buyer 4 commits | 4 | $0.75 | |
| Buyer 1 withdraws again | 3 | $0.75 | **now permitted**; full $1.00 credited |
| Buyers 5, 6 commit | 5 | **$0.50** | tier breaks |
| Settle after deadline | 5 | **$0.50** | one transaction |

The refusal and its clearance one commit later is the mechanism's one
unintuitive rule — "one more buyer joins and you're free to go" — demonstrated on
a live chain rather than in a test.

Settlement, checked from the `Settled` event and `claimable` reads:

| | Escrowed | Refund at $0.50 |
|---|---|---|
| Buyer 2 | $1.00 | $0.50 |
| Buyers 3, 4, 5 | $0.75 | $0.25 each |
| Buyer 6 | $0.50 | $0.00 |
| Supplier | — | credited $0.50 × 5 = **$2.50** |

**Conservation: commits in $3.75 = supplier $2.50 + refunds $1.25.** Exact.

**Deal #2 — deliberately failed.** One tier at $0.50, minimum 3. Two buyers
committed; after the deadline `settle` was refused with `MinBuyersNotMet`,
`refundAll` returned $0.50 to each, and both claimed it.

**Guards checked by simulation**, each reverting with the right named error:
settling before the deadline (`DeadlineNotReached`), `refundAll` on a deal that
met its minimum (`MinBuyersMet`), settling a deal below its minimum
(`MinBuyersNotMet`), and settling twice (`AlreadySettled`).

**Claims.** Supplier and all six buyers claimed; every balance moved by exactly
the amount owed less that transaction's gas. The pool holds **$0.00** afterwards.

Gas per operation on testnet: commit $0.0044–0.0053, withdraw $0.0031,
settle (5 buyers) $0.0053, refundAll (2 buyers) $0.0023, claim $0.0015.

## Every transaction

| Step | Transaction | Gas (USDC) |
|---|---|---|
| fund buyer 1 | [`0xe4b83dca…cf25c3`](https://explorer.testnet.arc.io/tx/0xe4b83dca22fd2efdd19f479dbcdc2fc2a55a44aec0e09cf78a807619ddcf25c3) | 0.001848 |
| fund buyer 2 | [`0x8651dd10…e0e02a`](https://explorer.testnet.arc.io/tx/0x8651dd10a80ef3d82742a838f50ac49600112d079174bc6c1c4ba53c8fe0e02a) | 0.001848 |
| fund buyer 3 | [`0x7342044d…eeb25e`](https://explorer.testnet.arc.io/tx/0x7342044d89c48dd45b564d4b7b4c91c94cb6701f87a403af0ea797f4eeeeb25e) | 0.001848 |
| fund buyer 4 | [`0xff959cfd…b56208`](https://explorer.testnet.arc.io/tx/0xff959cfd28eb63d2e85b11453db2b76c6eb1e1b3981efe018cce1eac7ab56208) | 0.001848 |
| fund buyer 5 | [`0x348b55d3…11dee3`](https://explorer.testnet.arc.io/tx/0x348b55d31bd0411ae62bb77fcb8713ebeb141839fb47e91e4a785a042411dee3) | 0.001848 |
| fund buyer 6 | [`0x0f8a2851…16943d`](https://explorer.testnet.arc.io/tx/0x0f8a2851c84795146e512b27d7fd46d9b63a50c89aa235300265078dbc16943d) | 0.001848 |
| approve pool, buyer 1 | [`0x5b25d8cf…ce527e`](https://explorer.testnet.arc.io/tx/0x5b25d8cf2a2e24c58024cda0f0e888adb6dc285aa0466e807be78f7fdfce527e) | 0.001385 |
| approve pool, buyer 2 | [`0x57403cbc…4b28e1`](https://explorer.testnet.arc.io/tx/0x57403cbcef818a1d50070615646df6c9dc958a162b1a05b68f9fd1fc524b28e1) | 0.001385 |
| approve pool, buyer 3 | [`0x12a44914…f40b4e`](https://explorer.testnet.arc.io/tx/0x12a4491444872a37808c057f2b8e165f3b50cd77f37ac884393599cc69f40b4e) | 0.001385 |
| approve pool, buyer 4 | [`0x83b77eb4…7a90ce`](https://explorer.testnet.arc.io/tx/0x83b77eb4c869f1bce35a539e58c16863d8ebd2a6553badfe337cc1b1637a90ce) | 0.001385 |
| approve pool, buyer 5 | [`0x0a13afef…db4281`](https://explorer.testnet.arc.io/tx/0x0a13afef5a107cbc26aafe957b6ffe57e3ae14788b5465bb1ed9bc6c17db4281) | 0.001385 |
| approve pool, buyer 6 | [`0x8f283021…fb27df`](https://explorer.testnet.arc.io/tx/0x8f2830212dbccebc2b05e32623ce6296e3a4b1e3daf435b12507095caefb27df) | 0.001385 |
| post deal A ($1.00/1, $0.75/3, $0.50/5) | [`0x15027b59…08d640`](https://explorer.testnet.arc.io/tx/0x15027b59deca06b8a02ec28f64390a989b3c32f21b1ec58bc41572b29e08d640) | 0.004754 |
| post deal B ($0.50/1, minimum 3) | [`0x5076c7e6…9fd815`](https://explorer.testnet.arc.io/tx/0x5076c7e6268d19e01a6740078c721bc2722b314066d6d4ffe04853996c9fd815) | 0.003085 |
| deal A: buyer 1 commits | [`0x76e3c273…061935`](https://explorer.testnet.arc.io/tx/0x76e3c273f535ee46817e6355922e103f48222a8027f1379cbec15ae7fc061935) | 0.005289 |
| deal A: buyer 2 commits | [`0x743f9512…700912`](https://explorer.testnet.arc.io/tx/0x743f9512cec4e8fd794fcda0b982285c58772d803da52b34a3fb252553700912) | 0.004433 |
| deal A: buyer 3 commits | [`0x4fd8cd2d…aa7ff1`](https://explorer.testnet.arc.io/tx/0x4fd8cd2d4862354d5c5459f1fdb8baa99e3abc89593a0385ea75177544aa7ff1) | 0.004902 |
| deal A: buyer 4 commits | [`0x970e648a…532fc3`](https://explorer.testnet.arc.io/tx/0x970e648ad2bf3a697d9bade118e7e21ac9fe70c9f188f1555996121ec9532fc3) | 0.004420 |
| deal A: buyer 1 withdraws (now permitted) | [`0x1392edd6…5443e1`](https://explorer.testnet.arc.io/tx/0x1392edd622606b1f2cd3e1a1f9066d4acafb9ce3bd34cc1ccb301d88425443e1) | 0.003100 |
| deal A: buyer 5 commits | [`0x836a5bd7…76ec56`](https://explorer.testnet.arc.io/tx/0x836a5bd74b8a01f7b04c0adfd18776c129d6fc22998ccc50189468785c76ec56) | 0.004420 |
| deal A: buyer 6 commits | [`0xb7e52243…d755d4`](https://explorer.testnet.arc.io/tx/0xb7e52243241731c08fa5f8758820b11980564a2a1a2e92cc9fdd0bf042d755d4) | 0.004888 |
| deal B: buyer 5 commits | [`0x23725722…6de5f0`](https://explorer.testnet.arc.io/tx/0x23725722142204683ab1f75cdedfffd3fc4bc0d776de777d15c28f0fd96de5f0) | 0.005029 |
| deal B: buyer 6 commits | [`0xd4e6a027…bccd66`](https://explorer.testnet.arc.io/tx/0xd4e6a02757a9e198c4ebc59d55127d6b19db179eccb9df728209e9e29dbccd66) | 0.004174 |
| deal A: settle | [`0xcfc00496…72beb8`](https://explorer.testnet.arc.io/tx/0xcfc004968de44419b8bb431b603621e37de012fef23fcf95a91dc2430e72beb8) | 0.005256 |
| deal B: refundAll | [`0x0f45eaee…e33113`](https://explorer.testnet.arc.io/tx/0x0f45eaee17cf12ce397bae28b1d2a0ead4b01bc30e652bf5f0297001d4e33113) | 0.002344 |
| supplier claims $2.5 | [`0x12bd0dcf…4d0b7d`](https://explorer.testnet.arc.io/tx/0x12bd0dcf1a046714186130dfd2d74795acbb39b17749da1e33fd6ca6d04d0b7d) | 0.001525 |
| buyer 1 claims $1 | [`0xb7332c42…466919`](https://explorer.testnet.arc.io/tx/0xb7332c42c63f3a1d12d9ef410ee34dde86e1ce7106fa86361a1118d25e466919) | 0.001525 |
| buyer 2 claims $0.5 | [`0xdc2ae269…be31b9`](https://explorer.testnet.arc.io/tx/0xdc2ae2696f5336590ad55f2e9d1fd600c6822fbf574e07a6dddf96aa34be31b9) | 0.001525 |
| buyer 3 claims $0.25 | [`0x44ae5ddc…b0a0d6`](https://explorer.testnet.arc.io/tx/0x44ae5ddccef2b09c0f4e8b48315734b7eadd5f3aab10fd1c446cb8adadb0a0d6) | 0.001525 |
| buyer 4 claims $0.25 | [`0xad8dc66e…124a77`](https://explorer.testnet.arc.io/tx/0xad8dc66eedf495569f18c27611f17f44313062667979392005c5f3a39e124a77) | 0.001525 |
| buyer 5 claims $0.75 | [`0xa0cbac88…082967`](https://explorer.testnet.arc.io/tx/0xa0cbac88ebd583d6390d9d305961997d79883f53aa1a4304fa93d19122082967) | 0.001525 |
| buyer 6 claims $0.5 | [`0x4b476349…454c18`](https://explorer.testnet.arc.io/tx/0x4b47634931a1b0a8bbc2618804e61a7fab9a247171091fe5aa6c648fbf454c18) | 0.001525 |

## What it found in the frontend

The contracts behaved exactly as specified. Watching the live deals in the app
turned up two defects the review had not:

1. **"Recent commits" is not chronological.** It renders `getBuyers()` reversed,
   but the contract removes a withdrawing buyer by swap-and-pop, so storage order
   is scrambled by the first withdrawal. After this run it showed buyers
   6, 5, 3, 2, 4 for a true newest-first order of 6, 5, 4, 3, 2. Each row also
   links to the buyer's address rather than the commit transaction the prompt
   asked for. The fix is to build the list from `Committed`/`Withdrawn` events,
   which carry the price paid and the transaction hash.
2. **The `/proof` scanner cannot tell a rate limit from a range limit.** The RPC
   returns `rate limit exceeded` and `requested range too large` as different
   messages, but the scanner treats any message containing "limit" as a range
   problem: it halves the window and retries immediately with no delay. That
   retry loop trips the rate limiter it is reacting to, pins the window at its
   500-block floor, and never grows it back. Measured with requests spaced
   normally, 5,000-block windows are accepted (10,000 are not) and a burst of 20
   requests is not rate-limited at all — so the full scan from the deploy block
   should take about 65 requests, roughly 15 seconds, instead of the ~8 minutes
   it was heading for.

Both are queued for Studio rather than patched here; see Turn 3b in
[`STUDIO.md`](../STUDIO.md).
