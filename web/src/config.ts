/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, fallback, createConfig } from 'wagmi'
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

// Arc and arcTestnet already include Multicall3 at 0xcA11bde05977b3631167028862bE2a173976CA11
// in their viem chain definitions, so batch.multicall works without any extra config.

// Per-endpoint options: JSON-RPC batching + retry on transient errors / 429s.
const endpointOpts = {
  batch: { wait: 50 },
  retryCount: 4,
  retryDelay: 500,
} as const

// Build a fallback transport from every RPC URL the viem chain definition lists,
// preserving the order (primary endpoint first). rank: false means the transport
// cycles to the next endpoint on failure rather than re-ranking by latency.
function arcFallback(urls: readonly string[]) {
  return fallback(
    urls.map(url => http(url, endpointOpts)),
    { rank: false },
  )
}

export const config = createConfig({
  chains: [activeChain, otherArc, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  batch: {
    // Aggregate concurrent readContract / useReadContracts calls through Multicall3
    // so a page with N reads issues one eth_call instead of N.
    multicall: true,
  },
  transports: {
    [arc.id]:        arcFallback(arc.rpcUrls.default.http),
    [arcTestnet.id]: arcFallback(arcTestnet.rpcUrls.default.http),
    [mainnet.id]:    http(), // ENS resolution uses mainnet
  },
})
