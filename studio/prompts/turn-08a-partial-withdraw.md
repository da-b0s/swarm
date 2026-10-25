Contract change from hands-on testing. The specification is the new "v2.2 — partial withdrawal, paid out immediately" section at the end of `context/mechanism-v2.md`; read it first. Contracts and tests only — no frontend, relayer or deploy.

1. `DemandPool.withdraw(dealId, units)` replaces `withdraw(dealId)`:
   - `units` from 1 to the caller's `unitsOf`; a named error otherwise.
   - All units: the existing full-withdrawal behaviour (buyer removed, tally entry removed, whole escrow returned).
   - Some units: `returned = escrowed × units / unitsOf` rounded down; reduce `escrowed`, `unitsOf` and `totalUnits`; leave `paidPerUnit` and the tally alone; the buyer stays.
   - Strand rule: refuse with `WouldStrandBuyer` if the live price after the withdrawal would exceed the `paidPerUnit` of any buyer still in the deal — for a partial withdrawal, including the caller.
   - Pay out immediately: transfer `returned` from the pool to the caller with a low-level call, checking both call success and the returned bool. If it fails, credit it through `ISettler.creditWithdrawal` instead. Update all state before the transfer; keep `nonReentrant`.
   - Emit `Withdrawn(dealId, buyer, units, amountReturned, paidDirectly, livePrice, totalUnits, buyerCount)` and `TierBroken` when the live price moves.

2. Update the existing test files only where they call `withdraw(dealId)` or decode the old `Withdrawn` event — mechanical changes to the new signature, with assertions that previously expected a `claimable` credit now expecting the USDC in the buyer's wallet. Say which tests you changed.

3. New file `contracts/test/SwarmV2PartialWithdrawTest.t.sol`:
   - partial withdrawal returns the average price for the units removed, straight to the wallet, and the buyer keeps the rest of the order;
   - a full withdrawal also pays straight to the wallet;
   - a withdrawal to a blocklisted address falls back to `claimable` (use `MockBlocklistedEIP3009USDC` or an equivalent) and `paidDirectly` is false;
   - withdrawing 0 or more than held reverts with the named error;
   - the strand rule refuses a partial withdrawal that would lift the price above another buyer's — or the caller's own — cheapest lot;
   - rounding: an order whose escrow does not divide evenly; the remainder stays and settlement refunds it exactly;
   - a multi-lot order (top-ups) partially withdrawn, then settled: refund `escrowed − cp × unitsOf` exact;
   - fuzz: random orders, top-ups, partial and full withdrawals through settlement — USDC and goods conservation hold, every refund is non-negative, contracts empty after all claims.

Run `forge test` over the whole suite and paste the complete, unedited output. All tests must pass. If you run short of room, run `forge test` on what you have rather than writing more.
