Three fixes. Frontend only; no contract or address changes. Edit in place.

0. SYNC A HAND FIX (made after Turn 21b)
In `src/swarm/CommitFlow.tsx`, the guard you changed to `if (!isOpen || isPastDeadline) return null` also removed the status for everyone viewing a finished deal. It is now:
```
  // Past the deadline but not yet finalised: DealRoom's SettleOrRefundPanel
  // already explains it, so don't add a second "closed" card.
  if (state === 0 && isPastDeadline) return null
  if (!isOpen || isPastDeadline) {
    return (
      <div className="rounded-2xl p-4 text-center text-sm"
        style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
        {state === 1 ? 'This deal has settled.' : 'This deal has been refunded.'}
      </div>
    )
  }
```
Make your copy identical.

1. "READY TO COLLECT" ONLY WHEN SOMETHING IS WAITING
In `DealList.tsx` the "Your deals" highlight is `deal.state === 1 || deal.state === 2`, so every finished deal shows "Ready to collect" even after the user has claimed. The Settler keeps per-wallet totals: `claimable(wallet)` (USDC) and `goodsClaimable(token, wallet)`. Read `claimable(me)` once and `goodsClaimable(token, me)` for each distinct goods token among the user's deals, in one batched multicall, and highlight when:
- buyer, settled: goodsClaimable[token] > 0 or claimable > 0
- buyer, refunded: claimable > 0
- seller, settled: claimable > 0 or goodsClaimable[token] > 0 (unsold stock)
- seller, refunded: goodsClaimable[token] > 0
Refetch after a claim (same query invalidation the claim banner uses). Once everything is collected, nothing is highlighted.

2. PROOF PAGE: LOAD HISTORY FROM THE EXPLORER
Measured on 31 October: the contracts were deployed at block 28,005,197 and the head is about 28,812,000, so about 807,000 blocks. `rpc.mainnet.arc.io` and QuickNode reject eth_getLogs ranges over 5,000 blocks, dRPC over 10,000, and Blockdaemon has pruned old history. `useEventLog` therefore makes about 162 sequential calls plus rate-limit waits (1 to 2 minutes), growing by about 35 calls a day.
Arc's Blockscout explorer API serves the full history and answers cross-origin from the site:
`GET https://explorer.arc.io/api/v2/addresses/{contract}/logs`, 50 items per page; follow `next_page_params` (pass its fields as query parameters) until it is null. Item fields used: `topics` (array padded with `null`: drop the nulls), `data`, `block_number`, `block_timestamp`, `transaction_hash`, `index`. Measured: Settler 37 logs and DemandPool 24 logs, one request each, about 1.3 s.
- In `useEventLog`, first fetch all three contracts' logs (DealFactory, DemandPool, Settler) from the explorer in parallel, map each item to the existing `RawLog` shape and decode with the existing `decodeLog`; keep `block_timestamp` and use it for real event times on the Proof page.
- Then scan the RPC only from (highest block seen from the explorer + 1) to the head for anything not yet indexed, with the existing windowed scanner.
- If any explorer request fails or returns malformed data, fall back to today's full RPC scan, unchanged.
- De-duplicate by (transaction_hash, index). Show progress text "Loading history…" while the explorer requests run.

Run the type check and the linter and paste the actual output.
