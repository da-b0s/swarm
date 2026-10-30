Reading the current file in full before touching anything. Now I understand both bugs precisely. I'll rewrite the component in place with two targeted fixes:

**Bug 1 (arrow keys):** `priceStep` is 1_000 or 10_000 micro, but `snapPrice` rounds to the nearest 10_000 (cent) when ≥$1, undoing the 1_000 step. Fix: the step IS the snap unit — 10_000 normally, 100_000 with Shift, or 100/1_000 when under $1. Apply the step directly, then snap (which is now a no-op since the step is already on a snap boundary).

**Bug 2 (drag direction/jump):** The `fromY`/`fromX` closures are stale or recomputed mid-drag because `priceMax`/`priceMin` change as tiers change. Fix: on `pointerdown`, freeze the scale (record `priceMax`, `priceMin`, `chartMaxUnits`, `h`, `w`, `PAD_*` constants) as scalars into `dragRef`. On each `pointermove`, compute delta from the frozen scale, not from `fromY`/`fromX` (which re-derive from the ever-changing domain). Refit domain only on drag end.

I also need to hold a stable "frozen domain" that only updates when no drag is in progress: Zero warnings, zero errors. Here is exactly what changed and why:

**Bug 1 — Arrow keys (snap undoes step).**
`priceStep()` now returns the snap quantum itself: `10_000` micro (1 cent) normally, `100_000` (10 cents) with Shift when the price is ≥$1; `100` micro (0.0001) / `1_000` with Shift when the price is under $1. Because the step equals the quantum, `snapPrice(value ± step)` is an identity — it rounds to a boundary that's already on a boundary, so the value actually moves. Arrow up raises price, arrow down lowers it. Neighbour clamping uses the same `minGap` quantum.

**Bug 2 — Drag direction / jumps (stale domain feeds back).**
The root cause was that `fromY` (and `fromX`) closed over `priceMax`/`priceMin` which changed on every `onChange` call (because tiers changed → domain changed → `toY`/`fromY` got new values → next `pointermove` used a different scale). This caused direction inversions and jumps.

The fix has three parts:
1. `isDragging.current` flag gates domain updates. While dragging, `computeDomain` runs but `setDomain` is skipped, so the coordinate transforms stay frozen at what they were on `pointerdown`.
2. On `pointerdown`, a snapshot of the current domain and SVG width (`frozenDom`, `frozenW`) is stored in `dragRef`. All `pointermove` calculations use `microPerPx(frozenDom)` and `unitsPerPx(frozenDom, frozenW)` — pure functions of the frozen snapshot, never of React state.
3. `toX`/`toY` are now plain functions that take a `Domain` argument rather than closures capturing state, so there is no stale-closure risk.

The `pointermove` listener is registered once (deps: `[onChange]` only), which also avoids the old issue of the handler being re-registered on every render with a new `fromY` closure.