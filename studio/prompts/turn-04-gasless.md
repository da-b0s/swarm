Add gasless commits via EIP-3009, so a buyer invited by a friend can arrive holding only USDC with no concept of gas.

THE DOMAIN

`{ name: "USDC", version: "2", chainId: 5042, verifyingContract: "0x3600000000000000000000000000000000000000" }`.

Version "2" is documented for Arc testnet. Verify it against mainnet before relying on it rather than assuming, and tell me what you find — if the mainnet domain differs, the signatures will be rejected and the whole flow silently fails.

THE FLOW

The buyer signs a `transferWithAuthorization` offchain for the amount being escrowed. A relayer submits it from a funded EOA, then calls `commitWithAuthorization(dealId, auth, sig)` so the pool credits the buyer as the committer rather than the relayer.

THE AUTHORIZATION RACE — design for this, do not discover it later

An EIP-3009 authorization is signed for a FIXED amount, but a buyer escrows the tier price live at the moment their commit lands. If a tier breaks between the buyer signing and the relayer submitting, the authorized amount no longer matches the price the contract will charge, and the commit fails.

Handle it explicitly:

- The relayer signs for the price it quoted the buyer and submits promptly.
- `commitWithAuthorization` must accept an authorized amount that is at least the current tier price and escrow only the current price, refunding any excess to the buyer's claimable balance in the same transaction. Signing for a price that then falls must succeed, not fail — the price only ever moves in the buyer's favour as volume grows.
- A tier can also un-break through withdrawals, raising the price above the authorized amount. That case cannot be absorbed, so it must revert with a named error the relayer can recognise, re-quote, and ask the buyer to re-sign. Surface that to the buyer as a retry with the new price, never as an unexplained failure.

Make clear in the reply which of these you implemented and how.

RELAYER MECHANICS

- `maxFeePerGas` at least 20 gwei and `maxPriorityFeePerGas` 0. Below the 20 gwei floor on Arc a transaction vanishes silently — no error, no receipt — so treat it as hard and never let a config or estimate drop under it.
- Screen BOTH the buyer and the relayer against the USDC blocklist before submitting. Transfers to or from a blocklisted address revert and still burn gas.
- Track nonces explicitly, and retry at higher gas if a transaction stalls rather than resubmitting the same fee.
- Record the gas cost onchain as `receipt.gasUsed * receipt.effectiveGasPrice / 1e12`, so the figure is in USDC units and can go on the /proof page.
- The relayer key is a hot wallet with a small float. Read it from the environment only. It must never be committed, logged, or returned in a result document.

Also replay-protect: an authorization nonce must be usable once, and a second submission of the same authorization must revert with a named error rather than double-charging the buyer.
