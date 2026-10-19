Build "Swarm" on Arc: pooled demand with volume-tiered pricing, using USDC via the ERC-20 interface at 0x3600000000000000000000000000000000000000 (6 decimals). All maths in 6-decimal units; never use msg.value.

DealFactory.postDeal(tiers[], minBuyers, deadline, cap) where each tier is (minBuyers, pricePerUnit). Cap unit price at 5 USDC and buyers at 100 for v1. Validate the curve on entry: tiers[].minBuyers strictly ascending, tiers[].pricePerUnit strictly descending, at least one tier, tiers[0].minBuyers <= minBuyers, and deadline strictly in the future. Revert with named errors, not require strings.

DemandPool.commit(dealId) escrows the CURRENT tier price for the caller, one commit per address, and recomputes the live price. withdraw(dealId) before the deadline returns the commit and recomputes - a tier must be able to un-break. Removing a buyer from the middle of the buyer array must not corrupt the array or leave a stale index.

clearingPrice(dealId) returns the lowest tier price unlocked by the current buyer count.

Settler.settle(dealId) at the deadline, when committed >= minBuyers: compute the clearing price, credit each buyer the difference between what they paid and the clearing price, credit the supplier clearing * buyerCount, all in ONE transaction. Use a claimable mapping and pull payments - never transfer directly, because Arc reverts transfers to blocklisted addresses and one bad address must not freeze the deal. refundAll(dealId) when the minimum was not met returns every commit in full.

Assert conservation: supplier credit plus all refunds must equal the sum of all commits, exactly, with no stranded dust at 6 decimals.

claimable is keyed by address and accumulates across deals; claim() pulls the caller's whole balance in one transfer.

Deal state machine: Open -> Settled or Open -> Refunded, nothing else. settle and refundAll are each callable once and are mutually exclusive.

ReentrancyGuard on everything that moves USDC. Owner pause() halting postDeal and commit but never settle, refundAll or claim. block.timestamp for deadlines only, never ordering. Do not use block.prevrandao - Arc always returns 0 for it.

Emit DealPosted, Committed (with the new live price), Withdrawn, TierBroken, Settled (with clearing price and buyer count), Refunded, Claimed. Every event must carry dealId as an indexed parameter so a frontend can filter by deal.

Deploy to Arc testnet (chain 5042002) and report the addresses.
