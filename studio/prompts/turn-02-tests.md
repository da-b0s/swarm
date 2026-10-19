Write Foundry tests for Swarm covering:

1. A three-tier happy path on the curve (10 buyers @ $1.00, 25 @ $0.75, 50 @ $0.50), minBuyers 10, with 51 buyers committing in order. The price a buyer pays is the tier price at the moment THEY commit, so the expected outcome is exactly: clearing price $0.50; buyers 1-25 paid $1.00 and are refunded $0.50 each; buyers 26-50 paid $0.75 and are refunded $0.25 each; buyer 51 paid $0.50 and is refunded nothing; supplier credited $25.50; refunds total $18.75; commits total $44.25. Assert each of those numbers.
2. A conservation property test (fuzz/invariant) asserting supplier credit plus all refunds exactly equals the sum of commits for any random commit sequence, including sequences with withdrawals interleaved.
3. A deal below the minimum refunding everyone in full, supplier credited nothing.
4. A deal exactly at the minimum, settling at tier 1.
5. Buyer number 25 exactly triggering tier 2 - assert the boundary is >= and not >.
6. Withdrawal before the deadline un-breaking a tier: 25 commits break tier 2, one withdraws, the live price returns to tier 1, a new commit breaks it again.
7. Double commit from the same address reverting.
8. Settling before the deadline reverting.
9. Double settlement reverting, and settle-after-refundAll and refundAll-after-settle both reverting.
10. 100 buyers settling within the block gas limit - print the gas used.
11. 6-decimal rounding leaving no stranded dust: assert the contract's USDC balance is exactly zero after every participant claims.
12. A blocklisted buyer being unable to block other buyers' refunds. Use the known blocklisted testnet address 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 rather than a mock where possible.
13. Reentrancy on claim via a malicious receiver that re-enters: cannot drain.
14. pause() halting postDeal and commit while settle, refundAll and claim still work.

Run them and show the full output, including gas for test 10.
