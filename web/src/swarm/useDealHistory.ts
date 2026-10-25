/**
 * Event-sourced commit/withdraw history for a single v2.2 deal.
 *
 * v2 Committed: (uint256 dealId, address buyer, uint32 units, uint64 paidPerUnit,
 *                uint256 escrow, uint64 livePrice, uint32 totalUnits, uint32 buyerCount)
 * v2.2 Withdrawn: (uint256 dealId, address buyer, uint32 units, uint256 amountReturned,
 *                  bool paidDirectly, uint64 livePrice, uint32 totalUnits, uint32 buyerCount)
 * DealPosted:   (uint256 dealId, address supplier, address goodsToken, uint32 minUnits,
 *                uint32 maxUnits, uint64 deadline, uint64 startPrice)
 *
 * v2.1 top-up rule: a buyer's Committed events are lots of one order.
 * Sum units and escrow across lots; average price = totalEscrow ÷ totalUnits.
 *
 * v2.2 partial withdrawal: reduces the buyer's accumulated units and escrow by
 * the withdrawn amounts. A full withdrawal (all remaining units) clears the entry.
 * A Withdrawn event with units < current accumulated units is partial.
 *
 * Cross-window ordering fix: accumulate all logs, rebuild from scratch
 * (empty map, chronological order) after every window.
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
  units:        number    // current total units (0 if fully withdrawn)
  paidPerUnit:  bigint    // average price: totalEscrow ÷ units; 0 if withdrawn
  totalEscrow:  bigint    // current escrow across all lots; 0 if fully withdrawn
  withdrawn:    boolean   // true if fully withdrawn
  txHash:       string    // most recent tx (withdraw > commit)
  blockNumber:  bigint
  logIndex:     number
}

// ── Topic hashes ─────────────────────────────────────────────────────────────
// Committed(uint256,address,uint32,uint64,uint256,uint64,uint32,uint32)
const T_COMMITTED = keccak256(toBytes(
  'Committed(uint256,address,uint32,uint64,uint256,uint64,uint32,uint32)'
))
// Withdrawn(uint256,address,uint32,uint256,bool,uint64,uint32,uint32)  — v2.2
const T_WITHDRAWN = keccak256(toBytes(
  'Withdrawn(uint256,address,uint32,uint256,bool,uint64,uint32,uint32)'
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
  type:          'Committed' | 'Withdrawn' | 'DealPosted'
  buyer?:        `0x${string}`
  units?:        number
  paidPerUnit?:  bigint
  escrow?:       bigint
  // Withdrawn-specific
  amountReturned?: bigint
  paidDirectly?:   boolean
  txHash:        string
  blockNumber:   bigint
  logIndex:      number
}

interface CommittedArgs {
  buyer: `0x${string}`; units: number; paidPerUnit: bigint; escrow: bigint
}
interface WithdrawnArgs {
  buyer: `0x${string}`; units: number; amountReturned: bigint; paidDirectly: boolean
}

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
      return {
        type,
        buyer:          a.buyer,
        units:          Number(a.units),
        amountReturned: BigInt(a.amountReturned),
        paidDirectly:   Boolean(a.paidDirectly),
        ...pos,
      }
    }
    return { type: 'DealPosted', ...pos }
  } catch {
    return null
  }
}

/**
 * Rebuild the display list from ALL collected entries in chronological order.
 *
 * v2.1: multiple Committed events from the same buyer are lots — sum units and escrow.
 * v2.2: Withdrawn reduces the buyer's accumulated units and escrow.
 *   - Full withdrawal (withdrawn units == accumulated units): buyer marked as withdrawn.
 *   - Partial withdrawal: units and escrow reduced; buyer stays active.
 *
 * Returns entries sorted newest-first.
 */
function buildEntries(allLogs: ParsedEntry[]): DealHistoryEntry[] {
  const sorted = [...allLogs].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1
    : a.blockNumber > b.blockNumber ? 1
    : a.logIndex - b.logIndex
  )

  const accUnits   = new Map<string, number>()
  const accEscrow  = new Map<string, bigint>()
  const meta       = new Map<string, {
    buyer: `0x${string}`; txHash: string; blockNumber: bigint; logIndex: number; withdrawn: boolean
  }>()

  for (const l of sorted) {
    if (l.type === 'DealPosted' || !l.buyer) continue
    const key = l.buyer.toLowerCase()

    if (l.type === 'Committed') {
      const prevUnits  = accUnits.get(key)  ?? 0
      const prevEscrow = accEscrow.get(key) ?? 0n
      accUnits.set(key,  prevUnits  + (l.units  ?? 0))
      accEscrow.set(key, prevEscrow + (l.escrow ?? 0n))
      meta.set(key, {
        buyer: l.buyer, txHash: l.txHash, blockNumber: l.blockNumber,
        logIndex: l.logIndex, withdrawn: false,
      })
    } else if (l.type === 'Withdrawn') {
      const wUnits      = l.units         ?? 0
      const wAmount     = l.amountReturned ?? 0n
      const prevUnits   = accUnits.get(key)  ?? 0
      const prevEscrow  = accEscrow.get(key) ?? 0n
      const newUnits    = Math.max(0, prevUnits - wUnits)
      const newEscrow   = prevEscrow > wAmount ? prevEscrow - wAmount : 0n
      const isFull      = newUnits === 0

      if (isFull) {
        accUnits.delete(key)
        accEscrow.delete(key)
      } else {
        accUnits.set(key,  newUnits)
        accEscrow.set(key, newEscrow)
      }

      meta.set(key, {
        buyer: l.buyer, txHash: l.txHash, blockNumber: l.blockNumber,
        logIndex: l.logIndex, withdrawn: isFull,
      })
    }
  }

  const result: DealHistoryEntry[] = []
  for (const [key, m] of meta.entries()) {
    const units       = m.withdrawn ? 0 : (accUnits.get(key) ?? 0)
    const totalEscrow = m.withdrawn ? 0n : (accEscrow.get(key) ?? 0n)
    const paidPerUnit = units > 0 ? totalEscrow / BigInt(units) : 0n
    result.push({
      buyer: m.buyer, units, paidPerUnit, totalEscrow,
      withdrawn: m.withdrawn, txHash: m.txHash,
      blockNumber: m.blockNumber, logIndex: m.logIndex,
    })
  }

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
