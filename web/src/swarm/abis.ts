/** Swarm v2 contract ABIs — regenerated from compiled contracts */

// ── DealFactory ───────────────────────────────────────────────────────────────

export const DEAL_FACTORY_ABI = [
  // Events
  {
    type: 'event', name: 'DealPosted',
    inputs: [
      { name: 'dealId',     type: 'uint256', indexed: true },
      { name: 'supplier',   type: 'address', indexed: true },
      { name: 'goodsToken', type: 'address', indexed: true },
      { name: 'minUnits',   type: 'uint32',  indexed: false },
      { name: 'maxUnits',   type: 'uint32',  indexed: false },
      { name: 'deadline',   type: 'uint64',  indexed: false },
      { name: 'startPrice', type: 'uint64',  indexed: false },
    ],
  },
  // Read
  {
    type: 'function', name: 'getDeal', stateMutability: 'view',
    inputs: [{ name: 'dealId', type: 'uint256' }],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'supplier',        type: 'address' },
        { name: 'goodsToken',      type: 'address' },
        { name: 'tokensPerUnit',   type: 'uint256' },
        { name: 'tiers', type: 'tuple[]', components: [
          { name: 'minUnits',     type: 'uint32' },
          { name: 'pricePerUnit', type: 'uint64' },
        ]},
        { name: 'minUnits',        type: 'uint32' },
        { name: 'maxUnits',        type: 'uint32' },
        { name: 'maxUnitsPerBuyer',type: 'uint32' },
        { name: 'maxBuyers',       type: 'uint32' },
        { name: 'deadline',        type: 'uint64' },
        { name: 'state',           type: 'uint8'  },
        { name: 'title',           type: 'string' },
        { name: 'description',     type: 'string' },
      ],
    }],
  },
  { type: 'function', name: 'dealCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'paused',    stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  // Write
  {
    type: 'function', name: 'postDeal', stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'p', type: 'tuple',
        components: [
          { name: 'goodsToken',       type: 'address' },
          { name: 'tokensPerUnit',    type: 'uint256' },
          { name: 'minUnits',         type: 'uint32'  },
          { name: 'maxUnits',         type: 'uint32'  },
          { name: 'maxUnitsPerBuyer', type: 'uint32'  },
          { name: 'maxBuyers',        type: 'uint32'  },
          { name: 'deadline',         type: 'uint64'  },
          { name: 'title',            type: 'string'  },
          { name: 'description',      type: 'string'  },
        ],
      },
      { name: 'tiers', type: 'tuple[]', components: [
        { name: 'minUnits',     type: 'uint32' },
        { name: 'pricePerUnit', type: 'uint64' },
      ]},
    ],
    outputs: [{ name: 'dealId', type: 'uint256' }],
  },
  // Admin
  { type: 'function', name: 'pause',   stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'unpause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

// ── DemandPool ────────────────────────────────────────────────────────────────

export const DEMAND_POOL_ABI = [
  // Events
  {
    type: 'event', name: 'Committed',
    inputs: [
      { name: 'dealId',     type: 'uint256', indexed: true },
      { name: 'buyer',      type: 'address', indexed: true },
      { name: 'units',      type: 'uint32',  indexed: false },
      { name: 'paidPerUnit',type: 'uint64',  indexed: false },
      { name: 'escrow',     type: 'uint256', indexed: false },
      { name: 'livePrice',  type: 'uint64',  indexed: false },
      { name: 'totalUnits', type: 'uint32',  indexed: false },
      { name: 'buyerCount', type: 'uint32',  indexed: false },
    ],
  },
  {
    type: 'event', name: 'Withdrawn',
    inputs: [
      { name: 'dealId',        type: 'uint256', indexed: true  },
      { name: 'buyer',         type: 'address', indexed: true  },
      { name: 'units',         type: 'uint32',  indexed: false },
      { name: 'amountReturned',type: 'uint256', indexed: false },
      { name: 'paidDirectly',  type: 'bool',    indexed: false },
      { name: 'livePrice',     type: 'uint64',  indexed: false },
      { name: 'totalUnits',    type: 'uint32',  indexed: false },
      { name: 'buyerCount',    type: 'uint32',  indexed: false },
    ],
  },
  {
    type: 'event', name: 'TierBroken',
    inputs: [
      { name: 'dealId',        type: 'uint256', indexed: true },
      { name: 'newTotalUnits', type: 'uint32',  indexed: false },
      { name: 'newPrice',      type: 'uint64',  indexed: false },
    ],
  },
  {
    type: 'event', name: 'ExcessCredited',
    inputs: [
      { name: 'dealId', type: 'uint256', indexed: true  },
      { name: 'buyer',  type: 'address', indexed: true  },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  // Read
  { type: 'function', name: 'clearingPrice',  stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'getBuyerCount',  stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'getBuyers',      stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'totalUnits',     stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'unitsOf',        stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }, { name: 'buyer', type: 'address' }], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'paidPerUnit',    stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }, { name: 'buyer', type: 'address' }], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'escrowed',       stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }, { name: 'buyer', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tierCount',      stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }, { name: 'price', type: 'uint64' }], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'settlerSet',     stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  {
    type: 'function', name: 'authorizationNonce', stateMutability: 'view',
    inputs: [
      { name: 'dealId', type: 'uint256' },
      { name: 'buyer',  type: 'address' },
      { name: 'units',  type: 'uint32'  },
      { name: 'salt',   type: 'bytes32' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  // Write
  { type: 'function', name: 'commit',   stateMutability: 'nonpayable', inputs: [{ name: 'dealId', type: 'uint256' }, { name: 'units', type: 'uint32' }], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'dealId', type: 'uint256' }, { name: 'units', type: 'uint32' }], outputs: [] },
  {
    type: 'function', name: 'commitWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'dealId',           type: 'uint256' },
      { name: 'buyer',            type: 'address' },
      { name: 'units',            type: 'uint32'  },
      { name: 'authorizedAmount', type: 'uint256' },
      { name: 'validAfter',       type: 'uint256' },
      { name: 'validBefore',      type: 'uint256' },
      { name: 'salt',             type: 'bytes32' },
      { name: 'v',                type: 'uint8'   },
      { name: 'r',                type: 'bytes32' },
      { name: 's',                type: 'bytes32' },
    ],
    outputs: [],
  },
  // Errors
  { type: 'error', name: 'PriceRoseBeyondAuthorization', inputs: [{ name: 'newTotal', type: 'uint256' }] },
  { type: 'error', name: 'AuthorizationAlreadyUsed',     inputs: [] },
  { type: 'error', name: 'Blocklisted',                  inputs: [] },
  { type: 'error', name: 'ZeroUnits',                    inputs: [] },
  { type: 'error', name: 'UnitCapReached',               inputs: [] },
  { type: 'error', name: 'UnitsPerBuyerExceeded',        inputs: [] },
  { type: 'error', name: 'WouldStrandBuyer',             inputs: [] },
  { type: 'error', name: 'WithdrawInvalidUnits',         inputs: [] },
] as const

// ── Settler ───────────────────────────────────────────────────────────────────

export const SETTLER_ABI = [
  // Events
  {
    type: 'event', name: 'Settled',
    inputs: [
      { name: 'dealId',          type: 'uint256', indexed: true  },
      { name: 'clearingPrice',   type: 'uint64',  indexed: false },
      { name: 'totalUnits',      type: 'uint32',  indexed: false },
      { name: 'buyerCount',      type: 'uint32',  indexed: false },
      { name: 'totalRefunds',    type: 'uint256', indexed: false },
      { name: 'unitsDelivered',  type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Refunded',
    inputs: [
      { name: 'dealId', type: 'uint256', indexed: true },
      { name: 'buyer',  type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Claimed',
    inputs: [
      { name: 'claimant', type: 'address', indexed: true },
      { name: 'amount',   type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'GoodsClaimed',
    inputs: [
      { name: 'token',    type: 'address', indexed: true  },
      { name: 'claimant', type: 'address', indexed: true  },
      { name: 'amount',   type: 'uint256', indexed: false },
    ],
  },
  // Read
  { type: 'function', name: 'claimable',      stateMutability: 'view', inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'goodsClaimable', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }] },
  // Write
  { type: 'function', name: 'settle',     stateMutability: 'nonpayable', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'refundAll',  stateMutability: 'nonpayable', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claim',      stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'claimGoods', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }], outputs: [] },
] as const

// ── SwarmPass ─────────────────────────────────────────────────────────────────

export const SWARM_PASS_ABI = [
  { type: 'function', name: 'faucet',   stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'mint',     stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'balanceOf',stateMutability: 'view',       inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'symbol',   stateMutability: 'view',       inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view',       inputs: [], outputs: [{ type: 'uint8'  }] },
  { type: 'function', name: 'name',     stateMutability: 'view',       inputs: [], outputs: [{ type: 'string' }] },
] as const

// ── Generic ERC-20 ────────────────────────────────────────────────────────────
// Minimal surface for reading any goods token

export const ERC20_ABI = [
  { type: 'function', name: 'allowance', stateMutability: 'view',       inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',       inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve',   stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'symbol',    stateMutability: 'view',       inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals',  stateMutability: 'view',       inputs: [], outputs: [{ type: 'uint8'  }] },
  { type: 'function', name: 'name',      stateMutability: 'view',       inputs: [], outputs: [{ type: 'string' }] },
] as const
