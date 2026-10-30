Reading both files in full before touching anything. I see the complete picture. Now I'll fix both issues precisely.

**Bug 1:** The `useEffect` deps are `[onChange]` so `onMove`/`onUp`/`onCancel` all close over the `tiers`/`maxUnits`/`marketPricePerUnit` from when `onChange` last changed (i.e., first render). Fix: keep a `tiersRef`, `maxUnitsRef`, `marketRef` updated every render, and read from them inside the handlers. The `onKeyDown` handler is called directly from JSX so it always sees current `tiers` — no issue there.

**Bug 2:** Remove default prices from `defaultTiers()` in SupplierView; add empty-state hint in the chart; add placeholder to price inputs; update validation error message; update right-col preview to show dashes. **Fix 1: TierCurveEditor — live refs for stale closures:** Now replace the `useEffect` body — swap every direct read of `tiers`/`maxUnits`/`marketPricePerUnit` to read from the refs: Now add the empty-state hint in the SVG rendering section: Good. Now fix **SupplierView**: empty default prices, placeholder, validation message, right-col preview dashes. Empty the default prices in `defaultTiers()`: Add a placeholder to the price input in the tier builder: Now update the validation error for empty prices. Find the tier price validation loop in `validate()`: Now update the right-col preview panel to show dashes when no parsed tiers exist. Find the preview panel sections: The right-col preview already gates `parsedTiers.length > 0` on the deposit/revenue section (line 872), so that block simply won't show when there are no prices. The per-tier rates block also gates on `parsedTiers.length > 0` (visible above). The curve shows "Add tiers to see the curve." already. I need to check the curve section and the `stockDisplay` area for dashes: The right-col preview already shows "Add tiers to see the curve." when `chartPoints.length < 2` (which will be the case when prices are empty). And `parsedTiers.length > 0` already gates the per-tier and deposit blocks. The revenue preview section in the form also gates on `parsedTiers.length > 0`. So the right-col naturally shows dashes (nothing) already when prices are blank.

The one remaining thing is the revenue preview section in the **form** (left column) which shows its numbers when `parsedTiers.length > 0`. With no prices, `parsedTiers` is empty, so it collapses. That's correct.

Now run the check: The React Compiler lint rule bans reading/writing `.current` during render. Two separate issues:

1. `tiersRef.current = tiers` (3 lines) — ref sync during render
2. `isDragging.current` read in the render-path domain-refit block and in the JSX cursor expression

The canonical lint-safe pattern for "sync ref during render" is a `useLayoutEffect` with empty deps that runs after every commit. For the domain refit, move it into a `useEffect`. For the cursor, derive it from state instead.

All five errors in one edit: Now fix the two render-time reads of `isDragging.current`: the cursor expression in JSX and the `onBlur` handler. Replace with a derived state boolean `[grabbing, setGrabbing]`: Set `grabbing` true on pointerdown and false on up/cancel: Now replace the two render-time reads of `isDragging.current` in JSX with `grabbing`: ```
oxlint: Found 0 warnings and 0 errors.
tsc --noEmit: exit 0
```

Here is exactly what changed and why:

**Bug 1 — stale closures restoring old prices.**
`tiersRef` / `maxUnitsRef` / `marketRef` are kept current via a `useEffect` with no dep array (runs after every commit). The `onMove`/`onUp`/`onCancel` handlers inside the `useEffect([onChange])` now read from those refs instead of the closed-over props, so they always see the latest tiers regardless of how many renders have happened since `onChange` last changed identity. The old comment had the intent right but the implementation wrong (writing refs during render, which the React Compiler lint rejects). The domain refit on rest was also moved into a `useEffect` for the same reason.

Two read-time accesses of `isDragging.current` in JSX (cursor style, `onBlur`) were replaced with a `grabbing` state boolean that mirrors the ref but is safe to read during render. `setGrabbing(true/false)` is called alongside every `isDragging.current = true/false`.

**Bug 2 — no default prices.**
`defaultTiers()` now returns empty `pricePerUnit: ''` strings for all three tiers. The price input placeholder is `"e.g. 1.12"`. Validation returns `"Set a price for every tier."` when a price field is empty. The TierCurveEditor shows `"Enter prices or press Use market price to start the curve."` centred in the SVG when no tier has a valid price. The right-col preview already gated on `parsedTiers.length > 0`, so it naturally collapses to nothing until prices are entered.