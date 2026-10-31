Add a demo launch token, Hive, used to show a fair token launch through Swarm on mainnet. Contracts and tests only; touch nothing else.

1. `contracts/HiveToken.sol`, pragma 0.8.28 like the others, using OpenZeppelin `ERC20` (already a dependency):
- name "Hive", symbol "HIVE", 18 decimals (the ERC20 default).
- Constructor takes `address recipient` and mints the whole fixed supply, 1,000,000 HIVE (1_000_000 * 10**18), to it once. Revert with a named error if recipient is the zero address.
- No owner, no mint function after construction, no burn, no pause, no blocklist, no fees, no hooks that change transfer amounts. A plain fixed-supply token anyone can verify at a glance.
- A short NatSpec header saying exactly that.

2. `contracts/test/HiveToken.t.sol` (Foundry), testing: name, symbol, decimals and total supply; the whole supply goes to the recipient; zero-address recipient reverts; a normal transfer moves the exact amount (no fee); there is no mint path after deployment (total supply unchanged after transfers); and a Swarm round trip: post a deal in DealFactory selling HIVE with tokensPerUnit = 1e18, a buyer commits, settle, and the buyer ends with exactly the units bought in HIVE and the supplier with the clearing price × units in USDC (reuse the existing test setup helpers and mocks for USDC as the other Swarm v2 tests do).

Run the full test suite and paste the actual summary.
