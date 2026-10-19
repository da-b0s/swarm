// Swarm event signatures.
//
// These mirror exactly what studio/prompts/turn-01-contracts.md asked Arc Studio
// to emit. They are a DECLARED contract, not a discovered one: once the real
// contracts are pulled into ../onchain, proof.mjs prefers the ABIs found there and
// falls back to these. Reconcile and delete the guesswork after Turn 1.
export const SWARM_EVENTS = [
  'event DealPosted(uint256 indexed dealId, address indexed supplier, uint256 minBuyers, uint256 deadline, uint256 startPrice)',
  'event Committed(uint256 indexed dealId, address indexed buyer, uint256 pricePaid, uint256 livePrice, uint256 buyerCount)',
  'event Withdrawn(uint256 indexed dealId, address indexed buyer, uint256 refunded, uint256 livePrice, uint256 buyerCount)',
  'event TierBroken(uint256 indexed dealId, uint256 tierIndex, uint256 newPrice, uint256 buyerCount)',
  'event Settled(uint256 indexed dealId, uint256 clearingPrice, uint256 buyerCount)',
  'event Refunded(uint256 indexed dealId, address indexed buyer, uint256 amount)',
  'event Claimed(address indexed account, uint256 amount)',
];

export const ARC = {
  mainnet: {
    id: 5042,
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    emitter: '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE',
  },
  testnet: {
    id: 5042002,
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    emitter: '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE',
  },
};
