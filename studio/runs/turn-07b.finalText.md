Reading the spec section and the patch first. Good. Now read all the current source files I'll be modifying, before touching anything: Now read the swarm source files and the relayer: Good. Now read the relayer and the swarm config to understand the current state before the patch: Good. Now I have everything. The patch makes significant changes across many files. I need to apply it first with `git apply`, then build on top of it for the top-up UI changes. Patch applied cleanly. Now read the patched files to understand the exact state before building on top: Good. I have the complete post-patch state. Now I'll implement all the top-up changes in one coordinated pass. The key insight: both `CommitFlow` and `GaslessCommitFlow` need to receive `myUnitsN` (already ordered) so they can compute `maxAddable` (per-buyer headroom minus already-owned units). I need to pass this down from the parent or read it inside each flow. Since both already read `useUnitsOf` in `CommitFlow` (and `GaslessCommitFlow` doesn't), the cleanest path is to add `currentUnits` to the `GaslessCommitFlow` Props and pass it from `CommitFlow`'s existing read.

Now making all the changes: Now update `GaslessCommitFlow` — add `currentUnits` prop, compute `maxAddable` correctly, relabel for top-ups, remove `AlreadyCommitted` from messages: Now update `useDealHistory` to sum lots per buyer instead of replacing entries: The `DealHistoryEntry` type needs new fields: `totalEscrow` (sum of lot escrows) and keep `paidPerUnit` as the average. I also need `escrow` in `ParsedEntry` and `CommittedArgs`. Let me update `useDealHistory.ts`: Now check if `DealRoom.tsx` uses `DealHistoryEntry.paidPerUnit` in any way that would break with the new average semantics — it should still display correctly since `paidPerUnit` is now the average. Let me quickly check the activity list render: Good — `DealRoom` shows `paidPerUnit` as price-per-unit in the activity list. With the new semantics it's the average price, which is correct for display. Now run check: Apostrophe in a JSX string literal. Fix it: Frontend clean. Now typecheck the relayer: Confirm dev server is up: **Actual output:**

```
oxlint: Found 0 warnings and 0 errors  (frontend)
tsc --noEmit: exit 0                   (frontend)
relayer bunx tsc --noEmit: exit 0      (relayer)
```

---

Here is exactly what the patch applied and what was built on top:

**Patch applied (`git apply`)** — all changes exactly as written:
- `useLateWalletReconnect.ts` (new): reconnect with per-request timeouts, retries, EIP-6963 listener
- `FundingNotice.tsx` (new): `useUsdcBalance` hook + `FundingNotice` component
- `src/main.tsx`: `reconnectOnMount={false}`, console-capture only in iframe
- `src/config.ts`: batched HTTP transport (`batch: { wait: 50 }`)
- `src/swarm/config.ts`: v2 contract addresses + deploy block + `ARC_TX_FEES`
- `src/App.tsx`: `useLateWalletReconnect()` call
- `src/tracing.ts`: `IN_STUDIO_FRAME` guard on both patching blocks
- `CommitFlow.tsx`, `GaslessCommitFlow.tsx`, `DealRoom.tsx`, `SupplierView.tsx`: `ARC_TX_FEES` on every `writeContract`, `FundingNotice` import, stall/revert detection in `SupplierView`

**Top-up changes built on top:**

**`CommitFlow.tsx`:**
- `perBuyerHeadroom` = `maxUnitsPerBuyer − myUnitsN` (per-buyer remaining, not total limit); `maxAddable` = min of that and `remainingStock`
- When `isCommitted`: order summary card always shown (total units, total escrowed, average price, refund as `escrowed − cp × units`); a separate "Add to your order" picker card shown below it when `maxAddable > 0`; "at the limit" notice when `maxAddable === 0`
- Order/add button labelled "Add N units for $X" with `PackagePlus` icon when topping up; funding notice and at-limit notice both thread through the same `!cannotAfford`/`atLimit` guards
- "Withdraw entire order" (relabelled from "Withdraw order") unchanged in logic
- Passes `currentUnits={myUnitsN}` down to `GaslessCommitFlow`

**`GaslessCommitFlow.tsx`:**
- New `currentUnits` prop; `isTopUp = currentUnits > 0`
- `perBuyerHeadroom` same formula; `maxOrderable` respects the headroom
- `atLimit` state: shows a plain notice instead of the picker when `isTopUp && maxOrderable === 0`
- Price card header, picker label, button label, and success message all vary by `isTopUp`
- 409 message says "this lot" instead of "order" when topping up
- `AlreadyCommitted` removed from `RELAYER_MESSAGES` — ordering again is a valid top-up and the relayer will never return that code for a second order

**`useDealHistory.ts`:**
- `DealHistoryEntry` gains `totalEscrow: bigint` (sum across lots)
- `paidPerUnit` now means average price: `totalEscrow ÷ units` (for a single-lot buyer it is unchanged)
- `buildEntries` accumulates `accUnits` and `accEscrow` per buyer across all `Committed` lots; a `Withdrawn` deletes both accumulators and marks the entry withdrawn
- Activity list in `DealRoom` (which displays `entry.paidPerUnit`) naturally shows the average price — no `DealRoom` changes needed