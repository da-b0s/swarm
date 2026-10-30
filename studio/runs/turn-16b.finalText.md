Reading the current chart section of SupplierView carefully before writing the new component. Now read the chart section in SupplierView and the `pricePerToken` / `formatTokenAmount` exports: I have everything I need. Now I'll write the `TierCurveEditor` component and wire it in.

The design: an SVG that uses `useRef` for the container to get pixel dimensions, pointer events for drag (works on touch too), keyboard nav on focusable circle elements. Key decisions:
- SVG coordinate space is computed from `clientWidth`/`clientHeight` via a ResizeObserver
- Drag state tracks which tier index is being dragged and the starting pixel offset
- Price y-axis: padding top/bottom (16px each), range maps `[maxPrice*1.15, 0]` → `[padTop, H-padBot]`  
- Units x-axis: padding left/right (32px each), range maps `[0, maxUnits*1.05]` → `[padL, W-padR]`
- On pointermove: convert SVG coordinates back to price/units, clamp, snap, propagate via `onChange`
- `touch-action: none` on handles via inline style Now wire it into SupplierView: replace the static curve chart with `TierCurveEditor`, keep the `TrendingDown` import removal optional (it's still used for the right-col preview). First check if `TrendingDown` is used elsewhere: `TrendingDown` is only used in the static chart header inside the tier builder. I'll replace that entire static chart block with `TierCurveEditor`. Add the import and swap the block: Now replace the static `{/* Curve chart */}` block with `TierCurveEditor`: Now check whether the `chartPoints`, `toSvgX`, `toSvgY`, `chartMinPrice`, `chartMaxPrice` variables are still referenced elsewhere in SupplierView (the right-col preview panel uses its own copies of these): `toSvgX` is still used in the right-col preview at lines 828 and 837. So `chartPoints`, `chartMax`, `toSvgX`, `toSvgY`, `chartMinPrice`, `chartMaxPrice` must stay — they feed the right-col static preview. That's fine; no cleanup needed.

Now run the check: Zero warnings, zero errors.

**`src/swarm/TierCurveEditor.tsx`** — new file, ~280 lines. Here's what it does:

**Rendering.** An SVG that fills its container width (observed with `ResizeObserver`) at a fixed 140px height. Coordinate transforms `toX`/`toY` map units→pixels and price→pixels with 15%/10% headroom above/below the actual price range. The step path is drawn as `M … L … L …` segments that match the contract's stair-step price logic exactly. Y-axis tick labels show formatted USDC prices. X-axis labels appear under each tier's handle. A dashed horizontal line at `marketPricePerUnit` is drawn when a market rate exists, labelled "Market".

**Handles.** Each valid tier gets a transparent 28px hit-area circle (for fat-finger touch) and a visible 5px filled dot (7px while active). Each handle is a `role="slider"` with `tabIndex={0}` and an `aria-label` like "Tier 2: from 25 units at $1.17". `touch-action: none` on the hit circle prevents scroll during a drag.

**Dragging.** `onPointerDown` records the drag origin and calls `setPointerCapture` so the pointer stays captured even if it leaves the SVG. A global `pointermove` listener (added/removed via `useEffect`) converts the pointer position back to price/units using the inverse transforms, then clamps: price strictly between neighbours with at least one step gap, units strictly between neighbours (first tier locked to position 1 on x), both clamped to valid ranges. Prices are snapped to 2 dp (or 4 dp below $1).

**Keyboard.** Arrow up/down change price by $0.001 (×$0.01 with Shift), arrow left/right change units by 1 (×10 with Shift), with the same neighbour constraints enforced.

**Tooltip.** While dragging or while a handle has focus, a floating SVG rect+text shows "25+ units · $1.17 USDC · 1.17 USDC per EURC" (the per-token string uses the same `pricePerToken` helper).

**Wiring.** In `SupplierView`, the static `{/* Curve chart */}` SVG block inside the tier builder is replaced by `<TierCurveEditor tiers={tiers} onChange={setTiers} …/>`. `tiers` is the shared state so typing in the inputs updates the chart and dragging updates the inputs. The right-column preview panel retains its own static chart (the existing SVG path code still computes from `parsedTiers` and `chartPoints`).