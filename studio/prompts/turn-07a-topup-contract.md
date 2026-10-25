One contract change, from hands-on testing: buyers must be able to add to an order instead of withdrawing and ordering again. The specification is the new "v2.1 — adding to an order" section at the end of `context/mechanism-v2.md`; read it before writing anything. Contracts and tests only — no frontend, no relayer, no deploy.

1. `DemandPool`
   - `commit` and `commitWithAuthorization`: when the buyer already has an order, add a lot instead of reverting `AlreadyCommitted`. Same checks as a new order except `maxBuyers` (the buyer is already counted); the per-buyer limit applies to the buyer's total units; the stock limit as before. Price the lot `priceAt(totalUnits + units)`, add `lotPrice × units` to `escrowed` and `units` to `unitsOf`, and lower `paidPerUnit[buyer]` to the lot price when it is cheaper, moving the buyer's per-price tally entry from the old price to the new one.
   - Emit `Committed` for each lot exactly as now; `buyerCount` does not change on a top-up.
   - `withdraw` is unchanged in behaviour: it removes the whole order and credits the full `escrowed` back. Make sure the tally entry it removes is the buyer's current `paidPerUnit`.
   - `AlreadyCommitted` is no longer reachable from ordering; remove it if nothing else uses it.

2. `Settler`
   - Per-buyer refund becomes `escrowed − clearingPrice × unitsOf` instead of `(paidPerUnit − clearingPrice) × unitsOf`. Keep both conservation checks.

3. Tests — in a NEW file, `contracts/test/SwarmV2TopUpTest.t.sol`. Change the existing test files only where they assert `AlreadyCommitted` on a second order (that behaviour has changed by design — say which tests you changed and why). Cover:
   - a top-up after a tier break is priced at the new lower price; the buyer's `paidPerUnit` drops; `escrowed` and `unitsOf` sum the lots;
   - a top-up that itself breaks a tier pays the price it unlocks;
   - the per-buyer limit counts total units across lots; the stock limit applies to top-ups; `maxBuyers` does not block a top-up by an existing buyer;
   - the strand rule uses the cheapest lot: a withdrawal refused because of another buyer's cheaper top-up lot, permitted later;
   - withdrawing after top-ups returns the full escrow across all lots;
   - settlement refunds `escrowed − cp × units` for a multi-lot buyer, exactly;
   - a gasless top-up through `commitWithAuthorization`;
   - fuzz: random orders, top-ups and withdrawals through settlement — USDC and goods conservation hold, every refund is non-negative, and the contracts hold nothing after every claim.

Run `forge test` over the whole suite and paste the complete, unedited output. All tests must pass. If you run short of room, run `forge test` on what you have rather than writing more.
