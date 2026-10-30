Two Sell-page fixes from user testing on a phone. Edit in place.

1. DRAGGING RESTORES OLD PRICES — real bug in `TierCurveEditor.tsx`
User report: after dragging tier 2, dragging tier 1 snaps tier 2 back to where it was; after pressing "Use market price", touching any handle resets all tiers to the old defaults (about $1).
Cause: the window `pointermove`/`pointerup` listeners are registered in a `useEffect` whose deps are only `[onChange]`, so the handlers close over the `tiers` array from the first render. Every move builds `next` from that stale array and calls `onChange(next)`, overwriting every other tier and anything set by typing or by "Use market price". `onUp`/`onCancel` also refit the domain from stale tiers, and `maxUnits`/`marketPricePerUnit` are stale the same way.
Fix: keep the latest `tiers`, `maxUnits` and `marketPricePerUnit` in refs updated on every render (or read them through a ref-held callback), and build `next` from the latest tiers on each move — changing only the dragged tier. Same for the keyboard handler if it has the same problem. After the fix, this sequence must hold: Use market price → drag tier 3 down → drag tier 1 up → all three tiers keep their latest values; typing a price then dragging another tier keeps the typed price.

2. NO DEFAULT PRICES
Sellers should choose their own prices. Start the Sell form with empty price fields (keep the default "from N units" values 1 / 25 / 50 and the other defaults). Empty prices show a placeholder ("e.g. 1.12") and the existing validation keeps Post disabled with "Set a price for every tier". The curve editor draws only tiers that have a price; with no prices it shows a short hint in the chart area: "Enter prices or press Use market price to start the curve." The live preview on the right shows dashes until prices exist.

Run the type check and the linter and paste the actual output.
