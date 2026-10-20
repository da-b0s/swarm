The collateral redesign looks right — I have reviewed all four contracts. Three residual fixes, one event change, then deploy.

CONTRACT FIXES

1. `postDeal` accepts a zero tier price. Prices must strictly descend, so only the last tier can be zero, but a zero bottom tier means a deal that can settle while paying the supplier nothing. Reject it: every `tiers[i].pricePerUnit` must be greater than zero.

2. `postDeal` accepts `minBuyers == 0`, and that creates a permanently stuck deal. With `minBuyers == 0`, `refundAll` can never run because `buyers.length >= minBuyers` is always true, while `settle` on a deal with zero buyers reads `collateral[dealId]` as 0 and underflows `top - cp`. Both exits revert and the deal is wedged forever. No funds are at risk, but I am asserting as a test that no deal past its deadline can have both `settle` and `refundAll` revert, and this breaks it. Require `minBuyers >= 1`.

3. `collateral[dealId]` is set lazily on the first `commit`, which is the root cause of fix 2 and also means the value reads as zero for a posted deal nobody has joined yet — the frontend needs it to show the commit amount before the first buyer. Set `collateral[dealId] = tiers[0].pricePerUnit` in `postDeal` and drop the lazy initialization from `commit`.

EVENTS — the /proof page must be derivable from logs alone

Right now `Committed` carries only `livePrice`, not the amount actually pulled, so an indexer cannot total USDC moved without extra contract calls, and `Refunded` carries only a buyer count, so per-buyer refunds are invisible. Change them to:

- `DealPosted(uint256 indexed dealId, address indexed supplier, uint32 minBuyers, uint64 deadline, uint64 collateral)`
- `Committed(uint256 indexed dealId, address indexed buyer, uint64 collateralPaid, uint64 livePrice, uint32 buyerCount)`
- `Withdrawn(uint256 indexed dealId, address indexed buyer, uint64 collateralReturned, uint64 livePrice, uint32 buyerCount)`
- `Refunded(uint256 indexed dealId, address indexed buyer, uint256 amount)` — emitted once per buyer inside `refundAll`, not once per deal
- `Settled(uint256 indexed dealId, uint64 clearingPrice, uint32 buyerCount, uint64 collateral, uint256 totalRefunds)`
- `TierBroken` stays as it is.

With those, conservation can be re-derived from chain events rather than taken on trust from a test, which is the point of the proof page.

HOUSEKEEPING

Hoist `top - cp` out of the settle loop — it is invariant across buyers and currently recomputed for every one of up to 100 iterations.

Update the "Key constraints" comment block at the top of each contract. Every file still carries the same copy-pasted list, and it is now wrong in three ways: conservation is a named error rather than an `assert`, `Settler` lists `commit`/`withdraw` which it does not have, and the escrow rule is uniform top-tier collateral rather than the current tier price. A reviewer reads these comments.

DEPLOY

Then deploy all four contracts to Arc testnet (chain 5042002) and wire them: `DealFactory.setDemandPool`, `DealFactory.setSettler`, `DemandPool.setSettler`. Report for each contract its address and the block number it was deployed in, and confirm the wiring calls succeeded.
