One visual fix in `src/swarm/TierCurveEditor.tsx`; keep the drag/keyboard logic from 16c exactly as it is.

In the running app, tiers at $1.20 / $1.17 / $1.15 draw as an almost flat line squeezed into a thin strip: the y domain appears to start near 0 (or is padded far too much), so a 5-cent spread is a few pixels and the handles overlap the labels.
- Fit the y domain to the data: from (lowest tier price, or the market line if lower) minus 25% of the spread, to (highest price, or market if higher) plus 25% of the spread; if the spread is zero, use ±5% of the price. Recompute only when no drag is in progress (as now).
- Make the chart taller: about 220px on desktop, 180px on phones, with y-axis labels at the top, bottom and each tier price (no overlapping labels; skip any label within 12px of another).
- Draw the step line thicker (2.5px) in the accent colour with the area under it lightly filled, handles 12px with a visible ring when focused or dragged, and the tooltip kept inside the chart bounds.
- Caption above: "Price curve - drag the points to edit" (plain hyphen).

Run the type check and the linter and paste the actual output.
