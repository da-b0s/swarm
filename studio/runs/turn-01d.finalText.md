Writing the contracts now with the precise escrow model described.Contract written. Good. Now building and running both auditors concurrently:Security audit complete.Functional check complete. Stack-too-deep in `withdraw()`. The functional-auditor already flagged this. The fix is to split `withdraw()` into an internal helper to reduce live variables on the stack. This is a single-function refactor — applying it directly: The stack-too-deep is from having too many locals in `withdraw()`. The fix is to extract the WouldStrandBuyer check and the swap-and-pop into private helpers, reducing the number of live stack slots in the outer function: Wait — I need to review `_lowestEscrowedExcluding`: the loop iterates from `tiers.length` down to 1 (i.e. from `tiers[last]` which is the CHEAPEST tier to `tiers[0]` which is the MOST EXPENSIVE). But the comment says "finds the cheapest". Let me trace: `i = tiers.length`, so `i-1 = tiers.length-1` = last tier = cheapest. The loop sets `lowest = tp` on each non-zero cnt and keeps going — so `lowest` ends up as the MOST EXPENSIVE non-zero tier, not the cheapest. I need to find the cheapest (minimum pricePerUnit) among remaining buyers. Let me fix the loop direction: Wait — the tiers array has index 0 = HIGHEST price (tiers[0].pricePerUnit is the max), and last index = LOWEST price. So iterating `i` from `tiers.length` down to 1 means `i-1` goes from `tiers.length-1` (cheapest) toward `0` (most expensive). The first `return tp` hit is therefore the cheapest tier with non-zero count. That is correct.

Now rebuild: Clean build. Now running the final security review before deploy:Security audit complete.Functional check complete. Two findings. Triaging:

**Solidity-auditor — High (multichain-bridged-token-allowlists):** Hardcoded USDC address. The spec explicitly names `0x3600000000000000000000000000000000000000` on Arc Testnet and this is v1 — Arc-only by design. The note about a `block.chainid` guard is a reasonable addition without changing any interface. I'll add it.

**Functional-auditor — High (would-strand-threshold-case-not-enforced):** This is the crux. Let me work through it carefully.

At exactly 25 buyers, all 25 committed at $0.75 (tier 2 unlocked at count=25). One buyer wants to withdraw. The WouldStrandBuyer check computes:
- newCount = 24
- newPrice = clearingPrice(24) = $1.00 (tier 2 requires 25, so we fall back to tier 1 at $1.00)
- `_lowestEscrowedExcluding`: caller's price = $0.75. All 25 buyers are at $0.75. After excluding caller: tierCount[$0.75] = 25-1 = 24. So lowest remaining = $0.75.
- Check: lowestRemaining ($0.75) < newPrice ($1.00) → **WouldStrandBuyer fires**. ✓

The auditor says "the sole $0.75 buyer can exit" — but at 25 buyers ALL 25 are at $0.75 (everyone committed post-tier-2-unlock). So `tierCount[$0.75] = 25`, and after excluding the caller it's 24 — still non-zero, so `lowest = $0.75 < $1.00` → correctly reverts.

The auditor's finding is based on a misread of the exact-25 scenario. The code is actually correct for the stated property. Let me re-examine more carefully to be sure: if somehow buyers committed at different prices (e.g. buyers 1-24 committed when count < 25 and paid $1.00, then buyer 25 joined and everyone's price is still their own commit-time price):
- Buyers 1-24 escrowed $1.00, buyer 25 escrowed $0.75
- At count=25: buyer 25 withdraws → newPrice = $1.00, caller's price = $0.75, tierCount[$0.75] = 1 → after excluding = 0; tierCount[$1.00] = 24 → no adjustment; scan from cheapest: $0.50 → 0, $0.75 → 0, $1.00 → 24 → lowest = $1.00. Check: $1.00 < $1.00 is false → **WouldStrandBuyer does NOT fire**.

That's the scenario the auditor identified: when the exiting buyer paid the cheapest price ($0.75) and all remaining buyers paid more ($1.00), there's no one being stranded. This is correct — remaining buyers paid $1.00 and newPrice is $1.00, so no one is underwater. The WouldStrandBuyer check correctly PASSES here.

The spec's test 6: "with 25 buyers, the 25th (who escrowed $0.75) withdraws successfully, the tier un-breaks to $1.00." This is the same scenario: buyer 25 escrowed $0.75, remaining 24 escrowed $1.00, newPrice = $1.00 ≤ $1.00 (all remaining), withdrawal is allowed. ✓

So the functional-auditor's finding is actually a **false positive** — the WouldStrandBuyer logic is correct. The auditor's confusion was about which scenario constitutes "exactly 25 buyers where any withdrawal must revert." That scenario is only when ALL buyers committed at the same $0.75 price, which only happens if all 25 committed after the tier was already at 25.

Now for the chain guard (solidity-auditor finding): this is a genuine improvement for Arc-only deployment. I'll add a `block.chainid` check in the constructors. Arc Testnet is chain 5042002.

Previewing fixes:

**Fix 1 (High): Add `block.chainid` guard in DemandPool and Settler constructors.** DealFactory also gets it. Revert with `WrongChain()` if deployed on any chain other than Arc Testnet (5042002).

**Functional finding: no fix needed** — logic is correct, this was a false positive based on a specific scenario the code handles correctly.

Applying now and re-auditing: Adding `WrongChain()` error and `block.chainid` guard to all three constructors: Now rebuild and final re-audit:Security audit complete.Functional check complete. Both auditors come back clean. Checking the build: Build clean — same expected warnings only. Deploying all three: All three deployed. Now getting block numbers and immediately wiring. I'll use `cast` via the Arc Testnet RPC with the Circle SCP SDK to drive the three wiring transactions. Let me write a focused wiring script that uses the Circle developer-controlled wallets deployer wallet: Block numbers confirmed. Now wiring. I'll use the Circle SCP SDK directly with the deployer wallet ID from the deploy metadata: Circle credentials are not in the environment. The Circle developer-controlled wallets SDK requires `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET`, which aren't provisioned in this session. Rather than handing you calldata again, let me use `cast` directly with the SCP deployer wallet private key — except that key is Circle-managed and not exposed to the sandbox environment either.

The wiring calls must come from the owner wallet `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42`. Since both routes (Circle SDK and direct cast with key) require credentials the sandbox doesn't have, let me try a third route: checking if the Circle CLI can drive contract calls via the logged-in session: The CLI can only deploy (from agent wallets) and query (read-only) — it can't execute state-changing transactions on an existing contract from the Circle deployer wallet. The wiring calls require signing from `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42`, which is the Circle SCP platform deployer. The only way to drive that is via `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` — which aren't provisioned here.

Let me be explicit: I need your Circle credentials to complete the wiring. Let me ask for them properly: