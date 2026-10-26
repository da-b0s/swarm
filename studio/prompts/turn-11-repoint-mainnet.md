Repoint only. No contract changes, no deploy, no other edits.

Swarm v2.2 is now deployed on Arc mainnet (chain 5042) from our own deployer and verified from chain: all wiring correct, and all three contracts byte-identical to the build the test suite runs. Record it in `src/swarm/config.ts`:

    CONTRACTS.mainnet:
      DealFactory  0x27F8863e5e52f1DacF699f063f6dAe79690D0e2a
      DemandPool   0x7A8754dB7B0d629841523c0694A7788221e9F78f
      Settler      0x2401F31355A8D1EA713BE0C83bE193C79b6F96Ac
      SwarmPass    zero address (mainnet deals sell EURC; there is no Swarm Pass on mainnet)
      deployBlock  28005197n
      deployed     true

Replace the "NOT DEPLOYED YET" comment with one saying it was deployed on 26 October 2026 and verified from chain.

Then make mainnet the default: `ACTIVE_NETWORK` falls back to `'mainnet'` when `VITE_SWARM_NETWORK` is unset, and the comment above it should say so (testnet is still selectable with `VITE_SWARM_NETWORK=testnet`). Leave the testnet block exactly as it is.

Make sure nothing in the UI still tries to read Swarm Pass when its address is zero.

Run the type check and the linter and paste the actual output.
