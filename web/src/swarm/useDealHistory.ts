/**
 * Event-sourced commit/withdraw history for a single v2.1 deal.
 *
 * v2 Committed: (uint256 dealId, address buyer, uint32 units, uint64 paidPerUnit,
 *                uint256 escrow, uint64 livePrice, uint32 totalUnits, uint32 buyerCount)
 * v2 Withdrawn: (uint256 dealId, address buyer, uint256 amountReturned, uint64 livePrice,
 *                uint32 totalUnits, uint32 buyerCount)
 * DealPosted:   (uint256 dealId, address supplier, address goodsToken, uint32 minUnits,
 *                uint32 maxUnits, uint64 deadline, uint64 startPrice)
 *
 * v2.1 top-up rule: a buyer's Committed events are lots of one order.
 * We SUM units and escrow across lots rather than replacing the entry.
 * Average price = totalEscrow ÷ totalUnits, displayed as paidPerUnit.
 * A Withdrawn clears the buyer's accumulated state entirely.
 *
 * Cross-window ordering fix: accumulate all logs, rebuild from scratch (empty
 * map, chronological order) after every window so a Withdrawn in a newer window
 * doesn't get dropped when its Committed arrives in an older one.
 *
 * Poll starts only after the backfill resolves; lastBlock never moves backwards.
 */

import { useState, useEffect, useRef } from 'react'
import { keccak256, toBytes, decodeEventLog, pad, type Hex } from 'viem'
import { CONTRACTS_ACTIVE } from './config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI } from './abis'
import {
  rpcFetch, getLatestBlock,
  RateLimitError, RangeTooLargeError,
  SCAN_MAX_WINDOW, SCAN_MIN_WINDOW,
  RATE_BASE_MS, RATE_MAX_MS,
  GROW_AFTER, growWindow,
} from './rpc'

// ── Public type ───────────────────────────────────────────────────────────────

export interface DealHistoryEntry {
  buyer:        `0x${string}`
  units:        number    // total units across all lots (0 if withdrawn)
  paidPerUnit:  bigint    // average price: totalEscrow ÷ units; 0 if withdrawn
  totalEscrow:  bigint    // sum of escrow across all lots; 0 if withdrawn
  withdrawn:    boolean
  txHash:       string    // most recent tx (withdraw > commit)
  blockNumber:  bigint
  logIndex:     number
}

// ── Topic hashes (v2 signatures) ─────────────────────────────────────────────
// Committed(uint256,address,uint32,uint64,uint256,uint64,uint32,uint32)
const T_COMMITTED = keccak256(toBytes(
  'Committed(uint256,address,uint32,uint64,uint256,uint64,uint32,uint32)'
))
// Withdrawn(uint256,address,uint256,uint64,uint32,uint32)
const T_WITHDRAWN = keccak256(toBytes(
  'Withdrawn(uint256,address,uint256,uint64,uint32,uint32)'
))
// DealPosted(uint256,address,address,uint32,uint32,uint64,uint64)
const T_DEAL_POSTED = keccak256(toBytes(
  'DealPosted(uint256,address,address,uint32,uint32,uint64,uint64)'
))

const COMBINED_ABI = [...DEAL_FACTORY_ABI, ...DEMAND_POOL_ABI] as const

// ── Internal types ────────────────────────────────────────────────────────────

type RawLog = {
  address: string
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  transactionHash: Hex
  logIndex: Hex
}

interface ParsedEntry {
  type:        'Committed' | 'Withdrawn' | 'DealPosted'
  buyer?:      `0x${string}`
  units?:      number
  paidPerUnit?: bigint
  escrow?:     bigint   // this lot's escrow (units × lotPrice)
  txHash:      string
  blockNumber: bigint
  logIndex:    number
}

interface CommittedArgs { buyer: `0x${string}`; units: number; paidPerUnit: bigint; escrow: bigint }
interface WithdrawnArgs { buyer: `0x${string}` }

// ── Helpers ───────────────────────────────────────────────────────────────────

function dealIdTopic(id: bigint): Hex {
  return pad(`0x${id.toString(16)}`, { size: 32 })
}

async function fetchLogs(from: bigint, to: bigint, dealId: bigint): Promise<RawLog[]> {
  return rpcFetch<RawLog[]>('eth_getLogs', [{
    address: [CONTRACTS_ACTIVE.DealFactory, CONTRACTS_ACTIVE.DemandPool],
    topics: [[T_DEAL_POSTED, T_COMMITTED, T_WITHDRAWN], dealIdTopic(dealId)],
    fromBlock: `0x${from.toString(16)}`,
    toBlock:   `0x${to.toString(16)}`,
  }])
}

function parseLog(raw: RawLog): ParsedEntry | null {
  const topic0 = raw.topics[0]
  let type: ParsedEntry['type'] | undefined
  if (topic0 === T_COMMITTED)   type = 'Committed'
  if (topic0 === T_WITHDRAWN)   type = 'Withdrawn'
  if (topic0 === T_DEAL_POSTED) type = 'DealPosted'
  if (!type) return null
  try {
    const d   = decodeEventLog({ abi: COMBINED_ABI, data: raw.data, topics: raw.topics as [Hex, ...Hex[]] })
    const pos = {
      txHash:      raw.transactionHash,
      blockNumber: BigInt(raw.blockNumber),
      logIndex:    Number(raw.logIndex),
    }
    if (type === 'Committed') {
      const a = d.args as unknown as CommittedArgs
      return {
        type,
        buyer:       a.buyer,
        units:       Number(a.units),
        paidPerUnit: BigInt(a.paidPerUnit),
        escrow:      BigInt(a.escrow),
        ...pos,
      }
    }
    if (type === 'Withdrawn') {
      const a = d.args as unknown as WithdrawnArgs
      return { type, buyer: a.buyer, ...pos }
    }
    return { type: 'DealPosted', ...pos }
  } catch {
    return null
  }
}

/**
 * Rebuild the display list from ALL collected entries in chronological order.
 *
 * v2.1 rule: multiple Committed events from the same buyer are lots of one
 * order — sum their units and escrow.  Average price = totalEscrow ÷ units.
 * A Withdrawn wipes all accumulated state for that buyer.
 *
 * Returns entries sorted newest-first (by most recent Committed or Withdrawn).
 */
function buildEntries(allLogs: ParsedEntry[]): DealHistoryEntry[] {
  const sorted = [...allLogs].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1
    : a.blockNumber > b.blockNumber ? 1
    : a.logIndex - b.logIndex
  )

  // Running totals per buyer key
  const accUnits   = new Map<string, number>()
  const accEscrow  = new Map<string, bigint>()
  const meta       = new Map<string, { buyer: `0x${string}`; txHash: string; blockNumber: bigint; logIndex: number; withdrawn: boolean }>()

  for (const l of sorted) {
    if (l.type === 'DealPosted' || !l.buyer) continue
    const key = l.buyer.toLowerCase()

    if (l.type === 'Committed') {
      const prevUnits  = accUnits.get(key)  ?? 0
      const prevEscrow = accEscrow.get(key) ?? 0n
      accUnits.set(key,  prevUnits  + (l.units  ?? 0))
      accEscrow.set(key, prevEscrow + (l.escrow ?? 0n))
      meta.set(key, {
        buyer:       l.buyer,
        txHash:      l.txHash,
        blockNumber: l.blockNumber,
        logIndex:    l.logIndex,
        withdrawn:   false,
      })
    } else if (l.type === 'Withdrawn') {
      // Withdrawal removes the entire order
      accUnits.delete(key)
      accEscrow.delete(key)
      meta.set(key, {
        buyer:       l.buyer,
        txHash:      l.txHash,
        blockNumber: l.blockNumber,
        logIndex:    l.logIndex,
        withdrawn:   true,
      })
    }
  }

  const result: DealHistoryEntry[] = []
  for (const [key, m] of meta.entries()) {
    const units       = m.withdrawn ? 0 : (accUnits.get(key) ?? 0)
    const totalEscrow = m.withdrawn ? 0n : (accEscrow.get(key) ?? 0n)
    const paidPerUnit = units > 0 ? totalEscrow / BigInt(units) : 0n
    result.push({
      buyer:       m.buyer,
      units,
      paidPerUnit,
      totalEscrow,
      withdrawn:   m.withdrawn,
      txHash:      m.txHash,
      blockNumber: m.blockNumber,
      logIndex:    m.logIndex,
    })
  }

  // Sort newest-first
  return result.sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber > b.blockNumber ? -1 : 1
      : b.logIndex - a.logIndex
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const POLL_MS = 5_000

export function useDealHistory(dealId: bigint | undefined): DealHistoryEntry[] {
  const [entries, setEntries] = useState<DealHistoryEntry[]>([])
  const mountedRef = useRef(true)

  useEffect(() => {
    if (dealId === undefined) return
    mountedRef.current = true
    setEntries([])

    const deployBlock = CONTRACTS_ACTIVE.deployBlock
    const allLogs: ParsedEntry[] = []
    let lastBlock: bigint | null = null
    let running = true

    const backfill = async (): Promise<void> => {
      const head = await getLatestBlock()
      let hi = head
      let window = SCAN_MAX_WINDOW
      let rateLimitDelay = RATE_BASE_MS
      let consecutiveSuccesses = 0
      let foundPosted = false

      while (running && !foundPosted && hi >= deployBlock) {
        const lo = hi >= deployBlock + window ? hi - window + 1n : deployBlock
        let raw: RawLog[]
        try {
          raw = await fetchLogs(lo, hi, dealId)
        } catch (e: unknown) {
          if (e instanceof RateLimitError) {
            consecutiveSuccesses = 0
            await new Promise(res => setTimeout(res, rateLimitDelay))
            rateLimitDelay = Math.min(rateLimitDelay * 2, RATE_MAX_MS)
            continue
          }
          if (e instanceof RangeTooLargeError) {
            consecutiveSuccesses = 0
            if (window <= SCAN_MIN_WINDOW) {
              if (running) lastBlock = head
              return
            }
            window = window / 2n
            if (window < SCAN_MIN_WINDOW) window = SCAN_MIN_WINDOW
            continue
          }
          if (running) lastBlock = head
          return
        }

        rateLimitDelay = RATE_BASE_MS
        consecutiveSuccesses++
        if (consecutiveSuccesses >= GROW_AFTER && window < SCAN_MAX_WINDOW) {
          window = growWindow(window)
        }

        const parsed = raw.map(parseLog).filter((x): x is ParsedEntry => x !== null)
        allLogs.push(...parsed)
        if (parsed.some(p => p.type === 'DealPosted')) foundPosted = true
        if (mountedRef.current) setEntries(buildEntries(allLogs))
        if (lo <= deployBlock) break
        hi = lo - 1n
      }

      if (running) {
        lastBlock = lastBlock === null || head > lastBlock ? head : lastBlock
      }
    }

    const startPoll = (): ReturnType<typeof setInterval> =>
      setInterval(() => {
        void (async () => {
          if (!running || lastBlock === null) return
          try {
            const head = await getLatestBlock()
            const from = lastBlock + 1n
            if (from > head) return
            const raw = await fetchLogs(from, head, dealId)
            const parsed = raw.map(parseLog).filter((x): x is ParsedEntry => x !== null)
            if (parsed.length > 0) {
              allLogs.push(...parsed)
              if (mountedRef.current) setEntries(buildEntries(allLogs))
            }
            if (head > lastBlock) lastBlock = head
          } catch {
            // Ignore transient poll failures
          }
        })()
      }, POLL_MS)

    let pollTimer: ReturnType<typeof setInterval> | null = null
    void backfill().then(() => {
      if (running) pollTimer = startPoll()
    })

    return () => {
      running = false
      mountedRef.current = false
      if (pollTimer !== null) clearInterval(pollTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId])

  return entries
}
