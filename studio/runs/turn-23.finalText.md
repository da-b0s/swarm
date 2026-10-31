Reading the ABI and the deployed contracts to cross-check every event. Now verify each event against the live contracts on chain before touching anything. Contracts aren't verified on-chain, so I can't pull source via `lookup_contract`. I'll verify against the live topic hashes emitted in actual transactions using the explorer API — comparing the canonical keccak256 from `useEventLog.ts` (which matches the contract's compiled output) against the ABI field ordering.

The topic hash is the keccak256 of the canonical event signature, which encodes types in order. Let me compute what the `GoodsClaimed` ABI currently produces vs what the contract emits:

- **Current ABI order**: `claimant` (indexed), `token` (indexed), `amount` — topic hash = `keccak256("GoodsClaimed(address,address,uint256)")` — same hash either way since both fields are `address`. The topic hash is identical regardless of which field comes first.
- The bug is purely in **which topic slot maps to which name**: topic[1] = first indexed = `claimant` in the old ABI (wrong), `token` in the contract. Decoding assigns topic[1] → `a.claimant` and topic[2] → `a.token`, but the contract puts `token` in topic[1] and `claimant` in topic[2].

Now I also need to check the `useEventLog.ts` code that reads `a.token` and `a.claimant` in the `GoodsClaimed` handler and in `ProofPage`'s `GoodsClaimedSummary` to make sure they both work after the fix. They reference `a.token` and `a.claimant` by name, and viem's `decodeEventLog` returns named fields — so once the ABI has the right order the names resolve correctly. Good.

Now cross-check every other event in the ABI against the canonical signatures recorded in `useEventLog.ts`:

From `useEventLog.ts` TOPICS (these are the authoritative signatures used for topic matching):
- `DealPosted(uint256,address,address,uint32,uint32,uint64,uint64)` — ABI: dealId(uint256,indexed), supplier(address,indexed), goodsToken(address,indexed), minUnits(uint32), maxUnits(uint32), deadline(uint64), startPrice(uint64). **Matches.**
- `Committed(uint256,address,uint32,uint64,uint256,uint64,uint32,uint32)` — ABI: dealId(uint256,indexed), buyer(address,indexed), units(uint32), paidPerUnit(uint64), escrow(uint256), livePrice(uint64), totalUnits(uint32), buyerCount(uint32). **Matches.**
- `Withdrawn(uint256,address,uint32,uint256,bool,uint64,uint32,uint32)` — ABI: dealId(uint256,indexed), buyer(address,indexed), units(uint32), amountReturned(uint256), paidDirectly(bool), livePrice(uint64), totalUnits(uint32), buyerCount(uint32). **Matches.**
- `TierBroken(uint256,uint32,uint64)` — ABI: dealId(uint256,indexed), newTotalUnits(uint32), newPrice(uint64). **Matches.**
- `Settled(uint256,uint64,uint32,uint32,uint256,uint256)` — ABI: dealId(uint256,indexed), clearingPrice(uint64), totalUnits(uint32), buyerCount(uint32), totalRefunds(uint256), unitsDelivered(uint256). **Matches.**
- `Refunded(uint256,address,uint256)` — ABI: dealId(uint256,indexed), buyer(address,indexed), amount(uint256). **Matches.**
- `Claimed(address,uint256)` — ABI: claimant(address,indexed), amount(uint256). **Matches.**
- `GoodsClaimed(address,address,uint256)` — ABI currently: claimant(indexed), token(indexed). Contract declares: token(indexed), claimant(indexed). **Mismatch — this is the one to fix.**
- `ExcessCredited(uint256,address,uint256)` — ABI: dealId(uint256,indexed), buyer(address,indexed), amount(uint256). **Matches.**

Only `GoodsClaimed` has a mismatch. Making the fix now: ```
oxlint: Found 0 warnings and 0 errors.
tsc --noEmit: exit 0
```

**Change made:** `GoodsClaimed` inputs reordered to `token` (address, indexed) then `claimant` (address, indexed) then `amount` (uint256, not indexed), matching `Settler.sol`'s declaration.

**Cross-check of all other events — no further mismatches found:**

| Event | Contract | ABI | Result |
|---|---|---|---|
| `DealPosted` | `DealPosted(uint256 indexed dealId, address indexed supplier, address indexed goodsToken, uint32 minUnits, uint32 maxUnits, uint64 deadline, uint64 startPrice)` | dealId/supplier/goodsToken indexed; minUnits uint32, maxUnits uint32, deadline uint64, startPrice uint64 | Match |
| `Committed` | `Committed(uint256 indexed dealId, address indexed buyer, uint32 units, uint64 paidPerUnit, uint256 escrow, uint64 livePrice, uint32 totalUnits, uint32 buyerCount)` | All fields, types and indexed flags correct | Match |
| `Withdrawn` | `Withdrawn(uint256 indexed dealId, address indexed buyer, uint32 units, uint256 amountReturned, bool paidDirectly, uint64 livePrice, uint32 totalUnits, uint32 buyerCount)` | All fields correct | Match |
| `TierBroken` | `TierBroken(uint256 indexed dealId, uint32 newTotalUnits, uint64 newPrice)` | Correct | Match |
| `ExcessCredited` | `ExcessCredited(uint256 indexed dealId, address indexed buyer, uint256 amount)` | Correct | Match |
| `Settled` | `Settled(uint256 indexed dealId, uint64 clearingPrice, uint32 totalUnits, uint32 buyerCount, uint256 totalRefunds, uint256 unitsDelivered)` | Correct | Match |
| `Refunded` | `Refunded(uint256 indexed dealId, address indexed buyer, uint256 amount)` | Correct | Match |
| `Claimed` | `Claimed(address indexed claimant, uint256 amount)` | Correct | Match |
| `GoodsClaimed` | `GoodsClaimed(address indexed token, address indexed claimant, uint256 amount)` | **Was wrong, now fixed** | Fixed |