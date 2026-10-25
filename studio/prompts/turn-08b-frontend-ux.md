Frontend changes from a hands-on test with a real user. The contracts now have partial withdrawals paid out immediately (spec: "v2.2" in `context/mechanism-v2.md`). Do not change any address in `src/swarm/config.ts`, and do not touch the contracts. Keep every existing safeguard: the reconnect logic, `ARC_TX_FEES` on every transaction, the funding notice, the gasless signing fallback, chain time for deadlines.

1. ONE ORDER PANEL, NOT TWO

Today the gasless panel and the approve-then-commit panel are separate, and after a gasless order the add-more and withdraw controls are only reachable through a faint "Use approve-then-commit instead" link. A first-time user does not find it. Make it one panel:
- The buyer's order summary (units, escrow, average price, refund waiting), the quantity picker for adding more, and the withdraw controls are always shown to a buyer who has an order, whichever way they paid.
- The order button defaults to gasless. Directly beneath it, a clearly visible secondary option: "Pay the gas yourself instead (two confirmations)". It is a real choice, styled as a link-button that is easy to see, not faint text.
- After a successful order, show the confirmation briefly and return to the same panel with the updated summary — not a dead end.

2. PARTIAL WITHDRAWAL

- `withdraw(dealId, units)` now takes a quantity. Add a quantity picker for withdrawing, from 1 to the units held, defaulting to all, and show exactly how much USDC comes back: `escrowed × units ÷ unitsOf`, rounded down, as the contract computes.
- The withdraw pre-check mirrors the contract: refuse when the live price after removing `units` would exceed the `paidPerUnit` of any buyer still in the deal — including the buyer themselves when they keep some units. Keep the plain-language explanation.
- Withdrawals now pay straight to the wallet. Say "$X returned to your wallet" from the `Withdrawn` event's `paidDirectly`; when it is false, say it is waiting to be claimed.
- Update everything that decodes `Withdrawn` to the new signature `Withdrawn(uint256 dealId, address buyer, uint32 units, uint256 amountReturned, bool paidDirectly, uint64 livePrice, uint32 totalUnits, uint32 buyerCount)`: the activity list (a partial withdrawal reduces the buyer's units and escrow; a full one clears them) and the proof page's conservation sums.

3. CLAIMS ARE ALWAYS VISIBLE

Funds credited to `claimable` (refunds after settlement, or a withdrawal that could not be paid directly) used to be offered only inside a settled deal's room, so a buyer could not find them. Add a banner under the nav, on every tab, whenever the connected wallet has anything to claim — USDC from `Settler.claimable`, and goods from `goodsClaimable` for the goods tokens of deals they took part in — with a Claim button for each.

4. A DEAL LIST INSTEAD OF A DEAL ID BOX

Replace the deal-ID input on the Deal room tab with a list of deals:
- Read `dealCount` and every deal (batched). Two tabs: **Active** (open, before the deadline) and **Ended**. Active is the default and is sorted by time left.
- Each card: title, the goods token symbol, live price per unit, units sold out of stock, time left (chain time), and the next-tier hint. Clicking a card opens that deal room; a back link returns to the list.
- Keep `?deal=N` links working so shared links still open a deal directly.
- With no active deals, an empty state with a button to Post one.

Everything must work logged out and fit at 375px. Run tsc and the linter for the frontend and paste the actual output.
