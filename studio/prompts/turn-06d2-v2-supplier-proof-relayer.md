Last v2 turn: the supplier view, the proof page, and the relayer. The buyer side is done. `context/mechanism-v2.md` is the specification. Do not touch the contracts or the addresses in `src/swarm/config.ts`.

1. SUPPLIER VIEW (Post)

- Goods token: an address field that reads and shows the token's symbol, decimals and the connected wallet's balance as soon as a valid address is entered. On testnet, offer Swarm Pass from config as the default with a "Get 100 test passes" button calling `faucet()`, and show when the faucet is on cooldown.
- "1 unit = N SYMBOL": the supplier enters N in whole tokens; convert to `tokensPerUnit` with the token's decimals.
- Title (required, 80 bytes max) and description (500 bytes max), with live byte counts.
- Stock (`maxUnits`), deal minimum (`minUnits`), optional per-buyer limit, maximum buyers (1–100), duration.
- The tier builder in units: rows of (from N units, price per unit), with the live curve chart.
- Validate every rule the contract enforces before anything is signed, with the same meaning as its named errors, and check the wallet holds `maxUnits × tokensPerUnit` of the token.
- Posting is two steps with progress shown: approve the token for exactly the stock amount, then `postDeal`. On success, open the new deal room.

2. PROOF PAGE

Read the v2 event signatures from the compiled ABIs. For each deal, show conservation in **both** assets: USDC (commits in, net of withdrawals = supplier credit + refunds; for refunded deals, = refunds) and goods (stock = units delivered + unsold returned; for refunded deals, = stock returned). Totals across deals: USDC moved, units sold, distinct buyers, tier breaks. `ExcessCredited` stays counted.

3. RELAYER (`relayer/server.ts`)

Regenerate the pool ABI from the compiled contract. `POST /commit` takes `units` as well; simulate `commitWithAuthorization` with it. On `PriceRoseBeyondAuthorization`, return 409 with `requiredTotal` (the contract's argument is now the total, not a per-unit price). Parse the v2 `Committed` event from the receipt and return `units`, `paidPerUnit`, `escrow` and `excessCredited`. Keep everything else: the error mapping that returns names only, the fee floor, the send queue, nonce handling, replacements and receipts. Update the frontend's gasless flow to read `requiredTotal` from a 409.

Run tsc and the linter for the frontend, typecheck the relayer, and paste the actual output.
