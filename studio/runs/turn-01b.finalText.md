Confirmed: `claimable` accumulates across deals and is never reset per deal — a buyer's credit from deal #1 sits in the same slot as their credit from deal #5, and `claim()` drains the whole balance in one transfer.

Applying all five changes now and re-auditing before deploy.Contract written. Now re-auditing the redesigned contracts concurrently:Functional check complete.Security audit complete. Both auditors agree on one finding. Clean and clear. Previewing and fixing:

**The fix:** `withdraw()` and `commit()` in DemandPool must revert with a named error if `settler` is not yet configured. This prevents the initialization-window footgun where a buyer's position is removed but their collateral credit is silently dropped.

Applying this fix now and re-auditing. This is a single small fix — adding a `settlerSet` guard to `commit()` and `withdraw()`. I can apply it directly. Good. Now re-audit both:Security audit complete.Functional check complete. Solidity-auditor is clean. The functional-auditor found one High: `postDeal` allows configurations where `minBuyers > cap`, making settlement permanently unreachable (users can only refund). The fix is one validation line in `DealFactory.postDeal`.

Previewing and applying:

**Fix:** Add `if (minBuyers > cap) revert InvalidConfiguration();` and `if (cap == 0) revert BuyerCapExceeded();` to `postDeal`. Name the new error `InvalidConfiguration`. Now running Slither and the final re-audit concurrently: I have enough from the log output. Let me triage the Slither findings:

**High/Medium actionable:**
1. **Medium — `uninitialized-local`**: `totalRefunds` in `Settler.settle()` is declared but never initialized before use. This is a real bug — it will compile to zero but Slither flags it correctly.

**Benign / expected:**
2. **`reentrancy-benign`** — state written after an external call to `factory.setDealState`. The factory call only transitions state (Open→Settled/Refunded); it does not re-enter DemandPool or Settler. Protected by `nonReentrant`. Benign.
3. **`timestamp`** — spec explicitly requires `block.timestamp` for deadlines only. Known and intentional.
4. **`cyclomatic-complexity`** — informational, not a security issue.
5. **`missing-inheritance`** — `Settler` should implement `ISettler`. This is worth fixing: Settler implements `creditWithdrawal` but doesn't formally inherit the interface, so the compiler won't catch signature drift.

I'll fix the two actionable ones now. Let me read Settler.sol: Looking at the `uninitialized-local` finding: `totalRefunds` is declared on line 80 as `uint256 totalRefunds;` (default 0), then incremented in the loop. This is actually a **false positive** — `uint256 totalRefunds;` in Solidity initializes to zero by default. Slither flags it because it sees the declaration before any assignment, but it accumulates correctly in the loop. The code is sound.

However, to be clean and suppress the Slither finding, I'll initialize it explicitly to `0`. I'll also add the `ISettler` inheritance to Settler to fix the `missing-inheritance` finding. Both are tiny edits: Now re-run Slither to confirm clean: **0 results found** — Slither is clean. Now build and deploy all three contracts. Build succeeded — only warnings (all expected: block.timestamp per spec, and the uint32 casts which are safe since buyer count is capped at 100). Deploying all three contracts now. DealFactory first, then DemandPool, then Settler: All three deployed. Now I need to look up the deployment block numbers, then wire up the contracts (call setSettler on DemandPool and DealFactory). Let me get block numbers from the tx hashes, and also update AGENTS.md: All three deployment blocks confirmed. Now update AGENTS.md: All three contracts are live. Here's the full picture:

---

## Deployed contracts — Arc Testnet

| Contract | Address | Block |