Reading the existing test structure first. I have enough context. Now read the remappings to get the OZ import path: Good. Now write both files, then run the tests. One failure: `MaxBuyersOutOfRange()` — `maxBuyers: 0` means "no cap" in one contract but is a validation error in another. Let me check the DealFactory validation: `maxBuyers` must be in `[1, 100]`. Fix the test to use a sensible value (10): All 75 tests pass.

```
╭----------------------------+--------+--------+---------╮
| Test Suite                 | Passed | Failed | Skipped |
+========================================================+
| HiveTokenTest              | 8      | 0      | 0       |
| SwarmV2GaslessTest         | 9      | 0      | 0       |
| SwarmV2PartialWithdrawTest | 11     | 0      | 0       |
| SwarmV2Smoke               | 1      | 0      | 0       |
| SwarmV2Test                | 35     | 0      | 0       |
| SwarmV2TopUpTest           | 11     | 0      | 0       |
╰----------------------------+--------+--------+---------╯
75 passed, 0 failed, 0 skipped
``` **`contracts/HiveToken.sol`** — 30 lines. Inherits OZ `ERC20`. Constructor takes `address recipient`, reverts with `ZeroAddressRecipient()` if zero, mints exactly `1_000_000 * 10**18` once and returns. No other state-mutating functions; `TOTAL_SUPPLY` is a public constant for easy verification.

**`contracts/test/HiveToken.t.sol`** — 8 tests across two groups:

*Unit tests (6):*
- `test_Metadata` — name "Hive", symbol "HIVE", decimals 18
- `test_TotalSupply` — exactly 1,000,000 × 10^18
- `test_EntireSupplyToRecipient` — full balance lands on recipient, zero elsewhere
- `test_ZeroAddressRecipientReverts` — `expectRevert(ZeroAddressRecipient.selector)`
- `test_TransferExactAmount_NoFee` — sender loses exactly the amount, receiver gains exactly the amount
- `test_TotalSupplyUnchangedAfterTransfers` / `test_NoMintAfterDeployment` — supply fixed at 1,000,000 after multiple transfers

*Swarm round-trip (1 `test_SwarmRoundTrip`):*
Deploys the full Swarm v2 stack (DealFactory, DemandPool, Settler) with mock USDC at the canonical Arc address and HiveToken as the goods token (`tokensPerUnit = 1e18`). Supplier posts a two-tier deal (5 units → $1.50). Buyer commits 5 units, crosses the lower tier. After `settle()` the test asserts: buyer holds exactly 5 × 10^18 HIVE, supplier holds exactly 7,500,000 micro-USDC, settler is empty, and `totalSupply` is still 1,000,000 HIVE.

The first run hit `MaxBuyersOutOfRange()` because `maxBuyers: 0` is out of the contract's `[1, 100]` range — fixed to `maxBuyers: 10`.