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
 *   ALLOWED_ORIGIN  — CORS origin (default *)
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
  decodeErrorResult,
  formatUnits,
  type Hex,
  type Chain,
  type Account,
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
const ALLOWED_ORIGIN = process.env['ALLOWED_ORIGIN'] ?? '*'
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

const POOL_ABI = parseAbi([
  'function commitWithAuthorization(uint256 dealId, address buyer, uint256 authorizedAmount, uint256 validAfter, uint256 validBefore, bytes32 salt, uint8 v, bytes32 r, bytes32 s) external',
  'event Committed(uint256 indexed dealId, address indexed buyer, uint64 pricePaid, uint64 livePrice, uint32 buyerCount)',
  'event ExcessCredited(uint256 indexed dealId, address indexed buyer, uint256 amount)',
  'error AlreadyCommitted()',
  'error AuthorizationAlreadyUsed()',
  'error Blocklisted()',
  'error BuyerCapReached()',
  'error DeadlinePassed()',
  'error DealNotOpen()',
  'error Paused()',
  'error PriceRoseBeyondAuthorization(uint64 requiredPrice)',
  'error SettlerNotConfigured()',
  'error WouldStrandBuyer()',
])

const USDC_ABI = parseAbi([
  'function isBlacklisted(address) external view returns (bool)',
  'function balanceOf(address) external view returns (uint256)',
])

// Known USDC address on Arc (both mainnet and testnet).
const USDC_ADDRESS: Hex = '0x3600000000000000000000000000000000000000'

// ── Nonce manager ─────────────────────────────────────────────────────────────
// Tracks the nonce explicitly so concurrent requests don't collide.
// A mutex (promise chain) serialises sends — only one in-flight at a time.

let nextNonce: number | null = null
let sendMutex = Promise.resolve()

async function getNextNonce(): Promise<number> {
  if (nextNonce === null) {
    nextNonce = await publicClient.getTransactionCount({ address: account.address })
  }
  return nextNonce
}

function consumeNonce(): number {
  if (nextNonce === null) throw new Error('Nonce not initialised')
  const n = nextNonce
  nextNonce = n + 1
  return n
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
  authorizedAmount: string
  validAfter: string
  validBefore: string
  salt: Hex
  signature: Hex  // packed 65-byte sig (r+s+v) OR object {v,r,s}
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
  pricePaid: bigint
  excessCredited: bigint
  gasUsdcCost: string
}

async function relay(body: CommitBody): Promise<RelayResult> {
  const { v, r, s } = splitSig(body.signature)
  const dealId           = BigInt(body.dealId)
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
  try {
    await publicClient.simulateContract({
      address: POOL_ADDRESS,
      abi: POOL_ABI,
      functionName: 'commitWithAuthorization',
      args: [dealId, buyer, authorizedAmount, validAfter, validBefore, salt, v, r as Hex, s as Hex],
      account: account.address,
    })
  } catch (e: unknown) {
    // Try to decode a named contract error from the simulation revert.
    const errData = (e as { cause?: { data?: Hex } })?.cause?.data
    if (errData) {
      try {
        const decoded = decodeErrorResult({ abi: POOL_ABI, data: errData })
        const err = Object.assign(new Error(`Contract revert: ${decoded.errorName}`), {
          code: decoded.errorName,
          args: decoded.args,
        })
        throw err
      } catch (decodeErr) {
        if ((decodeErr as { code?: string }).code) throw decodeErr
        // Decode failed: fall through and throw the raw simulation error.
      }
    }
    throw e
  }

  // 3. Send — serialised through the mutex so two concurrent requests cannot
  //    take the same nonce. We capture txHash and the final gasPrice for the
  //    receipt lookup and cost calculation below.
  const sendResult = { txHash: '' as Hex, gasPrice: MIN_GAS_PRICE }

  sendMutex = sendMutex.then(async () => {
    await getNextNonce()
    const nonce = consumeNonce()
    sendResult.gasPrice = await currentMaxFeePerGas()

    const CONFIRMATION_TIMEOUT_MS = 60_000
    const REPLACE_AFTER_MS        = 30_000

    const sendAtFee = async (fee: bigint): Promise<Hex> =>
      walletClient.writeContract({
        address: POOL_ADDRESS,
        abi: POOL_ABI,
        functionName: 'commitWithAuthorization',
        args: [dealId, buyer, authorizedAmount, validAfter, validBefore, salt, v, r as Hex, s as Hex],
        nonce,
        maxFeePerGas: fee,
        maxPriorityFeePerGas: 0n,
        gas: 300_000n,
      })

    sendResult.txHash = await sendAtFee(sendResult.gasPrice)

    // Wait for confirmation; if it stalls, replace at a higher fee.
    const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS
    const replaceAt = Date.now() + REPLACE_AFTER_MS

    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 2000))
      const receipt = await publicClient.getTransactionReceipt({ hash: sendResult.txHash }).catch(() => null)
      if (receipt) return // confirmed

      if (Date.now() >= replaceAt) {
        sendResult.gasPrice = bumpFee(sendResult.gasPrice)
        try {
          sendResult.txHash = await sendAtFee(sendResult.gasPrice)
        } catch {
          // If replacement fails, keep waiting for the original.
        }
      }
    }
  })

  await sendMutex
  const txHash = sendResult.txHash
  const gasPrice = sendResult.gasPrice

  // 4. Wait for the confirmed receipt.
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 })

  // 5. Parse Committed and ExcessCredited from the receipt logs.
  let pricePaid: bigint       = 0n
  let excessCredited: bigint  = 0n

  // keccak256 topic hashes (verified against the compiled ABI):
  //   Committed(uint256,address,uint64,uint64,uint32)
  //   ExcessCredited(uint256,address,uint256)
  const COMMITTED_TOPIC = '0x201b52d75ed359a2ae4baad1623cdef768038c57814a0a946233d073c8f470f6'
  const EXCESS_TOPIC    = '0x3cfc150e50c4024ef3086c288297f0b4d66863e163f546bcc0871098df534b41'

  for (const log of receipt.logs) {
    try {
      const t0 = log.topics[0]?.toLowerCase()
      if (t0 === COMMITTED_TOPIC) {
        // pricePaid is the first non-indexed arg (uint64), packed into first word of data
        pricePaid = BigInt('0x' + (log.data ?? '0x').slice(2, 66))
      } else if (t0 === EXCESS_TOPIC) {
        // amount is the only non-indexed arg (uint256), first 32 bytes of data
        excessCredited = BigInt('0x' + (log.data ?? '0x').slice(2, 66))
      }
    } catch { /* skip unparseable logs */ }
  }

  // 6. Compute gas cost in USDC: gasUsed * effectiveGasPrice / 1e12 (18→6 dec).
  const gasUsed         = receipt.gasUsed
  const effectivePrice  = receipt.effectiveGasPrice ?? gasPrice
  const gasUsdcCost     = formatUnits((gasUsed * effectivePrice) / 1_000_000_000_000n, 6)

  // 7. Append relay log (never log the key or signature).
  appendRelayLog({
    ts:             new Date().toISOString(),
    dealId:         body.dealId,
    buyer:          buyer,
    txHash,
    block:          receipt.blockNumber.toString(),
    pricePaid:      pricePaid.toString(),
    excessCredited: excessCredited.toString(),
    gasUsdcCost,
  })

  return { txHash, pricePaid, excessCredited, gasUsdcCost }
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

    // Validate required fields.
    const required_fields = ['dealId', 'buyer', 'authorizedAmount', 'validAfter', 'validBefore', 'salt', 'signature'] as const
    for (const f of required_fields) {
      if (!body[f]) { json(res, 400, { error: `Missing field: ${f}` }); return }
    }

    // Rate limit per buyer.
    const rl = checkRateLimit(body.buyer)
    if (!rl.ok) { json(res, 429, { error: rl.message }); return }

    try {
      const result = await relay(body)
      json(res, 200, {
        txHash:         result.txHash,
        pricePaid:      result.pricePaid.toString(),
        excessCredited: result.excessCredited.toString(),
        gasUsdcCost:    result.gasUsdcCost,
      })
    } catch (e: unknown) {
      const err = e as { code?: string; args?: unknown[]; message?: string }
      if (err.code === 'PriceRoseBeyondAuthorization' && Array.isArray(err.args) && err.args.length > 0) {
        json(res, 409, { error: 'PriceRoseBeyondAuthorization', requiredPrice: err.args[0]?.toString() })
        return
      }
      if (err.code === 'Blocklisted') {
        json(res, 403, { error: 'Blocklisted' })
        return
      }
      json(res, 400, { error: err.message ?? 'Relay failed', code: err.code })
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
  console.log(`Swarm relayer listening on port ${PORT} (chain ${CHAIN_ID}, pool ${POOL_ADDRESS}, relayer ${account.address})`)
})
