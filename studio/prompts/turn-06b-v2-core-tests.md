Turn 6a's contracts were reviewed and match `context/mechanism-v2.md`: settlement credits both assets with both conservation checks, orders pay the price including their own units, the strand rule works in units, and the gasless nonce binds the quantity. Two small fixes first, then the core test suite.

FIXES

1. Use OpenZeppelin's `SafeERC20` (`safeTransferFrom`, `safeTransfer`) for every goods-token transfer — the stock deposit in `DealFactory`, the pull to the settler, and `claimGoods`. A bare `transfer` returning `bool` makes tokens that return nothing, like USDT, unclaimable. Keep the balance-delta check on the deposit.
2. `claimGoods` reports a failed transfer as `NothingToClaim`. With `SafeERC20` the token's own revert surfaces instead; remove the misleading branch.

TESTS — a new file, `contracts/test/SwarmV2Test.t.sol`

Write it as a new file; do not rewrite the smoke test. Use `SwarmPass` (faucet enabled) as the goods token. Keep helpers minimal. Cover:

- posting: each validation rule rejected with its named error, including the stock deposit failing for a fee-on-transfer token (add a small mock) with `UnsupportedToken`;
- ordering: quantities; an order that breaks a tier by itself pays the lower price it unlocks; the per-buyer limit; the stock limit; `maxBuyers`; zero units; one order per buyer;
- the worked example from the specification's spirit: buyers ordering 1, 3, 2 and 4 units across a three-tier curve, settled, with every buyer's refund and passes and the supplier's USDC and unsold passes asserted exactly;
- the strand rule in units: a withdrawal refused when it would lift the price above a remaining buyer's paid price, permitted once more units are ordered;
- refund path: below `minUnits` at the deadline, every buyer's full escrow and the supplier's whole stock come back; also a deal nobody ordered from;
- claims: `claim` and `claimGoods` pay out, a second claim reverts, a reentrant goods token cannot drain the settler;
- fuzz: random quantities and withdrawals; at settlement, USDC commits in equals supplier credit plus refunds, and stock equals passes delivered plus unsold; and after every claim, the contracts hold no USDC and no passes;
- gas: `settle` with 100 buyers, logged.

Run `forge test` and paste the complete, unedited output. If you run short of room, run `forge test` on what you have rather than writing more.
