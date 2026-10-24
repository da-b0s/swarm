Reading the current server.ts in full before touching anything. Good. All four fixes are surgical. I'll apply them in one pass.

**Fix 1** — replace the simulation `catch` block to use `ContractFunctionRevertedError`.  
**Fix 2** — field presence check: `!body[f]` → explicit `undefined`/`null`/`''` test.  
**Fix 3** — advance `nextReplace` whether replacement succeeds or throws.  
**Fix 4** — fix startup comment.

Also: the HTTP error handler at the bottom still echoes `err.message` for unrecognised errors (returning viem text to the client). That needs to be a generic 500 with server-side logging only. Fix 4 — startup comment: Fix 1 — replace the simulation catch block. `ContractFunctionExecutionError` exposes a `.walk()` method that traverses the cause chain; we find the first `ContractFunctionRevertedError` and read its `.data` which is already decoded: Fix 2 — field presence check: replace `!body[f]` with an explicit check that catches `0` and `"0"` as valid: Fix 3 — advance `nextReplace` whether replacement send succeeds or throws: Now fix the HTTP error handler — replace the catch block to log server-side and never return viem text to the client. Named contract errors keep their mapping; everything else returns 500 with no detail: Now typecheck: **Relayer `tsc --noEmit`:**
```
[Command succeeded with exit code 0]
```

---

Here is what each fix does and why it is correct.

**Fix 1 — simulation error decoding.**  
`ContractFunctionExecutionError` (what `simulateContract` throws) carries a `.walk()` method that traverses its cause chain. The first `ContractFunctionRevertedError` in that chain has a `.data` property that is already decoded by viem: `{ errorName: string, args: readonly unknown[] }`. Reading it directly replaces the defunct `decodeErrorResult(hex)` path that was throwing because the input was not hex. The old `cause.data` cast is gone entirely. For errors where `revertErr?.data` is absent (RPC failure, network error) the catch now throws `{ code: 'SimulationFailed' }` — an opaque sentinel — so the HTTP handler's final branch logs it server-side and returns 500, never viem's internal message text.

**Fix 2 — field presence check.**  
`v === undefined || v === null || v === ''` is the correct absent-field test. The previous `!body[f]` treated `"0"` and `0` as absent because both are falsy, rejecting any valid `validAfter: 0` or `validAfter: "0"`.

**Fix 3 — `nextReplace` advances unconditionally.**  
`nextReplace = Date.now() + REPLACE_INTERVAL_MS` is now set before the `try/catch` around `sendAtFee`. Whether the replacement is accepted or rejected by the node, the next bump won't be attempted for another 30 seconds. The previous code only advanced it inside the `try`, so a rejected send left the timer in the past and triggered another bump on the very next 2-second poll.

**Fix 4 — startup comment corrected** to "refuse all cross-origin requests" from "default `*`".