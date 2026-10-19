Build the Swarm frontend, mobile-first. The live price is the product:

- An enormous current price that animates DOWN when a tier breaks, with a celebratory moment at the break.
- A progress bar to the next tier: "7 more buyers and everyone pays $8".
- "You will be refunded $X at the current price" shown live for each committed buyer - this is the emotional hook; make it prominent.
- A share link showing "bring 3 friends and your price drops to $8".
- A countdown to the deadline driven by BLOCK TIMESTAMPS, not the browser clock.
- Supplier view: post a deal with a tier builder, see live committed volume.
- /proof reading DealPosted, Committed, TierBroken, Settled, Refunded and Claimed events live from chain, with totals for USDC moved, buyers and clearing prices achieved. Every row links to explorer.arc.io.

Default wallet connection to Arc mainnet, chain 5042, with a one-click add-network button using wallet_addEthereumChain and chainId 0x13B2, nativeCurrency USDC with 18 decimals, rpcUrls https://rpc.mainnet.arc.io, blockExplorerUrls https://explorer.arc.io.

Display rules: all contract values are 6-decimal USDC - format them as dollars. Native balances are 18-decimal; divide by 10^12 before display. A balanceOf of 0 does not mean zero funds, so never show "no funds" based on the ERC-20 view alone.

The page must work logged out for a stranger: show the live price and buyer count with no wallet connected, and only ask for a wallet at the moment of commit.
