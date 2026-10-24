/**
 * Swarm network + contract configuration.
 * Switch ACTIVE_NETWORK to 'mainnet' for production; contracts are separate per network.
 * Never bury chain IDs or addresses in components — import from here.
 */

export type SwarmNetwork = 'mainnet' | 'testnet'

const ZERO = '0x0000000000000000000000000000000000000000'

// Default: testnet, because Swarm is not deployed to mainnet yet. Flip the default
// to 'mainnet' in the same commit that records verified mainnet addresses below —
// not before. Pointing the app at chain 5042 with no contracts there invites a
// reviewer to approve USDC to an address holding no code.
export const ACTIVE_NETWORK: SwarmNetwork =
  (import.meta.env.VITE_SWARM_NETWORK as SwarmNetwork | undefined) ?? 'testnet'

// Arc mainnet: chain 5042
export const ARC_MAINNET = {
  chainId: 5042,
  hexChainId: '0x13B2',
  name: 'Arc',
  rpcUrl: 'https://rpc.mainnet.arc.io',
  explorerBase: 'https://explorer.arc.io',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  usdc: { address: '0x3600000000000000000000000000000000000000' as `0x${string}`, decimals: 6 },
  blockTime: 0.5, // seconds
} as const

// Arc testnet: chain 5042002
export const ARC_TESTNET = {
  chainId: 5042002,
  hexChainId: '0x4D0392',
  name: 'Arc Testnet',
  rpcUrl: 'https://rpc.testnet.arc.io',
  explorerBase: 'https://explorer.testnet.arc.io',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  usdc: { address: '0x3600000000000000000000000000000000000000' as `0x${string}`, decimals: 6 },
  blockTime: 0.5,
} as const

export type ArcNetworkConfig = typeof ARC_MAINNET | typeof ARC_TESTNET

export const ARC_NETWORK: ArcNetworkConfig =
  ACTIVE_NETWORK === 'mainnet' ? ARC_MAINNET : ARC_TESTNET

// Deployed contract addresses per network.
//
// Verified from chain with `node tools/verify-deploy.mjs`, never copied from a
// Studio result document. Studio's own `deployments` list reports sandbox deploys
// it could not wire, so an address appearing there is not evidence it works.
const CONTRACTS = {
  mainnet: {
    // NOT DEPLOYED YET. Zero addresses rather than placeholders that look real.
    DealFactory: ZERO as `0x${string}`,
    DemandPool:  ZERO as `0x${string}`,
    Settler:     ZERO as `0x${string}`,
    SwarmPass:   ZERO as `0x${string}`,
    deployBlock: 0n,
    deployed: false,
  },
  testnet: {
    // Deployed and wired from a deployer wallet we control, then verified from
    // chain: bytecode at all three, all three owner wiring calls landed,
    // constructor links agree in both directions, USDC predeploy correct.
    // Swarm v2 (quantities, token delivery), deployed 24 Oct 2026 and verified:
    // wiring from chain, and all four contracts byte-identical to the local build.
    // Swarm Pass has its faucet on. Earlier v1 sets are retired.
    DealFactory: '0xdF7ab518C23aff70ecd2Dd61e639fbEd62F2D5aD' as `0x${string}`,
    DemandPool:  '0x0C04e8Bf223F4C9ab45678273b8D692Ef9550B36' as `0x${string}`,
    Settler:     '0xfD29dd3c3003713f529912315F5e47C9c88F8DD3' as `0x${string}`,
    SwarmPass:   '0x28ac46d52C34a53565c481849361b8DB2cb3E4ca' as `0x${string}`,
    deployBlock: 68895718n,
    deployed: true,
  },
} as const

export const CONTRACTS_ACTIVE = CONTRACTS[ACTIVE_NETWORK]

/** Max USDC price per unit: 5_000_000 micro-USDC = $5.00 */
export const MAX_PRICE_USDC = 5_000_000n
/** Max buyer cap */
export const MAX_CAP = 100
/** Max tiers (contract enforces through gas but we keep UI sane) */
export const MAX_TIERS = 10

/** eth_getLogs window: start conservative, back off further on rejection */
export const INITIAL_LOG_WINDOW = 2000n
export const MIN_LOG_WINDOW = 500n

/**
 * False when the active network has no verified deployment. Every write path must
 * refuse rather than letting a wallet sign against a zero address.
 */
export const DEPLOYMENT_READY: boolean = CONTRACTS_ACTIVE.deployed

/**
 * Optional gasless relayer URL. When unset (or empty), the gasless commit path
 * is not shown and everything works as normal approve-then-commit. When set, the
 * commit panel offers gasless as the primary path with approve-then-commit as a
 * fallback.
 *
 * The relayer is a separate Node service — the key never reaches the browser.
 * Set VITE_RELAYER_URL in .env to enable:
 *   VITE_RELAYER_URL=http://localhost:3100
 */
export const RELAYER_URL: string | undefined =
  (import.meta.env.VITE_RELAYER_URL as string | undefined) || undefined
