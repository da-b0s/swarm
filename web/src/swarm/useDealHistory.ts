/**
 * Event-sourced commit history for a single deal.
 *
 * Builds the list from Committed and Withdrawn events (with DealPosted as the
 * sentinel that marks the start of this deal's history) instead of reading the
 * on-chain buyer array, which is scrambled by the swap-and-pop used in withdraw.
 *
 * Filter: topics = [[DealPosted, Committed, Withdrawn], [dealIdTopic]]
 * Applied to both DealFactory and DemandPool addresses.
 *
 * Scan strategy:
 * - Initial backfill: walk backwards from chain head in 5,000-block windows until
 *   we find the DealPosted event for this dealId (or reach the deploy block).
 * - Incremental poll: every 5 s, fetch only blocks since the last scanned block.
 * - Display order: newest first (last-committed shows at the top).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { keccak256, toBytes, decodeEventLog, pad, type Hex } from 'viem'
import { ARC_NETWORK, CONTRACTS_ACTIVE } from './config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI } from './abis'

export interface DealHistoryEntry {
  buyer: `0x${string}`
  pricePaid: bigint    // micro-USDC (6 dec)
  withdrawn: boolean
  txHash: string
  blockNumber: bigint
  logIndex: number
}

// ── topic hashes ──────────────────────────────────────────────────────────────

const T_DEAL_POSTED  = keccak256(toBytes('DealPosted(uint256,address,uint32,uint64,uint64)'))
const T_COMMITTED    = keccak256(toBytes('Committed(uint256,address,uint64,uint64,uint32)'))
const T_WITHDRAWN    = keccak256(toBytes('Withdrawn(uint256,address,uint64,uint64,uint32)'))

// ── RPC helpers ───────────────────────────────────────────────────────────────

type JsonRpcResp<T> = { result: T; error?: undefined } | { result?: undefined; error: { message?: string } }

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(ARC_NETWORK.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await r.json() as JsonRpcResp<T>
  if (json.error) throw new Error(json.error.message ?? 'RPC error')
  return json.result
}

async function blockNumber(): Promise<bigint> {
  return BigInt(await rpc<string>('eth_blockNumber', []))
}

type RawLog = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex }

/** Encode a uint256 as a 32-byte padded topics entry */
function dealIdTopic(id: bigint): Hex {
  return pad(`0x${id.toString(16)}`, { size: 32 })
}

async function fetchLogs(from: bigint, to: bigint, dealId: bigint): Promise<RawLog[]> {
  return rpc<RawLog[]>('eth_getLogs', [{
    address: [CONTRACTS_ACTIVE.DealFactory, CONTRACTS_ACTIVE.DemandPool],
    topics: [
      [T_DEAL_POSTED, T_COMMITTED, T_WITHDRAWN],
      dealIdTopic(dealId),
    ],
    fromBlock: `0x${from.toString(16)}`,
    toBlock:   `0x${to.toString(16)}`,
  }])
}

const COMBINED_ABI = [...DEAL_FACTORY_ABI, ...DEMAND_POOL_ABI] as const

// ── decoder ───────────────────────────────────────────────────────────────────

interface ParsedEntry {
  type: 'Committed' | 'Withdrawn' | 'DealPosted'
  buyer?: `0x${string}`
  pricePaid?: bigint
  txHash: string
  blockNumber: bigint
  logIndex: number
}

// Typed args shapes returned by decodeEventLog for the events we decode
interface CommittedArgs { buyer: `0x${string}`; pricePaid: bigint }
interface WithdrawnArgs { buyer: `0x${string}` }

function parseLog(raw: RawLog): ParsedEntry | null {
  const topic0 = raw.topics[0]
  let type: ParsedEntry['type'] | undefined
  if (topic0 === T_COMMITTED)   type = 'Committed'
  if (topic0 === T_WITHDRAWN)   type = 'Withdrawn'
  if (topic0 === T_DEAL_POSTED) type = 'DealPosted'
  if (!type) return null

  try {
    const d = decodeEventLog({ abi: COMBINED_ABI, data: raw.data, topics: raw.topics as [Hex, ...Hex[]] })
    if (type === 'Committed') {
      const a = d.args as unknown as CommittedArgs
      return { type, buyer: a.buyer, pricePaid: BigInt(a.pricePaid), txHash: raw.transactionHash, blockNumber: BigInt(raw.blockNumber), logIndex: Number(raw.logIndex) }
    }
    if (type === 'Withdrawn') {
      const a = d.args as unknown as WithdrawnArgs
      return { type, buyer: a.buyer, txHash: raw.transactionHash, blockNumber: BigInt(raw.blockNumber), logIndex: Number(raw.logIndex) }
    }
    // DealPosted — no args needed, just the position marker
    return { type: 'DealPosted', txHash: raw.transactionHash, blockNumber: BigInt(raw.blockNumber), logIndex: Number(raw.logIndex) }
  } catch {
    return null
  }
}

// ── hook ──────────────────────────────────────────────────────────────────────

const WINDOW = 5000n   // blocks per getLogs call
const POLL_MS = 5000   // incremental poll interval

export function useDealHistory(dealId: bigint | undefined): DealHistoryEntry[] {
  const [entries, setEntries] = useState<DealHistoryEntry[]>([])
  // last block fully scanned (so incremental polls start from lastBlock+1)
  const lastBlockRef  = useRef<bigint | null>(null)
  const foundPostedRef = useRef(false)
  // track live state: address → {pricePaid, withdrawn}
  const stateRef = useRef<Map<string, { pricePaid: bigint; withdrawn: boolean; txHash: string; blockNumber: bigint; logIndex: number }>>(new Map())
  const mountedRef = useRef(true)

  // Rebuild the display list (newest first) from the state map
  const rebuild = useCallback(() => {
    const arr: DealHistoryEntry[] = []
    for (const [buyer, v] of stateRef.current) {
      arr.push({ buyer: buyer as `0x${string}`, pricePaid: v.pricePaid, withdrawn: v.withdrawn, txHash: v.txHash, blockNumber: v.blockNumber, logIndex: v.logIndex })
    }
    // Sort newest-first (by block, then logIndex descending)
    arr.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1
      return b.logIndex - a.logIndex
    })
    if (mountedRef.current) setEntries(arr)
  }, [])

  // Apply a batch of parsed log entries to stateRef
  const applyLogs = useCallback((logs: ParsedEntry[]) => {
    // Sort chronologically before applying
    const sorted = [...logs].sort((a, b) =>
      a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex
    )
    for (const l of sorted) {
      if (l.type === 'DealPosted') {
        foundPostedRef.current = true
        continue
      }
      if (!l.buyer) continue
      const key = l.buyer.toLowerCase()
      if (l.type === 'Committed') {
        stateRef.current.set(key, {
          pricePaid: l.pricePaid ?? 0n,
          withdrawn: false,
          txHash: l.txHash,
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
        })
      } else if (l.type === 'Withdrawn') {
        const existing = stateRef.current.get(key)
        if (existing) {
          stateRef.current.set(key, { ...existing, withdrawn: true, txHash: l.txHash, blockNumber: l.blockNumber, logIndex: l.logIndex })
        }
      }
    }
  }, [])

  useEffect(() => {
    if (dealId === undefined) return
    mountedRef.current = true
    lastBlockRef.current  = null
    foundPostedRef.current = false
    stateRef.current = new Map()
    setEntries([])

    const deployBlock = CONTRACTS_ACTIVE.deployBlock

    // ── Initial backfill: scan backwards until DealPosted found ──────────────
    let running = true
    const backfill = async () => {
      try {
        const head = await blockNumber()
        // Start from head, walk backwards in WINDOW-sized chunks
        let hi = head

        while (running && !foundPostedRef.current && hi >= deployBlock) {
          const lo = hi >= deployBlock + WINDOW ? hi - WINDOW + 1n : deployBlock
          let logs: RawLog[]
          try {
            logs = await fetchLogs(lo, hi, dealId)
          } catch {
            // On any RPC error during backfill, just stop and use what we have
            break
          }
          const parsed = logs.map(parseLog).filter(Boolean) as ParsedEntry[]
          applyLogs(parsed)
          rebuild()
          if (lo <= deployBlock) break
          hi = lo - 1n
        }

        // Record where we've scanned to so incremental polls start here
        if (running) {
          lastBlockRef.current = head
        }
      } catch {
        // Silently fail — the list stays empty/partial
      }
    }

    void backfill()

    // ── Incremental poll: pick up new events as blocks arrive ─────────────────
    const doPoll = async () => {
      if (!running) return
      try {
        const head = await blockNumber()
        const from = lastBlockRef.current !== null ? lastBlockRef.current + 1n : head
        if (from > head) return
        const logs = await fetchLogs(from, head, dealId)
        const parsed = logs.map(parseLog).filter(Boolean) as ParsedEntry[]
        if (parsed.length > 0) {
          applyLogs(parsed)
          rebuild()
        }
        lastBlockRef.current = head
      } catch {
        // Ignore transient poll failures
      }
    }
    const pollTimer = setInterval(() => { void doPoll() }, POLL_MS)

    return () => {
      running = false
      mountedRef.current = false
      clearInterval(pollTimer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId])

  return entries
}
