The last turn stopped partway: `MockEIP3009USDC.sol` and the `DemandPool.sol` changes landed, but it ended while writing `SwarmTest.t.sol`, which is still the original 19-test version in the workspace. This turn finishes the contract work only. The relayer and frontend come in the next turn — do not start them here.

I reviewed what you wrote. The design is right: `receiveWithAuthorization`, the nonce derived from pool, deal, buyer and salt, one shared precondition function, the price check before any state change, and excess routed through `creditWithdrawal` with `ExcessCredited`. One gap to fix first:

`AuthorizationAlreadyUsed` is declared in `DemandPool` but never used — the comment says the token's revert is left to propagate. Make it a real named error: add `authorizationState(address,bytes32)` to `IUSDC3009` (it exists on the real Arc USDC, which I checked), and before calling `receiveWithAuthorization`, revert `AuthorizationAlreadyUsed()` if `USDC.authorizationState(buyer, nonce)` is already true. The relayer will key off that name.

Then write the tests in `SwarmTest.t.sol`, keeping all 19 existing tests passing unchanged. Use `MockEIP3009USDC` and `vm.sign` with the domain built from `block.chainid`. Cover:

- a gasless commit is recorded for the signer, not the relayer (`msg.sender`);
- the price falls between signing and landing: commit succeeds, the buyer escrows the live price, `ExcessCredited` carries the difference, the buyer's `claimable` rises by it, and conservation holds at settlement;
- the price rises above the authorization (a withdrawal un-breaks a tier first): reverts `PriceRoseBeyondAuthorization` with the new price, and no state changes;
- a replayed authorization: reverts `AuthorizationAlreadyUsed`;
- a signature for deal A submitted for deal B: reverts, and deal B is unchanged;
- calling `transferWithAuthorization` directly on the token with the same signature cannot produce a commit;
- a blocklisted buyer: reverts `Blocklisted`;
- the existing conservation fuzz property extended to mix ordinary and gasless commits, including excess credits, with the pool's USDC balance checked against escrow plus claimable at the end.

Run `forge test` and paste the complete, unedited output. Do not deploy and do not touch the frontend.
