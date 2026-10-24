Two small fixes before the mainnet deploy. Change only `foundry.toml` and `contracts/test/SwarmGaslessTest.t.sol` (and a test helper only if unavoidable). Do not touch `DemandPool.sol`, `DealFactory.sol`, `Settler.sol`, the relayer or the frontend, and do not deploy.

1. TAKE `via_ir` BACK OUT OF `foundry.toml`

`via_ir = true` was added project-wide to get past a stack-too-deep error in a test helper (`_signAuth` returning seven values). But it also changes how the production contracts compile — the bytecode we are about to deploy to mainnet — and `settle(100 buyers)` moved from 1,475,504 to 1,483,728 gas. A compiler-pipeline change made for test scaffolding should not ship in production bytecode.

Remove `via_ir = true`. Fix the stack depth in the test instead: have the signing helper return a struct (for example `Auth { validAfter, validBefore, nonce, v, r, s }`) and update the call sites. Keep `[profile.default.fuzz] runs = 256`.

2. MAKE THE `transferWithAuthorization` TEST PROVE THE CASE THAT MATTERS

`test_Gasless_TransferWithAuthCannotCommit` has the buyer sign a `TransferWithAuthorization`, which our flow never asks a buyer to sign. The threat that matters is different: someone takes the buyer's real `ReceiveWithAuthorization` signature — the one sent to the relayer — and submits it to `transferWithAuthorization` directly on the token, to move the buyer's USDC into the pool with no commit recorded.

Replace it (or add a test) so that it signs a `ReceiveWithAuthorization` exactly as the gasless flow does, passes those same values and signature to `usdc.transferWithAuthorization(...)`, and asserts that call reverts — the two authorization types have different EIP-712 typehashes, so the signature cannot verify — and that the buyer's balance, the pool's balance and the deal's buyer count are all unchanged. Then show the same signature still works through `commitWithAuthorization`.

Run `forge test` over the whole suite and paste the complete, unedited output, including the gas line from `test_GasBound`. All tests must pass.
