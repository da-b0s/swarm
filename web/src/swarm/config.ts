/**
 * Swarm network + contract configuration.
 * Switch ACTIVE_NETWORK to 'mainnet' for production; contracts are separate per network.
 * Never bury chain IDs or addresses in components — import from here.
 */

export type SwarmNetwork = 'mainnet' | 'testnet'

const ZERO = '0x0000000000000000000000000000000000000000'

// Default: mainnet. Override with VITE_SWARM_NETWORK=testnet to use the testnet deployment.
export const ACTIVE_NETWORK: SwarmNetwork =
  (import.meta.env.VITE_SWARM_NETWORK as SwarmNetwork | undefined) ?? 'mainnet'

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
    // Deployed 26 October 2026 and verified from chain: bytecode at all three
    // addresses, all wiring calls landed, constructor links agree in both
    // directions. Swarm v2.2 (quantities, top-ups, partial withdrawal, token
    // delivery). Mainnet deals sell EURC; there is no Swarm Pass on mainnet.
    DealFactory: '0x27F8863e5e52f1DacF699f063f6dAe79690D0e2a' as `0x${string}`,
    DemandPool:  '0x7A8754dB7B0d629841523c0694A7788221e9F78f' as `0x${string}`,
    Settler:     '0x2401F31355A8D1EA713BE0C83bE193C79b6F96Ac' as `0x${string}`,
    SwarmPass:   ZERO as `0x${string}`,
    deployBlock: 28005197n,
    deployed: true,
  },
  testnet: {
    // Deployed and wired from a deployer wallet we control, then verified from
    // chain: bytecode at all three, all three owner wiring calls landed,
    // constructor links agree in both directions, USDC predeploy correct.
    // Swarm v2.2 (quantities, top-ups, partial withdrawal, token delivery), deployed 25 Oct 2026 and verified:
    // wiring from chain, and all four contracts byte-identical to the local build.
    // Swarm Pass has its faucet on. Earlier v1 sets are retired.
    DealFactory: '0xf17ee3d7920435ddc5ED2cd5e53D112758AA64d0' as `0x${string}`,
    DemandPool:  '0x7cDcB6C4E92EAE829267C025FB9706B50F9736ae' as `0x${string}`,
    Settler:     '0x6D4866A2bcc8a4F2Aa99eF268d420E1A3123e417' as `0x${string}`,
    SwarmPass:   '0x28ac46d52C34a53565c481849361b8DB2cb3E4ca' as `0x${string}`,
    deployBlock: 69088055n,
    deployed: true,
  },
} as const

export const CONTRACTS_ACTIVE = CONTRACTS[ACTIVE_NETWORK]

// ── Polling cadences ──────────────────────────────────────────────────────────
// All refetchInterval values in the app come from here so the cadence is tuned
// in one place. Every query also sets refetchIntervalInBackground: false so
// polling stops when the tab is hidden.

/** Deal room live state: price, units sold, buyer count. */
export const POLL_DEAL_ROOM = 10_000

/** Connected wallet's own order, balances and claimables. */
export const POLL_MY_ORDER = 15_000

/** Deal list, homepage stats, global claims banner. */
export const POLL_LIST = 30_000

/** How often useChainNow re-anchors from a block fetch (ms). */
export const POLL_CHAIN_CLOCK_MS = 60_000

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

/**
 * Explicit EIP-1559 fees for every transaction the app sends. Arc drops a
 * transaction priced below its 20 gwei floor silently -- no error, no receipt --
 * so the fee is not left to the wallet's estimate. maxFeePerGas is a cap, not
 * what is paid: the transaction pays the base fee plus the tip.
 */
export const ARC_TX_FEES = {
  maxFeePerGas: 50_000_000_000n,        // 50 gwei cap, well above the 20 gwei floor
  maxPriorityFeePerGas: 1_000_000_000n, // 1 gwei
} as const

/**
 * Settlers from earlier testnet deployments that may still owe a user USDC
 * (refunds or withdrawals credited before a redeploy). The app shows a claim for
 * any balance left on them. Empty on mainnet.
 */
// ── Goods tokens ──────────────────────────────────────────────────────────────

export interface GoodsToken {
  symbol:   string
  name:     string
  address:  `0x${string}`
  decimals: number
}

/**
 * Tokens offered for sale in Swarm deals, per network.
 * Today: EURC only. Adding a token is one entry here.
 */
export const GOODS_TOKENS: readonly GoodsToken[] = ACTIVE_NETWORK === 'mainnet'
  ? [
      {
        symbol:   'EURC',
        name:     'EURC',
        address:  '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
        decimals: 6,
      },
    ]
  : [
      {
        symbol:   'EURC',
        name:     'EURC',
        address:  '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
        decimals: 6,
      },
    ]

export const RETIRED_SETTLERS: readonly `0x${string}`[] = ACTIVE_NETWORK === 'testnet'
  ? [
      '0x3091FBDc63c96fA37e9f29df5F10B66F47044F44', // v2.1, 25 Oct
      '0xfD29dd3c3003713f529912315F5e47C9c88F8DD3', // v2,   24 Oct
    ]
  : []
