Build the Swarm frontend, mobile-first. The live price is the product.

THE DEAL ROOM — the main screen

- An enormous current price that animates DOWN when a tier breaks, with a celebratory moment at the break.
- A progress bar to the next tier, phrased as the action it needs: "7 more buyers and everyone pays $0.75".
- For a committed buyer, prominently: "You escrowed $1.00 — you'll be refunded $0.50 at the current price". This is the emotional hook. Recompute it live as the price falls. It is `escrowed - clearingPrice`, and it only ever grows.
- A share link showing "bring 3 friends and your price drops to $0.75".
- A countdown to the deadline driven by BLOCK TIMESTAMPS, not the browser clock.
- A live buyer count and a list of recent commits, newest first, each row linking to explorer.arc.io.

WITHDRAWAL — this needs real care, it is the one unintuitive rule

A buyer can withdraw before the deadline, but `withdraw` reverts when the caller's exit would leave a remaining buyer escrowed below the resulting clearing price. It binds only when the buyer count sits exactly on a tier threshold.

Do not surface this as a failed transaction. Compute it before offering the button: simulate the call, or replicate the rule client-side from the buyer count and the curve. When the exit is currently blocked, disable the button and say why in plain language, for example: "You can't withdraw right now — leaving would push the price back above what the newest buyer paid. One more buyer joins and you're free to go." Show that it is temporary, because it is: one further commit clears it.

Never let a user sign a transaction you can already tell will revert.

SUPPLIER VIEW

Post a deal with a tier builder: add tiers as (minBuyers, pricePerUnit) rows, validated client-side against the same rules the contract enforces — at least one tier, strictly ascending minBuyers, strictly descending prices, every price above zero and at or below 5 USDC, minBuyers of at least 1 and no greater than cap, cap between 1 and 100, the bottom tier reachable within cap, and a deadline in the future. Show the resulting curve as a chart before posting. Then live committed volume, the current clearing price, and what the supplier will receive at that price.

/proof

Read `DealPosted`, `Committed`, `Withdrawn`, `TierBroken`, `Settled`, `Refunded` and `Claimed` live from chain and show totals for USDC moved, distinct buyers, tier breaks and clearing prices achieved. Every row links to explorer.arc.io. Derive the conservation check from the events themselves — for each settled deal, show commits in, supplier credited and refunds out, and that the first equals the sum of the other two. Do not scan from genesis: Arc produces a block roughly every 0.5 seconds and the chain is tens of millions of blocks deep, so start from the deployment block, and keep `eth_getLogs` ranges at or below about 5,000 blocks because the public RPC rejects wider ones.

WALLET AND DISPLAY

Default wallet connection to Arc mainnet, chain 5042, with a one-click add-network button using `wallet_addEthereumChain`, chainId `0x13B2`, nativeCurrency USDC with 18 decimals, rpcUrls `https://rpc.mainnet.arc.io`, blockExplorerUrls `https://explorer.arc.io`.

Display rules, which matter on Arc specifically: every contract value is 6-decimal USDC — format as dollars. Native balances are 18-decimal, so divide by 10^12 before display. A `balanceOf` of 0 does not mean zero funds, because the ERC-20 view truncates sub-USDC amounts — never show "no funds" based on that view alone.

Committing needs an ERC-20 approval for the amount being escrowed. Handle the approve-then-commit sequence as one flow with clear progress, and remember the live price can move between the two.

The page must work logged out: a stranger sees the live price, the buyer count and the countdown with no wallet connected, and is only asked for a wallet at the moment they commit.
