Two bugs in `src/swarm/TierCurveEditor.tsx` found by testing in the running app. Fix in place; don't change anything else.

1. Arrow keys do nothing to the price. `onKeyDown` steps the price by $0.001 (1_000 micro-USDC) and then `snapPrice` rounds to the cent, so the value rounds straight back. Make the step equal to the snap step: one cent normally (10_000), ten cents with Shift (100_000); when the price is under $1 and you snap to 4 dp, use 0.0001 / 0.001. Arrow up must raise the price, arrow down lower it, within the neighbour limits.

2. Mouse/touch dragging goes the wrong way and jumps. Measured: with tier 3 at $1.15, dragging its handle 80px down gave $1.16 (up), and then dragging 40px up gave $0.98 and the handle moved down. The y scale is almost certainly recomputed from the tiers on every move (the domain changes as the price changes), feeding back into the next move.
- Freeze the scale for the whole drag: on pointerdown record the y domain (min/max price) and the starting pointer position and starting price; on each move compute price = startPrice + (startY - currentY) × (domain per pixel from the frozen scale). Up = higher price, always.
- Use `setPointerCapture` on pointerdown and release on pointerup/pointercancel, so moving fast or leaving the handle keeps dragging.
- Re-fit the domain only when the drag ends (with some headroom above the top price and below the lowest, and including the market line if shown), so handles don't sit on the chart edges.
- Same frozen-scale approach for horizontal dragging of units.

Run the type check and the linter and paste the actual output.
