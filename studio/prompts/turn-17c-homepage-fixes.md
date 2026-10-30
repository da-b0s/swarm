Fixes to the Turn 17b homepage, found in the running mainnet build. Edit in place.

1. `home/LiveDealCard.tsx` picks the wrong deal.
- Settled fallback keeps the FIRST settled deal (`!settledBest`), so mainnet shows deal #1 "EURC Test 1" instead of the newest settled deal. Pick the highest-id settled deal.
- "Active" must mean state Open AND deadline still in the future (use the chain clock already there); an Open deal past its deadline is waiting for the keeper, not joinable. Pick the newest such deal.
- The price line renders "$1.20= $1.20 USDC per EURC". When a unit is exactly one token show "$1.20 per EURC"; otherwise "$1.20 per unit · $2.40 per EURC" (reuse PricePerToken). For a settled deal show "Closed at $1.11 per EURC · 60 units".

2. `home/LiveActivity.tsx` never leaves "Loading recent activity…" on mainnet: it only scans the last 2000 blocks (a few minutes on Arc), so with no very recent events it finds nothing and shows the loading text forever.
- Scan from the deployment block (`ARC_NETWORK`/config deploy block, as the Proof page does), chunked the same way the Proof page/`useEventLog` does to respect RPC range limits; prefer reusing `useEventLog` directly if it already provides decoded events.
- Show the newest 6 events. Distinguish states: loading (skeleton rows), loaded-empty ("No activity yet."), error ("Couldn't load activity. View the Proof page."). Never leave loading text on screen after the fetch ends.
- Relative times from block timestamps, not block numbers × an assumed block time, if timestamps are available; otherwise keep the approximation but label it "about".

3. Copy (all homepage components): no em or en dashes anywhere (use a full stop, comma or colon); no "u" abbreviation ("25u → $1.17" becomes "25 units: $1.17"); "25 buyers → 1.17" becomes "25 units sold: 1.17" (tiers count units, not buyers); "in one tx" becomes "in one transaction"; "01 — Post" becomes "1. Post". Keep the tone plain and specific.

4. Hero: when the live card has nothing to show yet (loading), keep its space with a skeleton of the same size so the hero doesn't jump.

Run the type check and the linter and paste the actual output.
