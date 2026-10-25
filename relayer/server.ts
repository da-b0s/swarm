/**
 * Swarm Gasless Relayer
 *
 * POST /commit  — simulate, screen, relay a commitWithAuthorization call
 * GET  /health  — chain id, pool address, relayer address, USDC balance
 *
 * Environment:
 *   RELAYER_KEY     — hex private key (never logged, never returned)
 *   RPC_URL         — Arc RPC endpoint
 *   CHAIN_ID        — expected chain id (numeric)
 *   POOL_ADDRESS    — deployed DemandPool address
 *   ALLOWED_ORIGIN  — CORS origin allowed (default: refuse all cross-origin requests)
 *   PORT            — HTTP port (default 3100)
 */

import http from 'node:http'
import fs   from 'node:fs'
import path from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  parseAbi,
  formatUnits,
  type Hex,
  type Chain,
  type Account,
  ContractFunctionRevertedError,
  keccak256,
  toBytes,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ── Startup config ────────────────────────────────────────────────────────────

function required(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1) }
  return v
}

const RELAYER_KEY   = required('RELAYER_KEY') as Hex
const RPC_URL       = required('RPC_URL')
const CHAIN_ID      = parseInt(required('CHAIN_ID'), 10)
const POOL_ADDRESS  = required('POOL_ADDRESS') as Hex
// Default to empty string (refuse cross-origin). Set ALLOWED_ORIGIN explicitly
// for any deployment that accepts browser requests.
const ALLOWED_ORIGIN = process.env['ALLOWED_ORIGIN'] ?? ''
const PORT          = parseInt(process.env['PORT'] ?? '3100', 10)
const LOG_FILE      = process.env['LOG_FILE'] ?? 'relay-log.jsonl'

// Safety: never log the key itself, not even partially.
if (RELAYER_KEY.toLowerCase().includes('relayer_key')) {
  console.error('RELAYER_KEY looks like a template placeholder, refusing to start.')
  process.exit(1)
}

// ── Chain definition ──────────────────────────────────────────────────────────

const arcChain: Chain = {
  id: CHAIN_ID,
  name: `Arc (${CHAIN_ID})`,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
}

const account: Account = privateKeyToAccount(RELAYER_KEY)

const publicClient = createPublicClient({
  chain: arcChain,
  transport: viemHttp(RPC_URL),
})

const walletClient = createWalletClient({
  account,
  chain: arcChain,
  transport: viemHttp(RPC_URL),
})

// ── ABI fragments ─────────────────────────────────────────────────────────────

// v2 ABI — units added to commitWithAuthorization and Committed event;
// PriceRoseBeyondAuthorization now carries the new total (uint256) not a per-unit price.
const POOL_ABI = parseAbi([
  'function commitWithAuthorization(uint256 dealId, address buyer, uint32 units, uint256 authorizedAmount, uint256 validAfter, uint256 validBefore, bytes32 salt, uint8 v, bytes32 r, bytes32 s) external',
  'event Committed(uint256 indexed dealId, address indexed buyer, uint32 units, uint64 paidPerUnit, uint256 escrow, uint64 livePrice, uint32 totalUnits, uint32 buyerCount)',
  'event ExcessCredited(uint256 indexed dealId, address indexed buyer, uint256 amount)',
  'error AlreadyCommitted()',
  'error AuthorizationAlreadyUsed()',
  'error Blocklisted()',
  'error BuyerCapReached()',
  'error DeadlinePassed()',
  'error DealNotOpen()',
  'error Paused()',
  'error PriceRoseBeyondAuthorization(uint256 newTotal)',
  'error SettlerNotConfigured()',
  'error WouldStrandBuyer()',
  'error ZeroUnits()',
  'error UnitCapReached()',
  'error UnitsPerBuyerExceeded()',
])

const USDC_ABI = parseAbi([
  'function isBlacklisted(address) external view returns (bool)',
  'function balanceOf(address) external view returns (uint256)',
])

// Known USDC address on Arc (both mainnet and testnet).
const USDC_ADDRESS: Hex = '0x3600000000000000000000000000000000000000'

// ── Nonce manager ─────────────────────────────────────────────────────────────
// Serialises sends through a promise chain so concurrent requests never take
// the same nonce.  The chain is kept alive even when an individual send fails
// (fix #2: catch on the inner run, not the outer chain).
// On any send failure the nonce is reset to null so the next send re-reads
// getTransactionCount with the pending block, skipping any gap (fix #3).

let nextNonce: number | null = null
let sendMutex: Promise<void> = Promise.resolve()

async function resolveNonce(): Promise<number> {
  if (nextNonce === null) {
    nextNonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    })
  }
  return nextNonce
}

function consumeNonce(): number {
  if (nextNonce === null) throw new Error('Nonce not initialised')
  const n = nextNonce
  nextNonce = n + 1
  return n
}

function resetNonce(): void {
  nextNonce = null
}

// ── Rate limiting per buyer ────────────────────────────────────────────────────

const buyerRequests = new Map<string, { count: number; resetAt: number }>()
const MAX_PER_BUYER_PER_HOUR = 10
const WINDOW_MS = 60 * 60 * 1000

function checkRateLimit(buyer: string): { ok: true } | { ok: false; message: string } {
  const now = Date.now()
  const key  = buyer.toLowerCase()
  const rec  = buyerRequests.get(key)
  if (!rec || rec.resetAt < now) {
    buyerRequests.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return { ok: true }
  }
  if (rec.count >= MAX_PER_BUYER_PER_HOUR) {
    return { ok: false, message: `Rate limit: max ${MAX_PER_BUYER_PER_HOUR} commits per buyer per hour` }
  }
  rec.count++
  return { ok: true }
}

// ── Fee helpers ────────────────────────────────────────────────────────────────
// On Arc a transaction with maxFeePerGas below 20 gwei silently vanishes.

const MIN_GAS_PRICE = 20_000_000_000n // 20 gwei
const GAS_BUMP_BPS  = 120n            // 20% bump for replacement (EIP-1559 requires ≥10%)

async function currentMaxFeePerGas(): Promise<bigint> {
  const feeData = await publicClient.estimateFeesPerGas()
  const suggested = feeData.maxFeePerGas ?? MIN_GAS_PRICE
  return suggested < MIN_GAS_PRICE ? MIN_GAS_PRICE : suggested
}

function bumpFee(fee: bigint): bigint {
  const bumped = (fee * GAS_BUMP_BPS) / 100n
  return bumped < MIN_GAS_PRICE ? MIN_GAS_PRICE : bumped
}

// ── Relay log ────────────────────────────────────────────────────────────────

function appendRelayLog(entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      path.isAbsolute(LOG_FILE) ? LOG_FILE : path.join(process.cwd(), LOG_FILE),
      JSON.stringify(entry) + '\n',
    )
  } catch {
    // Log write failure is non-fatal.
  }
}

// ── commitWithAuthorization request body ──────────────────────────────────────

interface CommitBody {
  dealId: string
  buyer: Hex
  units: number   // v2: number of units the buyer is ordering
  authorizedAmount: string
  validAfter: string
  validBefore: string
  salt: Hex
  signature: Hex  // packed 65-byte sig (r+s+v)
}

function splitSig(sig: Hex): { v: number; r: Hex; s: Hex } {
  // Accept packed 65-byte sig: r(32) + s(32) + v(1)
  const raw = sig.startsWith('0x') ? sig.slice(2) : sig
  if (raw.length !== 130) throw new Error('signature must be 65 bytes (130 hex chars)')
  const r = `0x${raw.slice(0, 64)}`  as Hex
  const s = `0x${raw.slice(64, 128)}` as Hex
  const v = parseInt(raw.slice(128, 130), 16)
  return { v, r, s }
}

// ── Core relay logic ──────────────────────────────────────────────────────────

interface RelayResult {
  txHash: Hex
  units: number
  paidPerUnit: bigint
  escrow: bigint
  excessCredited: bigint
  gasUsdcCost: string
}

async function relay(body: CommitBody): Promise<RelayResult> {
  const { v, r, s } = splitSig(body.signature)
  const dealId           = BigInt(body.dealId)
  const units            = body.units              // v2: uint32
  const authorizedAmount = BigInt(body.authorizedAmount)
  const validAfter       = BigInt(body.validAfter)
  const validBefore      = BigInt(body.validBefore)
  const buyer            = body.buyer
  const salt             = body.salt

  // 1. Screen for blacklisted addresses before simulating.
  const [buyerBlocked, relayerBlocked] = await Promise.all([
    publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'isBlacklisted', args: [buyer] }),
    publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'isBlacklisted', args: [account.address] }),
  ])
  if (buyerBlocked)   throw Object.assign(new Error('Buyer address is USDC-blacklisted'), { code: 'Blocklisted' })
  if (relayerBlocked) throw Object.assign(new Error('Relayer address is USDC-blacklisted'), { code: 'Blocklisted' })

  // 2. Simulate — never broadcast a call you can already tell will revert.
  //    Also estimate gas here so we don't hardcode a limit.
  let estimatedGas: bigint
  try {
    const sim = await publicClient.simulateContract({
      address: POOL_ADDRESS,
      abi: POOL_ABI,
      functionName: 'commitWithAuthorization',
      args: [dealId, buyer, units, authorizedAmount, validAfter, validBefore, salt, v, r as Hex, s as Hex],
      account: account.address,
    })
    // estimateContractGas gives a tighter figure; add 20% safety margin.
    const raw = await publicClient.estimateContractGas({
      address: POOL_ADDRESS,
      abi: POOL_ABI,
      functionName: 'commitWithAuthorization',
      args: [dealId, buyer, units, authorizedAmount, validAfter, validBefore, salt, v, r as Hex, s as Hex],
      account: account.address,
    })
    estimatedGas = (raw * 120n) / 100n
    void sim  // simulation succeeded; we only needed the revert check
  } catch (e: unknown) {
    // viem throws ContractFunctionExecutionError wrapping a ContractFunctionRevertedError.
    // Walk the cause chain to find the revert; its .data is already decoded by viem.
    const revertErr = (e as { walk?: (pred: (err: unknown) => boolean) => unknown })
      .walk?.(err => err instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | undefined

    if (revertErr?.data) {
      const { errorName, args: errorArgs } = revertErr.data
      // USDC rejects a signature that does not match with a plain-text revert,
      // which viem decodes as the generic 'Error'. Name it for the client: it
      // means the signed values (amount, quantity, deal) were changed.
      const code = errorName === 'Error' ? 'InvalidAuthorization' : errorName
      throw Object.assign(new Error(`Contract revert: ${code}`), {
        code,
        args: errorArgs,
      })
    }
    // Not a decoded contract revert — re-throw as an opaque relay failure so
    // the HTTP layer returns 500 without leaking viem internals to the client.
    throw Object.assign(new Error('Simulation failed'), { code: 'SimulationFailed' })
  }

  // 3. Send — serialised through the mutex so concurrent requests never take
  //    the same nonce.  Pattern: `run` is the actual work; `sendMutex` is
  //    chained on a silenced copy so a failure in `run` doesn't poison later
  //    requests (fix #2).
  const CONFIRMATION_TIMEOUT_MS = 90_000
  const REPLACE_INTERVAL_MS     = 30_000   // how long between bumps (fix #4)
  const MAX_FEE_MULTIPLIER      = 5n       // cap bumps at 5× initial fee (fix #4)

  // Collects every hash sent for this nonce so we recognise whichever is mined (fix #5).
  const allHashes: Hex[] = []
  let   sendError: unknown = null

  const work = async (): Promise<void> => {
    await resolveNonce()
    const nonce     = consumeNonce()
    const initFee   = await currentMaxFeePerGas()
    const feeCap    = (initFee * MAX_FEE_MULTIPLIER)
    let   curFee    = initFee

    const sendAtFee = async (fee: bigint): Promise<Hex> => {
      try {
        const h = await walletClient.writeContract({
          address: POOL_ADDRESS,
          abi: POOL_ABI,
          functionName: 'commitWithAuthorization',
          args: [dealId, buyer, units, authorizedAmount, validAfter, validBefore, salt, v, r as Hex, s as Hex],
          nonce,
          maxFeePerGas: fee,
          maxPriorityFeePerGas: 0n,
          gas: estimatedGas,
        })
        allHashes.push(h)
        return h
      } catch (e) {
        resetNonce()   // gap: nonce was never accepted; re-read on next call (fix #3)
        throw e
      }
    }

    await sendAtFee(curFee)

    const deadline    = Date.now() + CONFIRMATION_TIMEOUT_MS
    let   nextReplace = Date.now() + REPLACE_INTERVAL_MS

    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 2_000))

      // Check every hash we have ever sent for this nonce (fix #5).
      for (const h of allHashes) {
        const receipt = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null)
        if (receipt) return  // confirmed — whichever hash it was
      }

      if (Date.now() >= nextReplace && curFee < feeCap) {
        curFee = bumpFee(curFee)
        if (curFee > feeCap) curFee = feeCap
        // Advance the timer whether the replacement succeeds or throws — so a
        // rejected send doesn't cause repeated bump attempts every 2 seconds.
        nextReplace = Date.now() + REPLACE_INTERVAL_MS
        try {
          await sendAtFee(curFee)
        } catch {
          // Replacement rejected; keep polling existing hashes.
        }
      }
    }

    throw new Error(`Transaction not confirmed within ${CONFIRMATION_TIMEOUT_MS / 1000}s`)
  }

  const run = sendMutex.then(work)
  sendMutex = run.catch(() => {})   // keep the chain alive for the next caller (fix #2)

  try {
    await run
  } catch (e) {
    sendError = e
  }

  if (sendError) throw sendError

  // 4. Find the confirmed receipt among all hashes we sent (fix #5).
  let txHash: Hex = allHashes[0]!
  let confirmedReceipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>> | null = null
  for (const h of allHashes) {
    const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null)
    if (r) { txHash = h; confirmedReceipt = r; break }
  }
  if (!confirmedReceipt) {
    // Shouldn't happen if the loop above returned, but be safe.
    confirmedReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 })
  }
  const receipt  = confirmedReceipt
  const gasPrice = receipt.effectiveGasPrice ?? MIN_GAS_PRICE

  // 5. Parse Committed and ExcessCredited from the receipt logs.
  //
  // v2 Committed(uint256 indexed dealId, address indexed buyer,
  //              uint32 units, uint64 paidPerUnit, uint256 escrow,
  //              uint64 livePrice, uint32 totalUnits, uint32 buyerCount)
  //
  // Non-indexed data layout (each slot = 32 bytes, big-endian):
  //   [0]  units      (uint32  → right-aligned in 32 bytes)
  //   [1]  paidPerUnit(uint64  → right-aligned)
  //   [2]  escrow     (uint256 → full 32 bytes)
  //   [3]  livePrice  (uint64)
  //   [4]  totalUnits (uint32)
  //   [5]  buyerCount (uint32)
  //
  // ExcessCredited(uint256 indexed dealId, address indexed buyer, uint256 amount)
  //   [0]  amount (uint256)
  //
  // Topic hashes, computed from the v2 event signatures rather than typed in:
  // a hand-written hash here once never matched, so every relayed order was
  // reported back as 0 units and $0 paid.
  const COMMITTED_TOPIC = keccak256(toBytes('Committed(uint256,address,uint32,uint64,uint256,uint64,uint32,uint32)')).toLowerCase()
  const EXCESS_TOPIC    = keccak256(toBytes('ExcessCredited(uint256,address,uint256)')).toLowerCase()

  let committedUnits: number  = 0
  let paidPerUnit:  bigint    = 0n
  let escrow:       bigint    = 0n
  let excessCredited: bigint  = 0n

  for (const log of receipt.logs) {
    try {
      const t0  = log.topics[0]?.toLowerCase()
      const raw = (log.data ?? '0x').slice(2) // strip 0x; each word is 64 hex chars

      if (t0 === COMMITTED_TOPIC) {
        // Slot 0: units (uint32, right-aligned)
        committedUnits = parseInt(raw.slice(0, 64),   16)
        // Slot 1: paidPerUnit (uint64, right-aligned)
        paidPerUnit    = BigInt('0x' + raw.slice(64,  128))
        // Slot 2: escrow (uint256, full word)
        escrow         = BigInt('0x' + raw.slice(128, 192))
      } else if (t0 === EXCESS_TOPIC) {
        // Slot 0: amount (uint256)
        excessCredited = BigInt('0x' + raw.slice(0, 64))
      }
    } catch { /* skip unparseable logs */ }
  }

  // 6. Compute gas cost in USDC: gasUsed * effectiveGasPrice / 1e12 (18→6 dec).
  //    effectiveGasPrice is taken from the receipt, not the fee we sent.
  const gasUsed         = receipt.gasUsed
  const effectivePrice  = receipt.effectiveGasPrice ?? gasPrice
  const gasUsdcCost     = formatUnits((gasUsed * effectivePrice) / 1_000_000_000_000n, 6)

  // 7. Append relay log (never log the key or signature).
  appendRelayLog({
    ts:             new Date().toISOString(),
    dealId:         body.dealId,
    buyer:          buyer,
    units:          committedUnits,
    txHash,
    block:          receipt.blockNumber.toString(),
    paidPerUnit:    paidPerUnit.toString(),
    escrow:         escrow.toString(),
    excessCredited: excessCredited.toString(),
    gasUsdcCost,
  })

  return { txHash, units: committedUnits, paidPerUnit, escrow, excessCredited, gasUsdcCost }
}

// ── HTTP server ────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(data)
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    try {
      const [chainId, rawBalance] = await Promise.all([
        publicClient.getChainId(),
        publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] }),
      ])
      // Verify chain matches expectation.
      if (chainId !== CHAIN_ID) {
        json(res, 503, { error: `Chain mismatch: expected ${CHAIN_ID}, got ${chainId}` })
        return
      }
      json(res, 200, {
        chainId,
        poolAddress:     POOL_ADDRESS,
        relayerAddress:  account.address,
        usdcBalance:     formatUnits(rawBalance, 6),
      })
    } catch (e) {
      json(res, 503, { error: (e as Error).message })
    }
    return
  }

  // POST /commit
  if (req.method === 'POST' && req.url === '/commit') {
    let body: CommitBody
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        let buf = ''
        req.on('data', (chunk: Buffer) => { buf += chunk.toString() })
        req.on('end',  () => resolve(buf))
        req.on('error', reject)
      })
      body = JSON.parse(raw) as CommitBody
    } catch {
      json(res, 400, { error: 'Invalid JSON body' })
      return
    }

    // Validate required fields — check for absent/null/empty-string only;
    // numeric zero ("0" or 0) is a valid value (e.g. validAfter).
    const required_fields = ['dealId', 'buyer', 'authorizedAmount', 'validAfter', 'validBefore', 'salt', 'signature'] as const
    for (const f of required_fields) {
      const v = body[f]
      if (v === undefined || v === null || v === '') {
        json(res, 400, { error: `Missing field: ${f}` }); return
      }
    }
    // units is a required v2 field — allow 0 check separately (must be ≥ 1).
    if (body.units === undefined || body.units === null) {
      json(res, 400, { error: 'Missing field: units' }); return
    }
    if (!Number.isInteger(body.units) || body.units < 1) {
      json(res, 400, { error: 'units must be a positive integer' }); return
    }

    // Rate limit per buyer.
    const rl = checkRateLimit(body.buyer)
    if (!rl.ok) { json(res, 429, { error: rl.message }); return }

    try {
      const result = await relay(body)
      json(res, 200, {
        txHash:         result.txHash,
        units:          result.units,
        paidPerUnit:    result.paidPerUnit.toString(),
        escrow:         result.escrow.toString(),
        excessCredited: result.excessCredited.toString(),
        gasUsdcCost:    result.gasUsdcCost,
      })
    } catch (e: unknown) {
      const err = e as { code?: string; args?: unknown[]; message?: string }
      // Named contract errors: return structured responses the frontend can act on.
      // v2: PriceRoseBeyondAuthorization carries newTotal (the new required total, not per-unit price).
      if (err.code === 'PriceRoseBeyondAuthorization' && Array.isArray(err.args) && err.args.length > 0) {
        json(res, 409, { error: 'PriceRoseBeyondAuthorization', requiredTotal: err.args[0]?.toString() })
        return
      }
      if (err.code === 'Blocklisted') {
        json(res, 403, { error: 'Blocklisted' })
        return
      }
      if (err.code && err.code !== 'SimulationFailed') {
        // Other named contract errors (AlreadyCommitted, DeadlinePassed, etc.) — name only, no viem text.
        json(res, 400, { error: err.code })
        return
      }
      // Unrecognised error: log detail server-side only, return opaque 500 to caller.
      console.error('[relay error]', err.message ?? String(e))
      json(res, 500, { error: 'Relay failed' })
    }
    return
  }

  json(res, 404, { error: 'Not found' })
})

// ── Startup chain-id check ─────────────────────────────────────────────────────

const liveChainId = await publicClient.getChainId()
if (liveChainId !== CHAIN_ID) {
  console.error(`Chain ID mismatch: CHAIN_ID=${CHAIN_ID} but RPC reports ${liveChainId}. Refusing to start.`)
  process.exit(1)
}

server.listen(PORT, () => {
  const originLabel = ALLOWED_ORIGIN || '(none — cross-origin requests refused)'
  console.log(`Swarm relayer listening on port ${PORT}`)
  console.log(`  chain    ${CHAIN_ID}`)
  console.log(`  pool     ${POOL_ADDRESS}`)
  console.log(`  relayer  ${account.address}`)
  console.log(`  origin   ${originLabel}`)
})
