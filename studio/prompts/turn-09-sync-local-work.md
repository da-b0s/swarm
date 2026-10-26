Sync only. No contract changes, no deploy, no new features.

Apply `context/turn-09-sync-local-work.patch` exactly, for example with `git apply -p1` from the app root (paths are `a/src/...` and `b/src/...`). It holds frontend work made and verified outside Studio after hands-on testing on testnet, and your copies of these files predate it. Do not rework, restyle or "improve" any of it:
- a homepage (`src/swarm/HomePage.tsx`) with live stats read from the contracts (`src/swarm/useSwarmStats.ts`), shown by default when there is no `?deal=` link;
- a light/dark theme toggle (`src/swarm/theme.ts`, dark tokens in `src/index.css`), passed to ConnectKit and the toaster;
- `RetiredClaims.tsx`, so USDC still owed by retired testnet settlers can be claimed;
- deals close automatically (a keeper in the relayer), so the deadline panel says so and keeps a manual fallback;
- the Proof page lists newest deals first with "Show more", and the event log is paginated;
- plain-language copy throughout the order panel, and a fix for a literal `&#39;` shown to users;
- the current testnet addresses in `src/swarm/config.ts`.

Then run the type check and the linter over the frontend and paste the actual output. If the patch does not apply cleanly, stop and report the exact `git apply` error instead of applying it by hand.
