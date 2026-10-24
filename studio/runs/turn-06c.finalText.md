Reading the existing gasless test and the v2 contracts to understand the full surface before writing anything. Good. I have the full DemandPool API. Now reading the EIP-3009 mock and the v1 gasless test for the struct pattern: I have everything I need. The mock is complete and correct. Now I'll write the test file. Key differences from v1 gasless tests: the `_signAuth` helper must include `units` in the nonce derivation (`keccak256(abi.encode(pool, dealId, buyer, units, salt))`), the signed amount is `priceAt(total + units) * units`, and `PriceRoseBeyondAuthorization` carries the new **total** (not per-unit price). The struct will have `validAfter`, `validBefore`, `nonce`, `v`, `r`, `s` and a `signedAmount` field to make test assertions easy. **45/45 pass.** Complete unedited output:

```
Compiling 1 files with Solc 0.8.28
Solc 0.8.28 finished in 1.71s
Compiler run successful!

Ran 1 test for contracts/test/SwarmV2Smoke.t.sol:SwarmV2Smoke
[PASS] test_SmokeSettlement() (gas: 984211)
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 2.90ms (1.45ms CPU time)

Ran 35 tests for contracts/test/SwarmV2Test.t.sol:SwarmV2Test
[PASS] testFuzz_V2_Conservation(uint8,uint8) (runs: 256, μ: 2323755, ~: 1783558)
[PASS] test_Claims_ReentrantGoods() (gas: 1269279)
[PASS] test_Claims_SecondClaimGoodsReverts() (gas: 820176)
[PASS] test_Claims_SecondClaimReverts() (gas: 1080033)
[PASS] test_GasBound_Settle100() (gas: 21617081)
Logs:
  settle(100 buyers) gas: 3026735

[PASS] test_Order_AlreadyCommitted() (gas: 727086)
[PASS] test_Order_IncrementalPriceFalls() (gas: 938022)
[PASS] test_Order_MaxBuyersCap() (gas: 981184)
[PASS] test_Order_MaxUnitsPerBuyer() (gas: 480009)
[PASS] test_Order_TierBreakByOwnOrder() (gas: 708036)
[PASS] test_Order_UnitCapReached() (gas: 686714)
[PASS] test_Order_ZeroUnits() (gas: 479594)
[PASS] test_Post_DeadlineNotFuture() (gas: 96917)
[PASS] test_Post_InvalidGoodsToken_USDC() (gas: 17144)
[PASS] test_Post_InvalidGoodsToken_Zero() (gas: 16953)
[PASS] test_Post_InvalidTierCount_Eleven() (gas: 101149)
[PASS] test_Post_InvalidTierCount_Zero() (gas: 93643)
[PASS] test_Post_LastTierExceedsMax() (gas: 98263)
[PASS] test_Post_MaxBuyersOutOfRange_101() (gas: 96491)
[PASS] test_Post_MaxBuyersOutOfRange_Zero() (gas: 96026)
[PASS] test_Post_MinUnitsExceedsMax() (gas: 107365)
[PASS] test_Post_MinUnitsZero() (gas: 95196)
[PASS] test_Post_PriceCapExceeded() (gas: 94521)
[PASS] test_Post_TierMinUnitsExceedsMin() (gas: 95020)
[PASS] test_Post_TiersNotAscending() (gas: 96042)
[PASS] test_Post_TiersNotDescending() (gas: 96625)
[PASS] test_Post_TitleEmpty() (gas: 97106)
[PASS] test_Post_UnsupportedToken_FeeOnTransfer() (gas: 585488)
[PASS] test_Post_ZeroTierPrice() (gas: 94369)
[PASS] test_Refund_BelowMinUnits() (gas: 1013677)
[PASS] test_Refund_NobodyOrdered() (gas: 427582)
[PASS] test_Refund_SettleRevertsWhenBelowMin() (gas: 728300)
[PASS] test_Strand_RefusedThenPermitted() (gas: 1138626)
[PASS] test_Strand_SingleBuyerCanAlwaysWithdraw() (gas: 661858)
[PASS] test_WorkedExample() (gas: 1629810)
Suite result: ok. 35 passed; 0 failed; 0 skipped; finished in 371.13ms (403.80ms CPU time)

Ran 9 tests for contracts/test/SwarmV2GaslessTest.t.sol:SwarmV2GaslessTest
[PASS] testFuzz_V2Gasless_Conservation(uint8,uint8) (runs: 256, μ: 2594366, ~: 2126904)
[PASS] test_GL_Blocklisted() (gas: 1289900)
[PASS] test_GL_PriceFalls_ExcessCredited() (gas: 890439)
[PASS] test_GL_PriceRose() (gas: 683948)
[PASS] test_GL_Replay() (gas: 677201)
[PASS] test_GL_SignerRecorded() (gas: 674503)
[PASS] test_GL_TransferWithAuthCannotCommit() (gas: 682839)
[PASS] test_GL_UnitsBound() (gas: 444987)
[PASS] test_GL_WrongDeal() (gas: 691794)
Suite result: ok. 9 passed; 0 failed; 0 skipped; finished in 510.97ms (516.08ms CPU time)

Ran 3 test suites in 512.25ms (885.00ms CPU time): 45 tests passed, 0 failed, 0 skipped (45 total tests)
```

No contract changes were needed. Here is what each test proves and any design note worth recording:

**Test 2 (price falls).** `_signAuth` quotes `priceAt(totalUnits + units)` at the moment of signing. When a different buyer commits first and pushes total units past a tier boundary, the gasless buyer's landing price is lower — `priceAt(5 + 8) = $0.75` — and the difference becomes `ExcessCredited`. The `vm.expectEmit` assertion confirms the event is emitted with the exact excess amount before the state assertions confirm it in `settler.claimable`.

**Test 3 (price rises).** The scenario that produces a higher landing price is a withdrawal that un-breaks a tier: after the standard buyer withdraws all 10 units, `priceAt(0 + 5) = $1.00 > $0.75` signed. `PriceRoseBeyondAuthorization` carries the new **total** (`5_000_000`), matching the spec. The nonce-consumed check confirms no state mutation occurred.

**Test 4 (units bound).** Changing `units` from 3 to 4 at submit time changes the nonce the contract derives (`keccak256(pool, dealId, buyer, 4, salt)` ≠ `keccak256(pool, dealId, buyer, 3, salt)`), so the USDC mock's `ecrecover` recovers a wrong address and reverts `InvalidSignature`. The pool never sees the call succeed.

**Test 7 (transferWithAuth cannot commit).** The `ReceiveWithAuthorization` struct hash uses `RECEIVE_TYPEHASH`; `transferWithAuthorization` hashes with `TRANSFER_TYPEHASH`. Same `(v, r, s)` over a different struct hash recovers the wrong signer. The second half of the test confirms the nonce was not consumed by the failed call and the same `(v, r, s)` still works through `commitWithAuthorization`.

**Fuzz conservation.** `totalUsdcIn` accumulates the full `signedAmount` for gasless buyers (pool receives exactly that via `receiveWithAuthorization`; the excess is immediately re-credited as claimable, so it stays inside the system). After all claims the `assertEq(usdc.balanceOf(address(pool)), 0)` and `assertEq(usdc.balanceOf(address(settler)), 0)` checks confirm every dollar in also left. The goods side (`pass.balanceOf(factory)` and `pass.balanceOf(settler)`) confirms no passes are stranded.