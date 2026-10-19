Write Foundry tests for Swarm. Use the curve (10 buyers @ $1.00, 25 @ $0.75, 50 @ $0.50) with minBuyers 10 throughout unless a test says otherwise. Remember every buyer collateralizes the top tier, $1.00, whenever they commit.

1. Happy path, three tiers, 51 buyers committing in order. Assert each of these individually: every buyer escrowed exactly $1.00; the clearing price is $0.50; every buyer is refunded exactly $0.50, the same amount for all of them; the supplier is credited exactly $25.50; refunds total $25.50; commits total $51.00.

2. Conservation property test (fuzz or invariant): supplier credit plus all refunds exactly equals the sum of all commits, for any random sequence of commits and withdrawals. This is the project's flagship test - make it a real fuzz test over sequence length and withdrawal placement, not a fixed case.

3. A deal below the minimum: refundAll returns every buyer their full $1.00 collateral and the supplier is credited nothing.

4. A deal exactly at the minimum, 10 buyers: settles at tier 1, clearing $1.00, every refund zero.

5. Tier boundary: assert clearingPrice is $1.00 at 24 buyers and $0.75 at 25 buyers. The boundary is >=, not >.

6. Withdrawal un-breaks a tier: 25 commits take the live price to $0.75, one buyer withdraws, the live price returns to $1.00, a further commit breaks it to $0.75 again. The withdrawer gets their full $1.00 back as claimable.

7. Double commit from the same address reverts.

8. Settling before the deadline reverts.

9. Double settlement reverts; settle after refundAll reverts; refundAll after settle reverts.

10. Gas bound: 100 buyers settle in a single transaction within the block gas limit. Print the gas used.

11. Gasless commit: a wallet with zero native balance commits via EIP-3009 and the gas is billed to the relayer.

12. Rounding and dust: after every participant claims, the contracts' USDC balance is exactly zero. Assert conservation to the wei, not to the cent.

13. Pull safety: a blocklisted buyer cannot block any other buyer's refund or the supplier's proceeds. Use the known blocklisted testnet address 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 against the real blocklist rather than a mock where that is possible.

14. Reentrancy on claim: a malicious receiver that re-enters claim() cannot drain.

15. pause() halts postDeal and commit while settle, refundAll and claim all still work.

16. The withdrawal squeeze - this is the test that justifies the collateral design, so assert it precisely. 50 buyers commit, taking the live price to $0.50. Then the 25 earliest buyers withdraw, so volume falls to 25 and the live price climbs back to $0.75. Assert that settle() succeeds, that it clears at $0.75, that each of the 25 remaining buyers is refunded exactly $0.25, that the supplier is credited $18.75, that commits totalled $25.00, and that conservation is exact. Under commit-time escrow this sequence would leave a buyer who had escrowed $0.50 facing a $0.75 clearing price, underflowing the refund and reverting settle() permanently while refundAll() also reverted for being above the minimum. Assert that no state exists in which both settle() and refundAll() revert for a deal past its deadline.

17. Withdrawals are never restricted: a buyer can withdraw at any point before the deadline regardless of what it does to the live price, and always recovers exactly $1.00.

Run the full suite and show the output, including the gas figure from test 10.
