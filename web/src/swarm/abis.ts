/** Swarm contract ABIs — derived from workspace contracts */

export const DEAL_FACTORY_ABI = [
  // Events
  {
    type: 'event', name: 'DealPosted',
    inputs: [
      { name: 'dealId',    type: 'uint256', indexed: true },
      { name: 'supplier',  type: 'address', indexed: true },
      { name: 'minBuyers', type: 'uint32',  indexed: false },
      { name: 'deadline',  type: 'uint64',  indexed: false },
      { name: 'startPrice',type: 'uint64',  indexed: false },
    ],
  },
  // Read
  {
    type: 'function', name: 'getDeal', stateMutability: 'view',
    inputs: [{ name: 'dealId', type: 'uint256' }],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'supplier',  type: 'address' },
        { name: 'tiers',     type: 'tuple[]', components: [
          { name: 'minBuyers',    type: 'uint32' },
          { name: 'pricePerUnit', type: 'uint64' },
        ]},
        { name: 'minBuyers', type: 'uint32' },
        { name: 'deadline',  type: 'uint64' },
        { name: 'cap',       type: 'uint32' },
        { name: 'state',     type: 'uint8' },
      ],
    }],
  },
  { type: 'function', name: 'dealCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'paused',    stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  {
    type: 'function', name: 'postDeal', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tiers',     type: 'tuple[]', components: [
        { name: 'minBuyers',    type: 'uint32' },
        { name: 'pricePerUnit', type: 'uint64' },
      ]},
      { name: 'minBuyers', type: 'uint32' },
      { name: 'deadline',  type: 'uint64' },
      { name: 'cap',       type: 'uint32' },
    ],
    outputs: [{ name: 'dealId', type: 'uint256' }],
  },
] as const

export const DEMAND_POOL_ABI = [
  // Events
  {
    type: 'event', name: 'Committed',
    inputs: [
      { name: 'dealId',     type: 'uint256', indexed: true },
      { name: 'buyer',      type: 'address', indexed: true },
      { name: 'pricePaid',  type: 'uint64',  indexed: false },
      { name: 'livePrice',  type: 'uint64',  indexed: false },
      { name: 'buyerCount', type: 'uint32',  indexed: false },
    ],
  },
  {
    type: 'event', name: 'Withdrawn',
    inputs: [
      { name: 'dealId',          type: 'uint256', indexed: true },
      { name: 'buyer',           type: 'address', indexed: true },
      { name: 'amountReturned',  type: 'uint64',  indexed: false },
      { name: 'livePrice',       type: 'uint64',  indexed: false },
      { name: 'buyerCount',      type: 'uint32',  indexed: false },
    ],
  },
  {
    type: 'event', name: 'TierBroken',
    inputs: [
      { name: 'dealId',       type: 'uint256', indexed: true },
      { name: 'newBuyerCount',type: 'uint32',  indexed: false },
      { name: 'newPrice',     type: 'uint64',  indexed: false },
    ],
  },
  // Read
  { type: 'function', name: 'clearingPrice',  stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'getBuyerCount',  stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'getBuyers',      stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'escrowed',       stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }, { name: 'buyer', type: 'address' }], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'tierCount',      stateMutability: 'view', inputs: [{ name: 'dealId', type: 'uint256' }, { name: 'price', type: 'uint64' }], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'settlerSet',     stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  // Write
  { type: 'function', name: 'commit',   stateMutability: 'nonpayable', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [] },
  {
    type: 'function', name: 'commitWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'dealId',           type: 'uint256' },
      { name: 'buyer',            type: 'address' },
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
  {
    type: 'function', name: 'authorizationNonce', stateMutability: 'view',
    inputs: [
      { name: 'dealId', type: 'uint256' },
      { name: 'buyer',  type: 'address' },
      { name: 'salt',   type: 'bytes32' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  // Events
  {
    type: 'event', name: 'ExcessCredited',
    inputs: [
      { name: 'dealId',  type: 'uint256', indexed: true  },
      { name: 'buyer',   type: 'address', indexed: true  },
      { name: 'amount',  type: 'uint256', indexed: false },
    ],
  },
  // Errors
  { type: 'error', name: 'PriceRoseBeyondAuthorization', inputs: [{ name: 'requiredPrice', type: 'uint64' }] },
  { type: 'error', name: 'AuthorizationAlreadyUsed',     inputs: [] },
  { type: 'error', name: 'Blocklisted',                  inputs: [] },
] as const

export const SETTLER_ABI = [
  // Events
  {
    type: 'event', name: 'Settled',
    inputs: [
      { name: 'dealId',       type: 'uint256', indexed: true },
      { name: 'clearingPrice',type: 'uint64',  indexed: false },
      { name: 'buyerCount',   type: 'uint32',  indexed: false },
      { name: 'totalRefunds', type: 'uint256', indexed: false },
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
  // Read
  { type: 'function', name: 'claimable', stateMutability: 'view', inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }] },
  // Write
  { type: 'function', name: 'settle',    stateMutability: 'nonpayable', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'refundAll', stateMutability: 'nonpayable', inputs: [{ name: 'dealId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claim',     stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

export const ERC20_ABI = [
  { type: 'function', name: 'allowance',   stateMutability: 'view',        inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf',   stateMutability: 'view',        inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve',     stateMutability: 'nonpayable',  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const
