/**
 * Event log scanner for the /proof page.
 *
 * Paginates eth_getLogs starting at the deployment block, distinguishing two
 * classes of RPC failure that need different treatment:
 *
 *   "requested range too large" (or similar) — the node rejected our window.
 *     Halve it and retry the same cursor immediately. Never go below MIN_LOG_WINDOW.
 *
 *   "rate limit exceeded" / HTTP 429 — the node is throttling us.
 *     Keep the current window and wait, doubling the delay from RATE_LIMIT_BASE_MS
 *     up to RATE_LIMIT_MAX_MS, then retry.
 *
 * After GROW_AFTER consecutive successes, grow the window by 25% back toward
 * MAX_LOG_WINDOW. This lets the scan speed up again after an early halving.
 *
 * Measured on the Arc Testnet RPC:
 *   - 2,000- and 5,000-block windows accepted with the seven-topic filter.
 *   - 10,000+ returns "requested range too large".
 *   - 20 consecutive back-to-back requests were not rate-limited.
 * So the scanner starts at MAX_LOG_WINDOW = 5,000 and only backs off if the
 * node tells it to.
 */

import { useState, useCallback, useRef } from 'react'
import { decodeEventLog, keccak256, toBytes, type Hex } from 'viem'
import { ARC_NETWORK, CONTRACTS_ACTIVE, MIN_LOG_WINDOW } from './config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI, SETTLER_ABI } from './abis'

/** Largest window to try. Stays ≤ 5,000 per RPC node behaviour. */
const MAX_LOG_WINDOW = 5000n
/** Floor — the node accepts this even for dense event ranges. */
const RATE_LIMIT_BASE_MS = 500
const RATE_LIMIT_MAX_MS  = 16_000
/** Grow the window by this factor after GROW_AFTER consecutive clean fetches. */
const GROW_FACTOR = 1.25
const GROW_AFTER  = 4

// All event topics we care about
const TOPICS = {
  DealPosted:  keccak256(toBytes('DealPosted(uint256,address,uint32,uint64,uint64)')),
  Committed:   keccak256(toBytes('Committed(uint256,address,uint64,uint64,uint32)')),
  Withdrawn:   keccak256(toBytes('Withdrawn(uint256,address,uint64,uint64,uint32)')),
  TierBroken:  keccak256(toBytes('TierBroken(uint256,uint32,uint64)')),
  Settled:     keccak256(toBytes('Settled(uint256,uint64,uint32,uint256)')),
  Refunded:    keccak256(toBytes('Refunded(uint256,address,uint256)')),
  Claimed:     keccak256(toBytes('Claimed(address,uint256)')),
}

const CONTRACT_ADDRS = [
  CONTRACTS_ACTIVE.DealFactory.toLowerCase(),
  CONTRACTS_ACTIVE.DemandPool.toLowerCase(),
  CONTRACTS_ACTIVE.Settler.toLowerCase(),
]

const ALL_TOPIC_HASHES = Object.values(TOPICS)

export interface SwarmEvent {
  type: keyof typeof TOPICS
  blockNumber: bigint
  txHash: string
  logIndex: number
  args: Record<string, unknown>
}

export interface ProofStats {
  totalCommits: bigint
  totalRefunds: bigint
  totalClaimed: bigint
  totalWithdrawn: bigint
  distinctBuyers: Set<string>
  tierBreaks: number
  deals: Map<string, DealProof>
}

export interface DealProof {
  dealId: string
  commitsIn: bigint        // sum of all pricePaid
  supplierCredited: bigint // cp * buyerCount at Settled
  refundsOut: bigint       // sum of Refunded amounts
  settled: boolean
  refunded: boolean
  conserved: boolean | null
}

export type ScanState = 'idle' | 'scanning' | 'done' | 'error'

type JsonRpcResponse<T> = { result: T; error?: undefined } | { result?: undefined; error: { message?: string } }

/** Thrown when the node is rate-limiting (HTTP 429 or message matches). */
class RateLimitError extends Error { constructor(msg: string) { super(msg); this.name = 'RateLimitError' } }
/** Thrown when the requested block range is too wide for this node. */
class RangeTooLargeError extends Error { constructor(msg: string) { super(msg); this.name = 'RangeTooLargeError' } }

async function rpcFetch<T>(method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const r = await fetch(ARC_NETWORK.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  if (r.status === 429) throw new RateLimitError('rate limit exceeded (HTTP 429)')
  const json = await r.json() as JsonRpcResponse<T>
  if (json.error) {
    const msg = json.error.message ?? 'RPC error'
    const low = msg.toLowerCase()
    // Rate-limit before range: the word "limit" appears in both, so match
    // "rate" first to avoid misclassifying a rate-limit as a range error.
    if (low.includes('rate limit') || low.includes('rate_limit') || low.includes('too many requests')) {
      throw new RateLimitError(msg)
    }
    if (low.includes('range') || low.includes('too large') || low.includes('too many blocks')) {
      throw new RangeTooLargeError(msg)
    }
    throw new Error(msg)
  }
  return json.result
}

async function getLatestBlock(): Promise<bigint> {
  const result = await rpcFetch<string>('eth_blockNumber', [])
  return BigInt(result)
}

type RawLog = {
  address: string
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  transactionHash: Hex
  logIndex: Hex
}

async function getLogs(from: bigint, to: bigint): Promise<RawLog[]> {
  return rpcFetch<RawLog[]>('eth_getLogs', [{
    address: [CONTRACTS_ACTIVE.DealFactory, CONTRACTS_ACTIVE.DemandPool, CONTRACTS_ACTIVE.Settler],
    topics: [ALL_TOPIC_HASHES],
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${to.toString(16)}`,
  }])
}

const ALL_ABIS = [...DEAL_FACTORY_ABI, ...DEMAND_POOL_ABI, ...SETTLER_ABI] as const

function decodeLog(raw: RawLog): SwarmEvent | null {
  const topic0 = raw.topics[0]
  let type: keyof typeof TOPICS | undefined
  for (const [k, v] of Object.entries(TOPICS)) {
    if (v.toLowerCase() === topic0?.toLowerCase()) { type = k as keyof typeof TOPICS; break }
  }
  if (!type) return null
  if (!CONTRACT_ADDRS.includes(raw.address.toLowerCase())) return null

  try {
    const decoded = decodeEventLog({
      abi: ALL_ABIS,
      data: raw.data,
      topics: raw.topics as [Hex, ...Hex[]],
    })
    return {
      type,
      blockNumber: BigInt(raw.blockNumber),
      txHash: raw.transactionHash,
      logIndex: Number(raw.logIndex),
      args: decoded.args,
    }
  } catch {
    return null
  }
}

export function useEventLog() {
  const [events, setEvents] = useState<SwarmEvent[]>([])
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [progress, setProgress] = useState({ scanned: 0n, total: 0n, head: 0n })
  const [error, setError] = useState('')
  const abortRef = useRef(false)

  const scan = useCallback(async () => {
    abortRef.current = false
    setScanState('scanning')
    setEvents([])
    setError('')

    try {
      // Refuse rather than scan from genesis. Arc produces a block roughly every
      // 0.5s and the chain is tens of millions of blocks deep, so a zero
      // deployBlock (no deployment recorded for this network) would mean ~15,000
      // eth_getLogs round trips. Same refusal as tools/proof.mjs.
      if (CONTRACTS_ACTIVE.deployBlock === 0n) {
        setScanState('error')
        setError(`No deployment block recorded for ${ARC_NETWORK.name}. Swarm is not deployed on this network yet, and scanning from genesis is not viable on Arc.`)
        return
      }

      const head = await getLatestBlock()
      const start = CONTRACTS_ACTIVE.deployBlock
      const total = head - start
      setProgress({ scanned: 0n, total, head })

      let windowBigInt = MAX_LOG_WINDOW
      let rateLimitDelay = RATE_LIMIT_BASE_MS  // grows on repeated rate-limits, resets on success
      let consecutiveSuccesses = 0
      let cursor = start
      const collected: SwarmEvent[] = []

      while (cursor <= head && !abortRef.current) {
        const to = cursor + windowBigInt - 1n < head ? cursor + windowBigInt - 1n : head

        let raw: RawLog[]
        try {
          raw = await getLogs(cursor, to)
        } catch (e: unknown) {
          if (e instanceof RangeTooLargeError) {
            // Node rejected this window — shrink and retry the same cursor.
            consecutiveSuccesses = 0
            windowBigInt = windowBigInt / 2n
            if (windowBigInt < MIN_LOG_WINDOW) windowBigInt = MIN_LOG_WINDOW
            continue
          }
          if (e instanceof RateLimitError) {
            // Node is throttling — keep window, wait, then retry.
            consecutiveSuccesses = 0
            await new Promise(r => setTimeout(r, rateLimitDelay))
            rateLimitDelay = Math.min(rateLimitDelay * 2, RATE_LIMIT_MAX_MS)
            continue
          }
          throw e
        }

        // Success
        rateLimitDelay = RATE_LIMIT_BASE_MS
        consecutiveSuccesses++
        // Grow window toward MAX_LOG_WINDOW after several clean fetches
        if (consecutiveSuccesses >= GROW_AFTER && windowBigInt < MAX_LOG_WINDOW) {
          windowBigInt = BigInt(Math.min(
            Number(MAX_LOG_WINDOW),
            Math.floor(Number(windowBigInt) * GROW_FACTOR),
          ))
        }

        for (const r of raw) {
          const ev = decodeLog(r)
          if (ev) collected.push(ev)
        }

        // Sort and update state every window
        collected.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex))
        setEvents([...collected])
        setProgress({ scanned: to - start, total, head })

        cursor = to + 1n
      }

      setScanState('done')
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Scan failed')
      setScanState('error')
    }
  }, [])

  const stop = useCallback(() => { abortRef.current = true }, [])

  // Derived stats
  const stats: ProofStats = (() => {
    const s: ProofStats = {
      totalCommits: 0n,
      totalRefunds: 0n,
      totalClaimed: 0n,
      totalWithdrawn: 0n,
      distinctBuyers: new Set(),
      tierBreaks: 0,
      deals: new Map(),
    }

    const getDeal = (id: string): DealProof => {
      if (!s.deals.has(id)) s.deals.set(id, { dealId: id, commitsIn: 0n, supplierCredited: 0n, refundsOut: 0n, settled: false, refunded: false, conserved: null })
      return s.deals.get(id)!
    }

    for (const ev of events) {
      const a = ev.args
      switch (ev.type) {
        case 'Committed': {
          const dealId = String(a.dealId)
          const paid = BigInt(String(a.pricePaid))
          const buyer = String(a.buyer)
          getDeal(dealId).commitsIn += paid
          s.totalCommits += paid
          s.distinctBuyers.add(buyer.toLowerCase())
          break
        }
        case 'Withdrawn': {
          const amt = BigInt(String(a.amountReturned))
          s.totalWithdrawn += amt
          // Withdrawn is not part of settlement; reduce commitsIn for that deal
          const deal = getDeal(String(a.dealId))
          if (deal.commitsIn >= amt) deal.commitsIn -= amt
          break
        }
        case 'TierBroken':
          s.tierBreaks++
          break
        case 'Settled': {
          const dealId = String(a.dealId)
          const cp = BigInt(String(a.clearingPrice))
          const count = BigInt(String(a.buyerCount))
          const deal = getDeal(dealId)
          deal.settled = true
          deal.supplierCredited = cp * count
          break
        }
        case 'Refunded': {
          const dealId = String(a.dealId)
          const amt = BigInt(String(a.amount))
          getDeal(dealId).refundsOut += amt
          s.totalRefunds += amt
          break
        }
        case 'Claimed':
          s.totalClaimed += BigInt(String(a.amount))
          break
      }
    }

    // Conservation check per settled deal
    for (const deal of s.deals.values()) {
      if (deal.settled) {
        // commitsIn (after subtracting withdrawals) == supplierCredited + refundsOut
        deal.conserved = deal.commitsIn === deal.supplierCredited + deal.refundsOut
      }
    }

    return s
  })()

  return { events, scanState, progress, error, stats, scan, stop }
}
