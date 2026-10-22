The last two turns both stopped while writing `SwarmTest.t.sol` — each time the whole file was being rewritten in one go, and neither run reached `forge test`. Change the approach so the output stays small.

Do not modify `SwarmTest.t.sol` at all. The 19 tests in it are known-good and must stay byte-for-byte as they are.

Put the new tests in a new file, `contracts/test/SwarmGaslessTest.t.sol`, with its own small `setUp()` that etches `MockEIP3009USDC` at the USDC address and calls its `initialize()`, deploys and wires the three contracts, and posts a deal. Keep helpers minimal: one function that builds the `ReceiveWithAuthorization` digest exactly as the mock does and signs it with `vm.sign`.

Your two fixes from last turn are right and stay: the `authorizationState` pre-check in `DemandPool`, and the post-etch `initialize()` that rebuilds the mock's domain separator with the address it actually lives at — that one would have made every test signature fail, and it is a good catch.

Tests to write, each short:

1. a gasless commit is recorded for the signer, not `msg.sender`;
2. the price falls between signing and landing: commit succeeds, the live price is escrowed, `ExcessCredited` carries the difference, and the buyer's `claimable` rises by it;
3. the price rises above the authorization after a withdrawal un-breaks a tier: reverts `PriceRoseBeyondAuthorization` with the new price;
4. a replayed authorization reverts `AuthorizationAlreadyUsed`;
5. a signature for deal A submitted for deal B reverts;
6. `transferWithAuthorization` called directly on the token with that signature does not create a commit;
7. a blocklisted buyer reverts `Blocklisted`, using `MockBlocklistedEIP3009USDC`;
8. one fuzz test mixing ordinary and gasless commits, including excess credits, settling, and asserting supplier credit plus refunds equals commits in, and the pool's USDC balance equals escrow plus claimable throughout.

Write the file, then run `forge test` over the whole suite and paste the complete, unedited output. If you run short of room, run `forge test` on what you have rather than writing more — a passing partial suite with real output is worth more than a complete file that never ran.
