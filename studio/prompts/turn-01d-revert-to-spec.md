Reverting the escrow model to the original specification. I had you change `commit()` to pull a uniform top-tier collateral; that was the wrong call. The spec's commit-time escrow can be made solvent with a much smaller change, and I want the spec's wording back. Describing the target state rather than a diff, because several turns have touched these files.

ESCROW — back to the specification

`commit(dealId)` pulls `clearingPrice(dealId)` evaluated at the buyer count INCLUDING the caller's own commit, exactly as before the collateral change. Store it per buyer: `escrowed[dealId][buyer]`. On the curve (10 @ $1.00, 25 @ $0.75, 50 @ $0.50) buyer 24 escrows $1.00 and buyer 25 escrows $0.75.

`settle(dealId)` computes `cp = clearingPrice(dealId)` and, for each buyer, credits `escrowed[dealId][buyer] - cp` to claimable. Refunds are therefore tiered, not uniform. The supplier is credited exactly `cp * buyerCount` — this formula is non-negotiable, it is what the spec writes out as code.

`refundAll(dealId)` credits each buyer their own `escrowed[dealId][buyer]`, not a shared amount.

Drop the whole collateral apparatus added in the last two turns: `collateral[dealId]`, `DemandPool.initCollateral()`, the factory-only guard around it, `CollateralAlreadySet` and `CollateralNotInitialized`. `postDeal` no longer calls into `DemandPool` at all, so the factory goes back to having no dependency on the pool.

THE WITHDRAWAL PRECONDITION — the one addition

A withdrawal must be refused when it would leave a remaining buyer unable to pay the resulting clearing price. Without this, any tier un-break strands the newest buyer: at 25 buyers the 25th escrowed $0.75, so one exit drops the count to 24, the clearing price returns to $1.00, and `escrowed - cp` underflows. `settle()` then reverts forever while `refundAll()` also reverts for being above the minimum — every participant's funds locked.

So in `withdraw(dealId)`, after determining the caller is committed and before mutating anything, compute `newPrice = clearingPrice` at `buyerCount - 1` and the lowest amount escrowed by any OTHER remaining buyer. If that lowest amount is below `newPrice`, revert with a named error such as `WouldStrandBuyer`. Otherwise proceed.

Do NOT compute the minimum by looping over the buyer array — that is O(n) on every withdrawal and a griefing vector at 100 buyers. Instead keep a per-deal tally of how many buyers are escrowed at each tier price: `mapping(uint256 => mapping(uint64 => uint32)) tierCount`. Increment on commit, decrement on withdraw. The lowest escrowed price among remaining buyers is then found by scanning the deal's tiers from the cheapest upward for the first with a non-zero count, which is bounded by the number of tiers rather than the number of buyers.

Correctness properties I will be asserting, so please verify them yourself:

- The precondition binds only when the buyer count sits exactly on a tier threshold. At 24, 26, 30 and 51 buyers on the curve above, the earliest buyer can always exit; at exactly 25 and exactly 50 the exit is refused. One further commit clears the refusal.
- The spec's own test 6 still passes: with 25 buyers, the 25th (who escrowed $0.75) withdraws successfully, the tier un-breaks to $1.00, and a new commit re-breaks it to $0.75.
- No buyer can ever be stranded, so `escrowed - cp` cannot underflow.
- There is no state in which a deal past its deadline has both `settle()` and `refundAll()` reverting.
- Conservation stays exact: supplier credit plus all refunds equals the sum of all commits, to the wei.

EVENTS

Keep the enriched payloads, with the collateral field replaced by the actual per-buyer amounts:

- `DealPosted(uint256 indexed dealId, address indexed supplier, uint32 minBuyers, uint64 deadline, uint64 startPrice)` where `startPrice` is `tiers[0].pricePerUnit`
- `Committed(uint256 indexed dealId, address indexed buyer, uint64 pricePaid, uint64 livePrice, uint32 buyerCount)`
- `Withdrawn(uint256 indexed dealId, address indexed buyer, uint64 amountReturned, uint64 livePrice, uint32 buyerCount)`
- `Refunded(uint256 indexed dealId, address indexed buyer, uint256 amount)` — once per buyer inside `refundAll`
- `Settled(uint256 indexed dealId, uint64 clearingPrice, uint32 buyerCount, uint256 totalRefunds)`
- `TierBroken(uint256 indexed dealId, uint32 newBuyerCount, uint64 newPrice)` — emitted from both `commit` and `withdraw` whenever the live price moves

KEEP everything else from the last two turns: the `SettlerNotConfigured` guards, `minBuyers >= 1`, a non-zero price on every tier, `minBuyers <= cap`, the `ConservationViolation` named error instead of a bare `assert`, withdrawals crediting claimable rather than pushing USDC, and the corrected per-file comment blocks.

Then deploy all four contracts to Arc testnet (chain 5042002) and wire them: `DealFactory.setDemandPool`, `DealFactory.setSettler`, `DemandPool.setSettler`. Report each contract's address and deployment block number, and confirm the three wiring calls landed.

Last turn the wiring did not get done — you reported the testnet RPC timing out and left the three calls to me — so the deployment was unusable. If the RPC times out again, retry rather than handing back calldata, and tell me explicitly in your reply whether `DealFactory.demandPool`, `DealFactory.settler` and `DemandPool.settlerSet` are set, read back from chain. Deploy once, not twice: the previous turn produced two full sets of contracts.

Yes to the security review — run it after the changes and before the deploy, and report what it finds.
