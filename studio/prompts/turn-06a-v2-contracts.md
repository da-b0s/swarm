Swarm is moving to v2: buyers order a quantity, tiers count units, and the product is an ERC-20 token the supplier deposits when posting, delivered to buyers at settlement in the same transaction as payment. The full specification is attached at `context/mechanism-v2.md`. Read all of it before writing anything; it is the source of truth for this turn and the next three.

This turn is CONTRACTS ONLY, kept small on purpose — two earlier turns stopped midway while writing one very large file.

1. Update `SwarmTypes.sol`, `DealFactory.sol`, `DemandPool.sol` and `Settler.sol` to the specification: the new deal fields and every validation rule as a named error, stock deposit with the balance-delta check, `commit(dealId, units)`, the units-based strand rule, settlement and refund in both assets with a named-error conservation check for each, `claimGoods(token)`, and `commitWithAuthorization` with `units` and the units-bound nonce. Keep everything v1 got right: pull payments throughout, custom errors, the bounded per-price tally for the strand check, `nonReentrant` on every external state-changing function, the `receiveWithAuthorization` design, `ExcessCredited`, `AuthorizationAlreadyUsed` checked via `authorizationState` before the transfer, and no `block.chainid` checks anywhere.

2. Add `contracts/SwarmPass.sol` exactly as the specification describes: OpenZeppelin ERC-20, "Swarm Pass", "PASS", 0 decimals, a `faucetEnabled` constructor flag, `faucet()` minting 100 passes at most once per address per day, and owner minting.

3. The existing test files test the v1 API and will not compile against v2. Delete `contracts/test/SwarmTest.t.sol` and `contracts/test/SwarmGaslessTest.t.sol`, and replace them with ONE small file, `contracts/test/SwarmV2Smoke.t.sol`: post a deal selling Swarm Pass, three buyers order different quantities so one tier breaks, settle, and assert each buyer can claim their passes and refund and the supplier their USDC and unsold passes. That is all — the full suites come in the next two turns. Keep the existing mock helpers; adapt them only as needed to compile.

Do not touch the frontend or relayer, and do not deploy.

Run `forge build` and `forge test`, and paste the complete, unedited output, including any size warnings. If you run short of room, stop after the contracts compile and the smoke test runs — a passing smaller turn is worth more than a complete one that never ran.
