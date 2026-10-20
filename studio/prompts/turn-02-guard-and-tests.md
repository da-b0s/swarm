Denying the API key request. Do not create credentials on my Circle account, do not write any key into the project, and please don't ask again this session. Deployment and wiring are being done outside Studio with Arc Foundry from a deployer wallet I control, which is the pipeline this project uses for mainnet regardless. You do not need to deploy or wire anything from here.

FIRST, A FIX — the chain guard you added blocks mainnet

You added `if (block.chainid != 5042002) revert WrongChain();` to all three constructors. Arc Testnet is 5042002, but this project ships to **Arc mainnet, chain 5042**. As written, the mainnet deploy reverts in the constructor, which would break the entire point of the build.

Remove the hardcoded chain check. Which chain a contract is deployed to is a deployment-configuration concern, not something to pin inside the constructor. If you would rather keep a guard, take the expected chain id as a constructor argument so the deployer passes it — do not hardcode either value. Either way, `WrongChain` must not be reachable on chain 5042.

Do not deploy. Three sets of these contracts already exist on Arc testnet from previous turns; a fourth adds noise and I cannot wire any of them from here anyway.

THEN THE TEST SUITE

Write Foundry tests for Swarm. Use the curve (10 buyers @ $1.00, 25 @ $0.75, 50 @ $0.50) with minBuyers 10 and cap 100 throughout unless a test says otherwise. A buyer escrows the tier price live at the count INCLUDING their own commit, so buyer 24 escrows $1.00 and buyer 25 escrows $0.75.

1. Happy path, three tiers, 51 buyers committing in order. Assert each number individually: clearing price $0.50; buyers 1-24 escrowed $1.00 and are refunded $0.50 each; buyers 25-49 escrowed $0.75 and are refunded $0.25 each; buyers 50-51 escrowed $0.50 and are refunded nothing; the supplier is credited exactly $25.50; refunds total $18.25; commits total $43.75.

2. Conservation property test (fuzz or invariant): supplier credit plus all refunds exactly equals the sum of all commits, for any random sequence of commits and withdrawals. This is the flagship test — make it a real fuzz over sequence length and withdrawal placement.

3. Uniform-price property test, equally important: for any random sequence, the supplier is credited exactly `clearingPrice(finalCount) * buyerCount`. This is what makes "every buyer settles at one clearing price" literally true, so assert it as a property, not just in the happy path.

4. A deal below the minimum: refundAll returns every buyer their own escrowed amount in full — the amounts differ per buyer — and the supplier is credited nothing.

5. A deal exactly at the minimum, 10 buyers: settles at tier 1, clearing $1.00, every refund zero.

6. Tier boundary: clearingPrice is $1.00 at 24 buyers and $0.75 at 25. The boundary is >=, not >.

7. The un-break case. 25 buyers take the live price to $0.75. The 25th buyer — who escrowed $0.75 — withdraws successfully and recovers exactly $0.75 as claimable. The live price returns to $1.00. A new commit re-breaks it to $0.75. Conservation holds throughout.

8. THE WITHDRAWAL PRECONDITION. With exactly 25 buyers committed, buyer 1 (who escrowed $1.00) attempts to withdraw and must revert with `WouldStrandBuyer`, because dropping to 24 buyers raises the clearing price to $1.00 while buyer 25 escrowed only $0.75. Then assert it binds exactly on tier thresholds and nowhere else: with 24, 26, 30 and 51 buyers committed, buyer 1 withdraws successfully; with exactly 25 and exactly 50 it reverts. Finally show a refusal is temporary — at 25 buyers buyer 1 is refused, one more buyer commits, and buyer 1's withdrawal then succeeds.

9. No dead ends. For a deal past its deadline there must be no state in which both `settle()` and `refundAll()` revert. Drive this with a fuzzed sequence of commits and withdrawals, then assert exactly one of the two succeeds.

10. Double commit from the same address reverts.

11. Settling before the deadline reverts.

12. Double settlement reverts; settle after refundAll reverts; refundAll after settle reverts.

13. Gas bound: 100 buyers settle in a single transaction within the block gas limit. Print the gas used. Also print the gas for a withdrawal at 100 buyers, to show the tier-tally lookup has not made withdrawal O(n).

14. Rounding and dust: after every participant claims, the contracts' USDC balance is exactly zero. Assert conservation to the wei.

15. Pull safety: a blocklisted buyer cannot block any other buyer's refund or the supplier's proceeds. Use the known blocklisted testnet address 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 against the real blocklist rather than a mock where that is possible.

16. Reentrancy on claim: a malicious receiver that re-enters `claim()` cannot drain.

17. pause() halts postDeal and commit while settle, refundAll and claim all still work.

18. postDeal validation, one assertion per rule: empty tiers; a tier price above the 5 USDC cap; a zero tier price; minBuyers of 0; non-ascending minBuyers; non-descending prices; a deadline in the past; cap of 0; cap above 100; minBuyers greater than cap; and a bottom tier whose minBuyers exceeds cap.

19. Claimable accumulates across deals: a buyer owed refunds from two different deals claims once and receives the sum.

Run the full suite and show the output, including both gas figures from test 13.
