Four fixes from user testing across the deal list, deal room and shared helpers. Edit in place; no contract or address changes. Keep the UI calm.

1. SELLER CAN'T ORDER FROM THEIR OWN DEAL
The contracts allow the supplier to commit; block it in the app. In the deal room, when the connected wallet equals `deal.supplier`, replace the order panel (new order, top-up and the gas-free option) with a short note in the same card: "This is your deal. Buyers' orders appear in the activity below." Keep everything the seller needs: settle/refund when due, claim, share. Withdraw controls are irrelevant (they have no order). Compare addresses case-insensitively.

2. SMALL PRICES SHOW AS $0.00
A deal priced at a fraction of a cent shows "$0.00" everywhere (price hero, tier chips "$0.00 @ 489+", activity "875 units @ $0.00/unit"). `formatUsdcPrice` rounds to 2 decimals; USDC has 6.
- Change the formatter: 2 decimals at $0.01 and above; below that, show up to 6 decimals with 2 significant digits ($0.0004, $0.000012, $0.0035); never "$0.00" for a non-zero value. Keep separators for large numbers ($2,288.23).
- Use it everywhere prices render: deal room hero, tier chips, activity, deal cards, per-token lines, the Sell page preview, the homepage stats where relevant, the proof page.
- The Sell page price inputs must accept up to 6 decimal places.
- On a closed deal the right column shows two cards that say nearly the same thing ("This deal closed successfully …" and "This deal is closed."). Show one: keep the informative one (and its "Finalise it yourself" link and any claim), drop the bare "This deal is closed." card.

3. COPY THAT WORKS
The copy button in ConnectKit's account modal doesn't copy for the user (ConnectKit calls navigator.clipboard.writeText without awaiting or a fallback, and shows a tick regardless; we can't change the library).
- Add `src/swarm/copyText.ts`: `copyText(text): Promise<boolean>` trying `navigator.clipboard.writeText` and falling back to a hidden textarea + `document.execCommand('copy')`.
- Use it for the deal room share/copy button (DealRoom.tsx) with visible feedback: "Copied" or "Couldn't copy, the link is selected" (select the text in that case).
- Give users a working copy of their address: replace the header's `ConnectKitButton` with `ConnectKitButton.Custom` rendering the same chip (avatar + short address, opens the modal on click) plus a small copy icon button beside the address on sm and up, using `copyText`, with a brief "Copied" state. On phones keep the chip only (the header must still fit 375 px).

4. "YOUR DEALS" TAB
In the deal list, next to Active / Ended, add "Your deals", shown only when a wallet is connected. It lists deals where the wallet is the supplier ("Selling") or a buyer ("Joined · N units"), open and closed together, newest first. Cards with anything to collect (USDC refund or payout, or goods) get a "Ready to collect" highlight. Reuse the batched multicall reads already used (getBuyers is read for the homepage stats); no event-log scans. Empty state: "Deals you post or join show up here."

Run the type check and the linter and paste the actual output.
