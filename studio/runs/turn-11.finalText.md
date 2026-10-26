Reading the current config and any SwarmPass usage before editing. SwarmPass is not referenced anywhere outside `config.ts`. Now I have the exact text to replace — just the mainnet block and the `ACTIVE_NETWORK` default line: Now check whether any component guards on `SwarmPass !== ZERO` before calling faucet — grep for `SwarmPass` across all swarm files: `SwarmPass` is only in `config.ts`. The supplier view's SwarmPass faucet was removed last turn and no component reads it. Now run the check: `useEventLog` has a `deployBlock === 0n` guard to skip scanning when undeployed — now both blocks are non-zero so the type system flags the comparison as unreachable. Let me fix it: The guard is now dead code since both blocks are non-zero bigint literals. Replace with `!DEPLOYMENT_READY` — that stays boolean and conveys the right intent: Now confirm `DEPLOYMENT_READY` is imported in `useEventLog.ts`: Not imported yet. Check what is imported from config: `CONTRACTS_ACTIVE` is imported but `DEPLOYMENT_READY` is not. Add it: **Actual output:**

```
oxlint: Found 0 warnings and 0 errors
tsc --noEmit:  exit 0
```

Three changes made:

**`src/swarm/config.ts`** — `ACTIVE_NETWORK` default changed from `'testnet'` to `'mainnet'`; comment updated (testnet selectable via `VITE_SWARM_NETWORK=testnet`). Mainnet block filled with the three verified addresses, `deployBlock: 28005197n`, `deployed: true`, `SwarmPass: ZERO` (no SwarmPass on mainnet), and a comment noting the 26 October 2026 deployment. Testnet block unchanged.

**`src/swarm/useEventLog.ts`** — The `deployBlock === 0n` guard (now unreachable since both networks have non-zero deploy blocks) replaced with `!DEPLOYMENT_READY`; `DEPLOYMENT_READY` added to the config import.