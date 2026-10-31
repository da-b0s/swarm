Reading both files first. Good. Now I have the full picture. Four independent changes:

1. **Auto-adjust tier thresholds** with `tiersEditedRef`, spread across stock, inline over-stock errors, smart "Add tier"
2. **Token amount under each threshold** (= N × tokensPerUnit, formatted)
3. **"Set to market" moves under the price field** (restructure the helper row into two separate rows)
4. **Header sync** in App.tsx Starting with the state/logic changes, then the render changes.

**Step 1 — state and logic: `tiersEditedRef`, `autoDefaultTiers`, `addTier`, over-stock validation.** Now add the auto-threshold effect right after the `mRateForEffect` effect: `effectiveMaxUnitsNum` is derived during render, not stored in state, so the effect dep won't fire reactively on its own when balance changes. I need to trigger it via a state dep. Let me use `effectiveMaxUnitsNum` via a `useMemo`-derived state equivalent — the simplest fix is to keep a `prevStockRef` inside the effect and put `effectiveMaxUnitsNum` in the dep array directly. That's what I already did, but React won't re-run effects for non-state/non-prop values unless they change between renders. Since `effectiveMaxUnitsNum` IS re-computed every render, any change in `tokenBalance`, `tokensPerUnit`, or `maxUnits` triggers a render which changes this value and re-fires the effect. This is correct — leave it.

Now mark `tiersEditedRef.current = true` when the seller edits a threshold, and reset it when token changes. Also update `addTier` with the smart proposal logic: Also reset `tiersEditedRef` when the token changes (alongside `tpuEditedRef`): Also add `"Add tier" disabled when last threshold is at stock` — instead of hiding the button, disable it with a tooltip-like title and show the message in the button area. The spec says show a message instead of adding. I'll keep the button but change its label and disable it when `lastTierAtStock`: Now the **per-tier render loop** — add inline over-stock error under the threshold input, add token amount line under threshold, and move "Set to market" under the price input: Also add `overStock` to the Approve button's disabled guard so Post stays blocked: Now **Step 4 — header sync in App.tsx**: Now run the check: The auto-threshold effect fires before `effectiveMaxUnitsNum` is declared (it's derived inline after the effect). Move the effect to after `effectiveMaxUnitsNum` is declared: Now place it after `effectiveMaxUnitsNum` is computed (after the balance checks section): ```
oxlint: Found 0 warnings and 0 errors.
tsc --noEmit: exit 0
``` Here is what changed.

**Tier thresholds follow the stock (SupplierView.tsx):**
- Added `tiersEditedRef` (a `useRef<boolean>(false)`). A `useEffect` keyed on `effectiveMaxUnitsNum` fires whenever the stock changes. While `tiersEditedRef.current` is false it rebuilds the `minUnits` fields: 1 tier gets `[1]`; 2 tiers get `[1, stock]`; 3 tiers get `[1, ceil(stock/2), stock]`. Duplicates are deduplicated so stock=1 collapses to one usable tier, stock=2 with 3 tiers gives `[1, 2]`.
- `updateTier` sets `tiersEditedRef.current = true` whenever the `minUnits` field is changed. `removeTier` and `addTier` also set it.
- Selecting a new token resets `tiersEditedRef.current = false` alongside the existing `tpuEditedRef` reset.

**Inline over-stock error:** Each tier row computes `overStock = tierMinNum > effectiveMaxUnitsNum`. When true the threshold input gets a red border and the message "Starts at N units but stock is M. Lower it or raise the stock." appears underneath. The Approve button's `disabled` condition is also extended to block while any tier has an over-stock threshold.

**Smart "Add tier":** `addTier` now proposes `ceil((lastMin + stock) / 2)` as the new threshold. When the last threshold is already at or above the stock, `addTier` is disabled and the button label changes to "Raise stock to add tier" with a `title` tooltip.

**Token amount under each threshold (item 2):** When `isMultiUnit` and the threshold is valid and not over-stock, a helper line "= 0.00125 cirBTC" appears under the threshold input (`threshold × tokensPerUnit` formatted with token decimals). Hidden when 1 unit = 1 whole token (single-unit mode).

**"Set to market" under the price field (item 3):** The tier row grid is now `items-start` with each column a `flex flex-col`. The threshold column holds the input plus its error/token-amount note. The price column holds the input plus a helper row containing the per-unit equivalent, deviation badge, and "Set to market" button — all under the price input, not under the units input.

**Header sync (App.tsx):** Header row is `gap-2 sm:gap-3`. "Swarm" wordmark span is `hidden sm:inline`. Tab container is `flex gap-0 sm:gap-1 ml-0 sm:ml-4`. Each tab button is `px-1.5 sm:px-3`. Theme toggle button is `hidden sm:flex`.