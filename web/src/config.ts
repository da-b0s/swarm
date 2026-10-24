/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc, arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'
import { ACTIVE_NETWORK } from './swarm/config'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arc.id, arc.rpcUrls.default.http[0])
registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])

// The first chain is the one wagmi and ConnectKit ask the wallet to switch to
// on connect. It must be the network this build runs on: with Arc mainnet listed
// first, connecting on a testnet build switched the wallet to mainnet, which
// failed outright where the wallet had no Arc mainnet configured and otherwise
// left the commit panel on the wrong chain.
const activeChain = ACTIVE_NETWORK === 'mainnet' ? arc : arcTestnet
const otherArc = ACTIVE_NETWORK === 'mainnet' ? arcTestnet : arc

export const config = createConfig({
  chains: [activeChain, otherArc, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    [arc.id]: http(),
    [arcTestnet.id]: http(),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
