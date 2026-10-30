Homepage redesign so it presents Swarm better. Original design: don't imitate any other site. Keep the existing stats band, theme and data hooks; put new sections in new component files under `src/swarm/home/` and compose them in `HomePage.tsx`. Use existing hooks for data; no new RPC-heavy polling (reuse POLL_LIST etc.).

1. HERO WITH THE PRODUCT IN IT
- A small pill above the headline: "Live on Arc mainnet" with a pulsing dot.
- Left: headline "Buy together. Pay less.", subtitle, buttons (as now).
- Right (desktop; below on phones): a live deal card for the most recent active deal: title, token, current price and per-token price, the tier ladder with the current tier highlighted, units sold vs next tier, time left, and a "Join this deal" button that opens it. If no deal is active, show the most recently settled deal labelled "Last deal" with its final price and units, and a "Post a deal" button.

2. STATS BAND — keep as is, directly under the hero.

3. "WATCH THE PRICE FALL" — an explainer animation
A self-contained SVG/CSS animation (respects prefers-reduced-motion: then show the end state) of one deal filling: buyer dots join one by one, a units counter rises, the price steps down at each tier ($1.20 → $1.17 → $1.15), and at the end every dot gets the same final price and a small "refund" tick for the early joiners. Caption: "Early buyers aren't punished. When the deal closes, everyone pays the final price and the difference comes back." A "Replay" text button.

4. "HOW A DEAL MOVES" — four steps in a row (stacked on phones), each with a concrete example value in large type: Post ("50 EURC deposited"), Join ("1.20 USDC per unit, held in the contract"), Price drops ("25 buyers → 1.17"), Close ("everyone pays 1.15, refunds and EURC in one transaction"). No icons; numbers and type do the work.

5. WHY ARC — three short columns: "Pay in USDC, no gas token" (gas is USDC), "One signature to join" (gasless orders through the relayer, with a live count of gasless orders from the existing event data if it is already available; otherwise omit the number), "Settles itself" (the keeper closes deals; nobody has to press a button).

6. LIVE ACTIVITY — the latest 6 on-chain events (orders, settlements, claims) from the existing event log hook, each with relative time and a link to the explorer; "View all on the Proof page" link.

7. CLOSING CALL TO ACTION — a full-width band: "Bring the stock. Or bring your friends." with "Post a deal" and "Browse deals" buttons. Footer with links: Proof, GitHub (https://github.com/da-b0s/swarm), Arc Studio, explorer link to the DealFactory contract.

8. THEME SWITCH: replace the single sun/moon toggle with a compact three-way control: Light / System / Dark (System follows prefers-color-scheme and is the default).

Keep it fast: no layout shift, nothing scrolls sideways at 375px, images none (SVG only). Run the type check and the linter and paste the actual output.
