Add gasless commits via EIP-3009 with domain { name: "USDC", version: "2", chainId: 5042, verifyingContract: "0x3600000000000000000000000000000000000000" }.

The buyer signs a transferWithAuthorization offchain; a relayer submits from a funded EOA with maxFeePerGas at least 20 gwei and maxPriorityFeePerGas 0, screens both addresses against the USDC blocklist before submitting, tracks nonces, and retries at higher gas if a transaction stalls. Below 20 gwei on Arc a transaction vanishes silently with no error and no receipt, so treat the floor as hard.

Record the gas cost onchain as receipt.gasUsed * receipt.effectiveGasPrice / 1e12.

Verify the EIP-712 domain version against mainnet before relying on it - version "2" is documented for testnet and must not be assumed for 5042.

This matters because a buyer invited by a friend will arrive with USDC and no concept of gas.
