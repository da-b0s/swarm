Frontend for adding to an order (spec: "v2.1 — adding to an order" in `context/mechanism-v2.md`). No contract changes, no deploy, and do not change any address in `src/swarm/config.ts`.

FIRST — apply `context/turn-07b-sync-local-fixes.patch` exactly, for example with `git apply`. It holds fixes made and verified outside Studio after hands-on testing with MetaMask, and your copies of these files predate them. Do not rework them; build on top:
- wallet connections restored on reload with timeouts (`useLateWalletReconnect`, `reconnectOnMount={false}`), because wagmi's own restore can hang forever on a wallet that does not answer;
- Studio's tracing and console-capture shims patch only inside a parent frame;
- a funding notice instead of a wallet error when the buyer lacks USDC;
- explicit fees (`ARC_TX_FEES`) on every transaction, since Arc silently drops transactions under its 20 gwei floor;
- a gasless-signing fallback for a MetaMask parser error, and relayer errors shown as sentences;
- the post flow checks receipt status and reports a stall;
- testnet addresses for the v2 deployment, and the relayer computing event topics from signatures.

THEN — top-ups:

1. A buyer who already has an order keeps the quantity picker, labelled as adding to their order. Bound it by the per-buyer limit minus their current units, and by remaining stock; when they are at the limit, say so instead of offering the picker. Both the gasless and the approve-then-commit paths add a lot by calling the same functions — the contract now treats a second order as a top-up. Keep the funding notice working for top-ups.

2. Their order summary: total units, total escrowed, the average price paid (escrowed ÷ units), and the refund waiting at the current price, `escrowed − clearingPrice × units`. Do not use `paidPerUnit` for the refund — it is now the buyer's cheapest lot, used only for the withdraw pre-check, which otherwise stays exactly as it is.

3. Activity list (`useDealHistory`): a buyer's `Committed` events are lots of one order. Sum units and escrow per buyer instead of replacing the entry with the latest lot; a `Withdrawn` clears the buyer. Show each buyer once, with total units and average price, newest activity first.

4. Remove any handling of `AlreadyCommitted` from the order paths and relayer messages; ordering again is now valid.

Run tsc and the linter for the frontend, typecheck the relayer, and paste the actual output.
