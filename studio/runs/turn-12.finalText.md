Reading all files I need to understand before writing anything. Now read DealRoom.tsx to find "min 1 units" and the goods display, plus CommitFlow for the units display: Good. I now have a complete picture of all the files. Let me plan the exact changes:

**SupplierView changes:**
1. `unitsPerToken` state → `tokensPerUnitStr` (string, allows decimals)
2. Parse with `parseUnits(value, decimals)` — wrap in try/catch to catch invalid precision
3. `tokensPerUnit` derived from parsed value (or `null` if invalid)
4. Validation: reject empty/zero/negative/too many decimals; error message; button disabled
5. "1 unit = X SYMBOL" computed from same parsed value via `formatTokenAmount`
6. Stock deposit line uses same `tokensPerUnit`; all `BigInt(maxUnitsNum) * tokensPerUnit` unchanged
7. Remove `|| 1` fallback from validate — `tokensPerUnit` is pre-validated
8. Duration: `step="any"`, `min` attr as string just above 0; closing-time display
9. No-balance flow: default stock = `min(50, floor(balance / tokensPerUnit))` until first edit; zero-balance vs. over-budget notice split
10. Subtitle copy fix
11. Title/desc counters: "62 left" instead of "0/80 bytes"

**TierProgress:** singular/plural fix on minimum line

**DealRoom:** "min N units" → "minimum N unit(s)"Now writing the updated `SupplierView.tsx` in full: Now fix `TierProgress.tsx` — singular/plural on minimum line: Now fix `DealRoom.tsx` — "min N units" → "minimum N unit(s)": Now run the check: The linter rejects `setState` inside a `useEffect`. The right fix: derive the effective max units during render — don't use state for it at all. Replace the `useEffect` with a derived `effectiveMaxUnits` computed during render: Now remove the `useEffect` that sets `maxUnits` and replace `maxUnitsNum` derivation with an "effective" value that respects the affordable default when unedited: The old `maxUnitsNum` and `stockAmount` vars are now `effectiveMaxUnitsNum` and recomputed. But the old `stockDisplay` still references `tokensPerUnit !== null && maxUnitsNum > 0` — fix that too: Now add `stockDisplay` after `stockAmount` in the balance section, and fix `clearingAtFull` to use `effectiveMaxUnitsNum`: Now fix `clearingAtFull` and `chartMax` — they use `maxUnitsNum` which no longer exists; replace with `effectiveMaxUnitsNum`: Now fix `handleApprove` and `handlePost` which pass `maxUnits` string into `PostInputs` — but `validate()` calls `parseInt(inp.maxUnits)` so it reads from the string field. I need to pass the effective value as the string. The cleanest fix: update `handleApprove` to pass `String(effectiveMaxUnitsNum)` as `maxUnits`: Now also update the revenue-preview line in the render that shows `maxUnits || '?'` — replace with `effectiveMaxUnitsNum || '?'`: Also add `effectiveMaxUnitsNum` to `handleApprove`'s dependency array (it was computed inside the callback but isn't in the deps): Now the stock input still shows `maxUnits` (the raw state string) in its `value`, but when unedited the effective value diverges from it. I need the input to show the effective value when unedited. The cleanest fix: use `effectiveMaxUnitsNum` as the displayed value too: Now run the check: The linter also rejects `ref.current` during render. The correct pattern: use a plain `boolean` state for "has been edited" instead of a ref. A state variable is fine to read during render: Now replace all `stockEditedRef.current` with `stockEdited` and `stockEditedRef.current = false/true` with `setStockEdited(false/true)`: Now fix the two `onSelect` calls that reset `stockEditedRef.current = false` to `setStockEdited(false)`: Now remove the `useRef` import since it's no longer used, and fix the `useEffect` that references `selectedToken` and `refetchBalance` — it still calls `stockEditedRef.current = false`: Now fix the `useEffect` for refetchBalance — it no longer sets `stockEditedRef.current`: Zero warnings, zero errors. Dev server check: **Actual output:**

```
oxlint: Found 0 warnings and 0 errors
tsc --noEmit:  exit 0
```

---

Here is what changed and why:

**`src/swarm/SupplierView.tsx`** — rewritten:

- **Bug fix: `tokensPerUnit` now uses `parseUnits`**. The old `parseInt('0.5') || 1` silently posted 1 EURC per unit when the seller typed 0.5. Replaced with `parseTokenAmount(str, decimals)` which calls viem's `parseUnits` and rejects values with more decimal places than the token has. A red inline error under the field blocks Post until it is valid. "1 unit = X SYMBOL" is computed from the same parsed `bigint` passed to the contract. `stockAmount`, the deposit line, and the approval amount all use the same value.

- **Duration: `step="any"`, `min="0.0001"`**. No more browser "must be ≥ 1" pop-up for sub-hour durations. Closing time shown under the field as plain words: "Closes in 30 minutes", "Closes in 3 days 2 hours".

- **No red banner on page open**. The "You need EURC to sell" notice is shown only when `tokenBalance === 0n` (the wallet has loaded and has nothing). The over-budget case shows a calm amber note directly under the stock field: "Your balance covers up to N units at X EURC each." Post is disabled in both cases but no red top banner fires until the seller has actually done something.

- **Stock defaults to what the seller can afford** (up to 50), derived purely during render using a `stockEdited` state boolean — no `setState` in an effect, no `ref.current` read during render, both of which the linter rejects.

- **Title/desc counters** show "62 left" / "3 over" instead of "62/80 bytes".

- **Subtitle copy** updated.

**`src/swarm/TierProgress.tsx`** — minimum line: "1 more unit needed to reach the minimum of 1 unit" (singular/plural correct for both sides).

**`src/swarm/DealRoom.tsx`** — "min 1 units" → "minimum 1 unit" (singular) / "minimum N units" (plural).