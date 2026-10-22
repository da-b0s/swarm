/**
 * Event log scanner for the /proof page.
 *
 * Paginates eth_getLogs starting at the deployment block, distinguishing two
 * classes of RPC failure that need different treatment:
 *
 *   RangeTooLargeError — node rejected the window.
 *     Halve it and retry the same cursor immediately.
 *     If already at SCAN_MIN_WINDOW, surface as a real error rather than
 *     looping forever.
 *
 *   RateLimitError — node is throttling us (HTTP 429 or message).
 *     Keep window, wait with exponential back-off (RATE_BASE_MS → RATE_MAX_MS),
 *     then retry.
 *
 * After GROW_AFTER consecutive successes the window grows back toward
 * SCAN_MAX_WINDOW so the scan speeds up again after an early halving.
 *
 * Conservation model
 * ──────────────────
 * settle():   emits Settled(dealId, clearingPrice, buyerCount, totalRefunds)
 *             No per-buyer Refunded events.
 *             Invariant: commitsIn = supplierCredited + totalRefunds
 *
 * refundAll(): emits one Refunded(dealId, buyer, amount) per buyer.
 *              No Settled event.
 *              Invariant: commitsIn = sum(Refunded.amount), supplierCredited = 0
 *
 * So the Settled case must read totalRefunds from the event args; the Refunded
 * case must mark deal.refunded = true so the conservation check fires for it.
 */

import { useState, useCallback, useRef } from 'react'
import { decodeEventLog, keccak256, toBytes, type Hex } from 'viem'
import { ARC_NETWORK, CONTRACTS_ACTIVE } from './config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI, SETTLER_ABI } from './abis'
import {
  rpcFetch, getLatestBlock,
  RateLimitError, RangeTooLargeError,
  SCAN_MAX_WINDOW, SCAN_MIN_WINDOW,
  RATE_BASE_MS, RATE_MAX_MS,
  GROW_AFTER, growWindow,
} from './rpc'

// ── Event topic hashes ────────────────────────────────────────────────────────

const TOPICS = {
  DealPosted:     keccak256(toBytes('DealPosted(uint256,address,uint32,uint64,uint64)')),
  Committed:      keccak256(toBytes('Committed(uint256,address,uint64,uint64,uint32)')),
  Withdrawn:      keccak256(toBytes('Withdrawn(uint256,address,uint64,uint64,uint32)')),
  TierBroken:     keccak256(toBytes('TierBroken(uint256,uint32,uint64)')),
  Settled:        keccak256(toBytes('Settled(uint256,uint64,uint32,uint256)')),
  Refunded:       keccak256(toBytes('Refunded(uint256,address,uint256)')),
  Claimed:        keccak256(toBytes('Claimed(address,uint256)')),
  ExcessCredited: keccak256(toBytes('ExcessCredited(uint256,address,uint256)')),
}

const CONTRACT_ADDRS = [
  CONTRACTS_ACTIVE.DealFactory.toLowerCase(),
  CONTRACTS_ACTIVE.DemandPool.toLowerCase(),
  CONTRACTS_ACTIVE.Settler.toLowerCase(),
]

const ALL_TOPIC_HASHES = Object.values(TOPICS)
const ALL_ABIS = [...DEAL_FACTORY_ABI, ...DEMAND_POOL_ABI, ...SETTLER_ABI] as const

// ── Public types ──────────────────────────────────────────────────────────────

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
  totalExcess: bigint      // sum of ExcessCredited.amount across all deals
  distinctBuyers: Set<string>
  tierBreaks: number
  deals: Map<string, DealProof>
}

export interface DealProof {
  dealId: string
  commitsIn: bigint        // pricePaid sum minus withdrawal amounts (USDC escrowed)
  excessIn: bigint         // ExcessCredited sum — received by pool but not escrowed
  supplierCredited: bigint // cp * buyerCount from Settled; 0 for refunded deals
  refundsOut: bigint       // totalRefunds from Settled event OR sum of Refunded events
  settled: boolean
  refunded: boolean
  conserved: boolean | null
}

export type ScanState = 'idle' | 'scanning' | 'done' | 'error'

// ── RPC helpers (log fetch) ───────────────────────────────────────────────────

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
    toBlock:   `0x${to.toString(16)}`,
  }])
}

// ── Log decoder ───────────────────────────────────────────────────────────────

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

// ── Hook ──────────────────────────────────────────────────────────────────────

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
      // Refuse rather than scan from genesis on a chain millions of blocks deep.
      if (CONTRACTS_ACTIVE.deployBlock === 0n) {
        setScanState('error')
        setError(
          `No deployment block recorded for ${ARC_NETWORK.name}. ` +
          `Swarm is not deployed on this network yet, and scanning from genesis is not viable on Arc.`
        )
        return
      }

      const head = await getLatestBlock()
      const start = CONTRACTS_ACTIVE.deployBlock
      const total = head - start
      setProgress({ scanned: 0n, total, head })

      let window = SCAN_MAX_WINDOW
      let rateLimitDelay = RATE_BASE_MS
      let consecutiveSuccesses = 0
      let cursor = start
      const collected: SwarmEvent[] = []

      while (cursor <= head && !abortRef.current) {
        const to = cursor + window - 1n < head ? cursor + window - 1n : head

        let raw: RawLog[]
        try {
          raw = await getLogs(cursor, to)
        } catch (e: unknown) {
          if (e instanceof RangeTooLargeError) {
            // Node rejected the window — shrink and retry the same cursor.
            consecutiveSuccesses = 0
            if (window <= SCAN_MIN_WINDOW) {
              // Already at floor: this is a real error, not just a sizing issue.
              throw new Error(
                `Block range rejected even at minimum window (${SCAN_MIN_WINDOW} blocks). ` +
                `The node may be under load or require a smaller range. Try again later.`
              )
            }
            window = window / 2n
            if (window < SCAN_MIN_WINDOW) window = SCAN_MIN_WINDOW
            continue
          }
          if (e instanceof RateLimitError) {
            // Node is throttling — keep window, wait, then retry.
            consecutiveSuccesses = 0
            await new Promise(r => setTimeout(r, rateLimitDelay))
            rateLimitDelay = Math.min(rateLimitDelay * 2, RATE_MAX_MS)
            continue
          }
          throw e
        }

        // Success — grow window, reset rate-limit delay.
        rateLimitDelay = RATE_BASE_MS
        consecutiveSuccesses++
        if (consecutiveSuccesses >= GROW_AFTER && window < SCAN_MAX_WINDOW) {
          window = growWindow(window)
        }

        for (const r of raw) {
          const ev = decodeLog(r)
          if (ev) collected.push(ev)
        }

        // Sort and publish after each window for progressive display.
        collected.sort((a, b) =>
          a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex
        )
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

  // ── Derived stats ─────────────────────────────────────────────────────────

  const stats: ProofStats = (() => {
    const s: ProofStats = {
      totalCommits:   0n,
      totalRefunds:   0n,
      totalClaimed:   0n,
      totalWithdrawn: 0n,
      totalExcess:    0n,
      distinctBuyers: new Set(),
      tierBreaks: 0,
      deals: new Map(),
    }

    const getDeal = (id: string): DealProof => {
      if (!s.deals.has(id)) {
        s.deals.set(id, {
          dealId: id,
          commitsIn: 0n,
          excessIn: 0n,
          supplierCredited: 0n,
          refundsOut: 0n,
          settled: false,
          refunded: false,
          conserved: null,
        })
      }
      return s.deals.get(id)!
    }

    for (const ev of events) {
      const a = ev.args
      switch (ev.type) {
        case 'Committed': {
          const dealId = String(a.dealId)
          const paid   = BigInt(String(a.pricePaid))
          getDeal(dealId).commitsIn += paid
          s.totalCommits += paid
          s.distinctBuyers.add(String(a.buyer).toLowerCase())
          break
        }
        case 'Withdrawn': {
          // A withdrawal reduces the net committed to this deal.
          const dealId = String(a.dealId)
          const amt    = BigInt(String(a.amountReturned))
          s.totalWithdrawn += amt
          const deal = getDeal(dealId)
          if (deal.commitsIn >= amt) deal.commitsIn -= amt
          break
        }
        case 'TierBroken':
          s.tierBreaks++
          break
        case 'Settled': {
          // settle() emits Settled(dealId, clearingPrice, buyerCount, totalRefunds).
          // totalRefunds is the sum of all per-buyer refunds credited inside settle();
          // no separate Refunded events are emitted by settle().
          const dealId      = String(a.dealId)
          const cp          = BigInt(String(a.clearingPrice))
          const count       = BigInt(String(a.buyerCount))
          const evRefunds   = BigInt(String(a.totalRefunds))
          const deal        = getDeal(dealId)
          deal.settled          = true
          deal.supplierCredited = cp * count
          deal.refundsOut      += evRefunds
          s.totalRefunds       += evRefunds
          break
        }
        case 'Refunded': {
          // refundAll() emits one Refunded(dealId, buyer, amount) per buyer.
          // There is no Settled event for a refunded deal.
          const dealId = String(a.dealId)
          const amt    = BigInt(String(a.amount))
          const deal   = getDeal(dealId)
          deal.refunded   = true
          deal.refundsOut += amt
          s.totalRefunds  += amt
          break
        }
        case 'ExcessCredited': {
          // A gasless commit transferred more USDC to the pool than the clearing
          // price. The excess was not escrowed — it was routed immediately to the
          // buyer's claimable balance via creditWithdrawal. It must appear on both
          // sides of the conservation ledger: received by the pool, credited out.
          const dealId = String(a.dealId)
          const amt    = BigInt(String(a.amount))
          getDeal(dealId).excessIn += amt
          s.totalExcess            += amt
          break
        }
        case 'Claimed':
          s.totalClaimed += BigInt(String(a.amount))
          break
      }
    }

    // ── Conservation check ─────────────────────────────────────────────────
    // For a settled deal:
    //   (commitsIn + excessIn) = supplierCredited + refundsOut + excessIn
    //   simplifies to: commitsIn = supplierCredited + refundsOut
    //   (excess flows straight out via creditWithdrawal, so it cancels)
    //
    // For a refunded deal:
    //   commitsIn = refundsOut  (no excess in a refundAll deal)
    //
    // ExcessCredited is recorded in excessIn for display but does not affect
    // the conservation equation because it entered and left the pool atomically
    // in the same transaction (received → immediately credited to claimable).
    for (const deal of s.deals.values()) {
      if (deal.settled) {
        deal.conserved = deal.commitsIn === deal.supplierCredited + deal.refundsOut
      } else if (deal.refunded) {
        deal.conserved = deal.commitsIn === deal.refundsOut
      }
      // Still-open deals: conserved stays null
    }

    return s
  })()

  return { events, scanState, progress, error, stats, scan, stop }
}
