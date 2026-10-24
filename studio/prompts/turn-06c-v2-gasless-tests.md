Gasless tests for v2, in a new file `contracts/test/SwarmV2GaslessTest.t.sol`. Do not modify the other test files or the contracts unless a test exposes a real bug — if it does, say so plainly and fix it.

Reuse what worked in v1: `MockEIP3009USDC` etched at the USDC address and `initialize()`d after the etch so its domain uses the address it lives at; a signing helper that returns a struct (no `via_ir`); `SwarmPass` as the goods token. Cover:

1. a gasless order is recorded for the signer, not the relayer, with the right units and escrow;
2. the price falls between signing and landing: the buyer signed for `priceAt(total + units) × units` as quoted, another order broke a tier first, the escrow is the lower total, and the difference is credited via `ExcessCredited` and visible in `claimable`;
3. the price rises after signing (a withdrawal un-breaks a tier): reverts `PriceRoseBeyondAuthorization` carrying the new **total**, with no state change;
4. the quantity is bound: the same signature submitted with a different `units` reverts, and the buyer's balance and the deal are unchanged;
5. replay reverts `AuthorizationAlreadyUsed`;
6. a signature for deal A submitted for deal B reverts;
7. the buyer's `ReceiveWithAuthorization` signature submitted directly to `transferWithAuthorization` on the token reverts with nothing moved, and the same signature still orders through `commitWithAuthorization`;
8. a blocklisted buyer reverts `Blocklisted`;
9. fuzz mixing ordinary and gasless orders of random quantities, with excess credits, through settlement: both conservation identities hold, and after every claim the contracts hold no USDC and no passes.

Run `forge test` over the whole suite and paste the complete, unedited output. If you run short of room, run `forge test` on what you have rather than writing more.
