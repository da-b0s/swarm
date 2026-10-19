Four corrections to the Swarm contracts. The first locks user funds, so treat it as the priority.

1. SETTLEMENT CAN BE BRICKED BY WITHDRAWALS. In Settler.settle you compute `uint256 refund = uint256(paid) - cp`. A withdrawal raises the volume-unlocked price, so a buyer who committed when volume was high can have escrowed LESS than the final clearing price. Concretely, on the curve (10 @ $1.00, 25 @ $0.75, 50 @ $0.50) with minBuyers 10: 50 buyers commit, so the last of them escrows $0.50; then 25 of the earliest withdraw; volume is 25, so the tier price is back to $0.75. For that buyer `paid - cp` is `500000 - 750000`, which underflows and reverts. settle() then reverts forever, and refundAll() also reverts because 25 buyers is above the minimum of 10 - so every participant's escrow is permanently stuck. This arises in roughly 0.5% of random commit/withdraw sequences, so it is not a corner case.

   Fix: settlement must never clear above the lowest price actually escrowed, because the contract cannot charge a buyer more after the fact. Compute the clearing price for settlement as min(tierPriceForFinalCount, lowest escrowed price across the deal's buyers). With no withdrawals the two are identical, so nothing changes on the happy path. Track the lowest escrowed price incrementally rather than looping twice if that keeps settle within the gas budget. Assert in settle that no buyer's escrow is below the clearing price.

2. TierBroken IS EMITTED ON THE WRONG EVENT. commit() never emits TierBroken, so the downward break - the entire point of the product - produces no event. withdraw() emits it for upward moves only. Emit TierBroken from commit() whenever the live price changes, and from withdraw() whenever it changes, with the direction evident from the new price. The frontend and the /proof page both key off this event.

3. withdraw() PUSHES USDC DIRECTLY to the buyer with `USDC.transfer(msg.sender, amount)`. Arc reverts transfers to blocklisted addresses, so a blocklisted buyer cannot withdraw at all. Credit the claimable mapping instead and let them pull, exactly as settle and refundAll do. Pull payments everywhere, with no exceptions.

4. Replace the bare `assert(totalEscrowed == supplierCredit + totalRefunds)` with a named custom error. A failing `assert` raises Panic(0x01) and consumes all remaining gas, which turns a detectable accounting bug into an expensive mystery.

Also confirm two things explicitly in your reply, because I need them for the test matrix:
- that a buyer pays the tier price at the buyer count INCLUDING their own commit, so on the curve above buyer 25 pays $0.75 and buyer 24 pays $1.00;
- that `claimable` accumulates across deals and is never reset per deal.

Then redeploy to Arc testnet (chain 5042002) and report the addresses and the deployment block number for each contract.
