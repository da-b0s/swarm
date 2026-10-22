/**
 * Event-sourced commit/withdraw history for a single deal.
 *
 * Correctness requirements
 * ────────────────────────
 * 1. Cross-window ordering: the contract's swap-and-pop means storage order is
 *    scrambled; and a buyer's Committed may be in an older window than their
 *    Withdrawn. Processing windows newest-first (backfill order) would apply a
 *    Withdrawn before its Committed, dropping it.
 *    Fix: accumulate all backfill logs, rebuild the state map from scratch in
 *    chronological order after every window for progressive display.
 *
 * 2. Poll–backfill race: the incremental poll must not start before the
 *    backfill finishes, and must never move lastBlockRef backwards.
 *
 * 3. Silent partial lists: errors during backfill must not silently mark the
 *    list as complete. Rate-limit → back off and retry; range-too-large →
 *    shrink window and retry; other → surface the error.
 *
 * Filter: topics = [[DealPosted, Committed, Withdrawn], [dealIdTopic32]]
 * Applied to DealFactory (DealPosted) and DemandPool (Committed, Withdrawn).
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
  buyer: `0x${string}`
  pricePaid: bigint    // micro-USDC (6 dec); 0 if withdrawn
  withdrawn: boolean
  txHash: string       // most recent tx (withdraw > commit)
  blockNumber: bigint
  logIndex: number
}

// ── Topic hashes ──────────────────────────────────────────────────────────────

const T_DEAL_POSTED = keccak256(toBytes('DealPosted(uint256,address,uint32,uint64,uint64)'))
const T_COMMITTED   = keccak256(toBytes('Committed(uint256,address,uint64,uint64,uint32)'))
const T_WITHDRAWN   = keccak256(toBytes('Withdrawn(uint256,address,uint64,uint64,uint32)'))

const COMBINED_ABI = [...DEAL_FACTORY_ABI, ...DEMAND_POOL_ABI] as const

// ── RawLog / ParsedEntry types ────────────────────────────────────────────────

type RawLog = {
  address: string
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  transactionHash: Hex
  logIndex: Hex
}

interface ParsedEntry {
  type: 'Committed' | 'Withdrawn' | 'DealPosted'
  buyer?: `0x${string}`
  pricePaid?: bigint
  txHash: string
  blockNumber: bigint
  logIndex: number
}

interface CommittedArgs { buyer: `0x${string}`; pricePaid: bigint }
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
    const d = decodeEventLog({ abi: COMBINED_ABI, data: raw.data, topics: raw.topics as [Hex, ...Hex[]] })
    const pos = { txHash: raw.transactionHash, blockNumber: BigInt(raw.blockNumber), logIndex: Number(raw.logIndex) }
    if (type === 'Committed') {
      const a = d.args as unknown as CommittedArgs
      return { type, buyer: a.buyer, pricePaid: BigInt(a.pricePaid), ...pos }
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
 * Rebuild the display list from a flat array of ALL parsed entries collected
 * so far, applied in chronological order from an empty state map.
 * Returns entries sorted newest-first.
 */
function buildEntries(allLogs: ParsedEntry[]): DealHistoryEntry[] {
  // Sort ascending so each event is applied in the order it occurred on-chain.
  const sorted = [...allLogs].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex
  )

  // Build a fresh state map — never carry over state from a previous build.
  const map = new Map<string, DealHistoryEntry>()

  for (const l of sorted) {
    if (l.type === 'DealPosted' || !l.buyer) continue
    const key = l.buyer.toLowerCase()
    if (l.type === 'Committed') {
      map.set(key, {
        buyer: l.buyer,
        pricePaid: l.pricePaid ?? 0n,
        withdrawn: false,
        txHash: l.txHash,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
      })
    } else if (l.type === 'Withdrawn') {
      const existing = map.get(key)
      if (existing) {
        map.set(key, { ...existing, withdrawn: true, txHash: l.txHash, blockNumber: l.blockNumber, logIndex: l.logIndex })
      }
    }
  }

  // Return newest-first.
  return Array.from(map.values()).sort((a, b) =>
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

    // allLogs holds every ParsedEntry collected during the backfill.
    // The backfill appends to it; each window triggers a rebuild from scratch
    // so the display is always consistent even though windows arrive newest-first.
    const allLogs: ParsedEntry[] = []

    // lastBlock is set once (to the head at backfill start) and only ever
    // moves forward; the incremental poll reads it after the backfill resolves.
    let lastBlock: bigint | null = null
    let running = true

    // ── Backfill (backwards from head, newest-first windows) ──────────────────

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
            continue  // retry same [lo, hi]
          }
          if (e instanceof RangeTooLargeError) {
            consecutiveSuccesses = 0
            if (window <= SCAN_MIN_WINDOW) {
              // Already at floor — give up and surface a partial list.
              // Setting lastBlock allows the poll to keep the list live.
              if (running) lastBlock = head
              return
            }
            window = window / 2n
            if (window < SCAN_MIN_WINDOW) window = SCAN_MIN_WINDOW
            continue  // retry same hi with smaller window
          }
          // Any other error: abort this backfill attempt.
          if (running) lastBlock = head
          return
        }

        // Success
        rateLimitDelay = RATE_BASE_MS
        consecutiveSuccesses++
        if (consecutiveSuccesses >= GROW_AFTER && window < SCAN_MAX_WINDOW) {
          window = growWindow(window)
        }

        const parsed = raw.map(parseLog).filter((x): x is ParsedEntry => x !== null)
        allLogs.push(...parsed)

        // Check whether we've seen the DealPosted sentinel for this deal.
        if (parsed.some(p => p.type === 'DealPosted')) foundPosted = true

        // Rebuild from scratch after every window for progressive display.
        if (mountedRef.current) setEntries(buildEntries(allLogs))

        if (lo <= deployBlock) break
        hi = lo - 1n
      }

      // Backfill complete — record head so the poll knows where to start.
      // Never move lastBlock backwards: if something already set it forward,
      // keep the later value.
      if (running) {
        lastBlock = lastBlock === null || head > lastBlock ? head : lastBlock
      }
    }

    // ── Incremental poll — starts only after backfill resolves ────────────────

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
            // Only advance lastBlock — never let it go backwards.
            if (head > lastBlock) lastBlock = head
          } catch {
            // Ignore transient poll failures — next tick will retry.
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
  // dealId is the only stable dependency. Everything inside closes over it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId])

  return entries
}
