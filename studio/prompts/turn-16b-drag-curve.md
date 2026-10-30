One Sell-page feature: edit the price curve by dragging. Put it in a new component `TierCurveEditor.tsx` and use it in place of the current static price-curve chart in the Sell page form (the live preview on the right can keep the static chart). Edit SupplierView in place only to wire it up.

Behaviour:
- Same step chart as now (x = units, y = price per unit), drawn in SVG, sized to its container, readable in light and dark themes.
- Each tier is a handle (a dot at the start of its step, at least 24px hit area). Dragging a handle up/down changes that tier's price; dragging left/right changes its "from N units" (whole numbers). The first tier's units stay fixed at 1.
- Constraints while dragging, enforced live (clamp, don't reject): prices strictly decrease left to right and units strictly increase, with at least one cent (or the smallest step used for that deal's price precision) between neighbours; price > 0; units ≤ the stock. Snap prices to the cent (to 4 dp when the unit price is under $1).
- While dragging show a small label at the handle: "25+ units · 1.17 USDC (1.17 per EURC)", using the same per-token helper as elsewhere.
- If a market rate is available, draw a dashed horizontal line at the market price per unit, labelled "Market".
- The tier number inputs and the chart are the same state: typing updates the chart, dragging updates the inputs. "Use market price", "Add tier" and delete keep working.
- Works with touch (pointer events, touch-action none on the handles) and with the keyboard: handles are focusable; arrow up/down change price by one step, left/right change units by one, shift for ×10.
- Accessible names on handles: "Tier 2: from 25 units at 1.17 USDC".

Run the type check and the linter and paste the actual output.
