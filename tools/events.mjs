// Swarm event signatures.
//
// Reconciled against the compiled ABIs pulled from Studio (onchain/contracts/out),
// not guessed: types and parameter names below match the deployed contracts exactly.
// proof.mjs still prefers the ABIs it discovers under ../onchain and uses these only
// as a fallback, so keep them in step when the contracts change.
//
// Note the widths: prices and per-buyer amounts are uint64 micro-USDC, buyer counts
// are uint32, and only the claimable/refund totals widen to uint256.
export const SWARM_EVENTS = [
  'event DealPosted(uint256 indexed dealId, address indexed supplier, uint32 minBuyers, uint64 deadline, uint64 startPrice)',
  'event Committed(uint256 indexed dealId, address indexed buyer, uint64 pricePaid, uint64 livePrice, uint32 buyerCount)',
  'event Withdrawn(uint256 indexed dealId, address indexed buyer, uint64 amountReturned, uint64 livePrice, uint32 buyerCount)',
  'event TierBroken(uint256 indexed dealId, uint32 newBuyerCount, uint64 newPrice)',
  'event Settled(uint256 indexed dealId, uint64 clearingPrice, uint32 buyerCount, uint256 totalRefunds)',
  'event Refunded(uint256 indexed dealId, address indexed buyer, uint256 amount)',
  'event Claimed(address indexed claimant, uint256 amount)',
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
