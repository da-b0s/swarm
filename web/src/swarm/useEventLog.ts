/**
 * Event log scanner for the /proof page — v3.
 *
 * Strategy:
 *   1. Fetch all three contracts' logs from the Blockscout explorer API in
 *      parallel (handles the full contract history in ~1–3 requests total).
 *   2. RPC gap-fill from (highest explorer block + 1) to the current head for
 *      anything not yet indexed by the explorer, using the existing windowed
 *      scanner with rate-limit back-off.
 *   3. De-duplicate by (txHash, logIndex).
 *   4. If any explorer request fails or returns malformed data, fall back to
 *      a full RPC scan from the deployment block.
 *
 * Conservation model — two assets
 * ────────────────────────────────
 * USDC:
 *   settle():   commitsIn = supplierCredited + refundsOut
 *   refundAll():commitsIn = refundsOut  (supplierCredited = 0)
 *
 * Goods (ERC-20):
 *   settle():   stockDeposited = unitsDelivered + unsoldReturned
 *               (read from Settled event: unitsDelivered + (maxUnits - totalUnits) × tokensPerUnit)
 *   refundAll():entire stock returned to supplier (stockDeposited = stockReturned)
 */

import { useState, useCallback, useRef } from 'react'
import { decodeEventLog, keccak256, toBytes, type Hex } from 'viem'
import { ARC_NETWORK, CONTRACTS_ACTIVE, DEPLOYMENT_READY, GOODS_TOKENS } from './config'
import { formatTokenAmount } from './utils'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI, SETTLER_ABI } from './abis'
import {
  rpcFetch, getLatestBlock,
  RateLimitError, RangeTooLargeError,
  SCAN_MAX_WINDOW, SCAN_MIN_WINDOW,
  RATE_BASE_MS, RATE_MAX_MS,
  GROW_AFTER, growWindow,
} from './rpc'

// ── Event topic hashes — v2 signatures ────────────────────────────────────────

const TOPICS = {
  DealPosted:     keccak256(toBytes('DealPosted(uint256,address,address,uint32,uint32,uint64,uint64)')),
  Committed:      keccak256(toBytes('Committed(uint256,address,uint32,uint64,uint256,uint64,uint32,uint32)')),
  Withdrawn:      keccak256(toBytes('Withdrawn(uint256,address,uint32,uint256,bool,uint64,uint32,uint32)')),
  TierBroken:     keccak256(toBytes('TierBroken(uint256,uint32,uint64)')),
  Settled:        keccak256(toBytes('Settled(uint256,uint64,uint32,uint32,uint256,uint256)')),
  Refunded:       keccak256(toBytes('Refunded(uint256,address,uint256)')),
  Claimed:        keccak256(toBytes('Claimed(address,uint256)')),
  ExcessCredited: keccak256(toBytes('ExcessCredited(uint256,address,uint256)')),
  GoodsClaimed:   keccak256(toBytes('GoodsClaimed(address,address,uint256)')),
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
  type:        keyof typeof TOPICS
  blockNumber: bigint
  txHash:      string
  logIndex:    number
  args:        Record<string, unknown>
  /** Unix timestamp (seconds) from the explorer; undefined for RPC-only logs */
  timestamp?:  number
}

export interface ProofStats {
  totalCommits:      bigint
  totalRefunds:      bigint
  totalClaimed:      bigint
  totalWithdrawn:    bigint
  totalExcess:       bigint
  totalUnitsSold:    bigint
  /** Per-token goods claimed: token address (lowercase) → total base-unit amount */
  goodsClaimedByToken: Map<string, bigint>
  distinctBuyers:    Set<string>
  tierBreaks:        number
  deals:             Map<string, DealProof>
}

export interface DealProof {
  dealId:            string
  goodsToken:        string
  commitsIn:         bigint
  excessIn:          bigint
  supplierCredited:  bigint
  refundsOut:        bigint
  usdcConserved:     boolean | null
  totalUnitsSettled: bigint
  unitsDelivered:    bigint
  settled:           boolean
  refunded:          boolean
  goodsNote:         string
}

export type ScanState = 'idle' | 'scanning' | 'done' | 'error'

// ── RPC log shape ─────────────────────────────────────────────────────────────

type RawLog = {
  address:         string
  topics:          Hex[]
  data:            Hex
  blockNumber:     Hex
  transactionHash: Hex
  logIndex:        Hex
  /** Unix seconds — populated only for explorer-sourced logs */
  timestamp?:      number
}

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function getLogsRpc(from: bigint, to: bigint): Promise<RawLog[]> {
  return rpcFetch<RawLog[]>('eth_getLogs', [{
    address: [CONTRACTS_ACTIVE.DealFactory, CONTRACTS_ACTIVE.DemandPool, CONTRACTS_ACTIVE.Settler],
    topics:  [ALL_TOPIC_HASHES],
    fromBlock: `0x${from.toString(16)}`,
    toBlock:   `0x${to.toString(16)}`,
  }])
}

// ── Blockscout explorer API ───────────────────────────────────────────────────

// Explorer item as returned by the Blockscout /api/v2/addresses/{addr}/logs endpoint.
interface ExplorerLogItem {
  topics:           (string | null)[]
  data:             string
  block_number:     number
  block_timestamp:  string   // ISO-8601
  transaction_hash: string
  index:            number
}

interface ExplorerPage {
  items:           ExplorerLogItem[]
  next_page_params: Record<string, string | number> | null
}

async function fetchExplorerLogs(contractAddr: string, signal: AbortSignal): Promise<RawLog[]> {
  const base = `${ARC_NETWORK.explorerBase}/api/v2/addresses/${contractAddr}/logs`
  const result: RawLog[] = []
  let params: Record<string, string | number> = {}

  for (;;) {
    const url = new URL(base)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    const resp = await fetch(url.toString(), { signal })
    if (!resp.ok) throw new Error(`Explorer ${resp.status} for ${contractAddr}`)
    const page: unknown = await resp.json()
    if (
      typeof page !== 'object' || page === null ||
      !('items' in page) || !Array.isArray((page as ExplorerPage).items)
    ) {
      throw new Error('Explorer returned unexpected shape')
    }
    const typed = page as ExplorerPage
    for (const item of typed.items) {
      // Filter topics: drop nulls, cast to Hex
      const topics = item.topics
        .filter((t): t is string => t !== null && typeof t === 'string')
        .map(t => t as Hex)
      if (topics.length === 0) continue
      // Parse block_timestamp → Unix seconds
      let ts: number | undefined
      try { ts = Math.floor(new Date(item.block_timestamp).getTime() / 1000) } catch { /* ignore */ }
      result.push({
        address:         contractAddr,
        topics,
        data:            (item.data || '0x') as Hex,
        blockNumber:     `0x${item.block_number.toString(16)}`,
        transactionHash: item.transaction_hash as Hex,
        logIndex:        `0x${item.index.toString(16)}`,
        timestamp:       ts,
      })
    }
    if (!typed.next_page_params) break
    params = Object.fromEntries(
      Object.entries(typed.next_page_params).map(([k, v]) => [k, v])
    )
  }
  return result
}

async function fetchAllExplorerLogs(signal: AbortSignal): Promise<RawLog[]> {
  const [factory, pool, settler] = await Promise.all([
    fetchExplorerLogs(CONTRACTS_ACTIVE.DealFactory, signal),
    fetchExplorerLogs(CONTRACTS_ACTIVE.DemandPool,  signal),
    fetchExplorerLogs(CONTRACTS_ACTIVE.Settler,     signal),
  ])
  return [...factory, ...pool, ...settler]
}

/**
 * Fetch the latest indexed block height from the explorer's main-page/blocks
 * endpoint. Returns undefined on any failure — callers fall back to the newest
 * event block instead.
 *
 * Response is an array; first item's `height` is the latest indexed block:
 *   [{ "height": 28813134, ... }, ...]
 */
async function fetchIndexedHeight(signal: AbortSignal): Promise<bigint | undefined> {
  try {
    const url  = `${ARC_NETWORK.explorerBase}/api/v2/main-page/blocks`
    const resp = await fetch(url, { signal })
    if (!resp.ok) return undefined
    const data: unknown = await resp.json()
    if (!Array.isArray(data) || data.length === 0) return undefined
    const first: unknown = data[0]
    if (typeof first !== 'object' || first === null || !('height' in first)) return undefined
    const h = (first as Record<string, unknown>).height
    if (typeof h !== 'number') return undefined
    return BigInt(h)
  } catch {
    return undefined
  }
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
      abi:    ALL_ABIS,
      data:   raw.data,
      topics: raw.topics as [Hex, ...Hex[]],
    })
    return {
      type,
      blockNumber: BigInt(raw.blockNumber),
      txHash:      raw.transactionHash,
      logIndex:    Number(raw.logIndex),
      args:        decoded.args,
      timestamp:   raw.timestamp,
    }
  } catch {
    return null
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useEventLog() {
  const [events,       setEvents]       = useState<SwarmEvent[]>([])
  const [scanState,    setScanState]    = useState<ScanState>('idle')
  const [progress,     setProgress]     = useState({ scanned: 0n, total: 0n, head: 0n })
  const [progressText, setProgressText] = useState('')
  const [error,        setError]        = useState('')
  const abortRef     = useRef(false)
  const explorerAbortRef = useRef<AbortController | null>(null)

  const scan = useCallback(async () => {
    abortRef.current = false
    // Abort any in-flight explorer fetch from a previous run
    explorerAbortRef.current?.abort()
    const ac = new AbortController()
    explorerAbortRef.current = ac

    setScanState('scanning')
    setEvents([])
    setError('')
    setProgressText('Loading history…')

    try {
      if (!DEPLOYMENT_READY) {
        setScanState('error')
        setError(`Swarm is not deployed on ${ARC_NETWORK.name}. Switch to a supported network.`)
        return
      }

      const head  = await getLatestBlock()
      const start = CONTRACTS_ACTIVE.deployBlock
      setProgress({ scanned: 0n, total: head - start, head })

      // ── Phase 1: Explorer (logs + indexed height, in parallel) ──────────
      let explorerLogs: RawLog[] = []
      let explorerHighBlock = start - 1n
      let explorerOk = false
      let indexedHeight: bigint | undefined

      try {
        // Fetch event logs and the explorer's indexed tip at the same time.
        // fetchIndexedHeight never throws (returns undefined on failure).
        ;[explorerLogs, indexedHeight] = await Promise.all([
          fetchAllExplorerLogs(ac.signal),
          fetchIndexedHeight(ac.signal),
        ])
        explorerOk = true
        for (const l of explorerLogs) {
          const bn = BigInt(l.blockNumber)
          if (bn > explorerHighBlock) explorerHighBlock = bn
        }
      } catch (e: unknown) {
        // Aborted by user stop — propagate
        if (e instanceof DOMException && e.name === 'AbortError') throw e
        // Any other explorer failure: fall back to full RPC scan
        explorerOk        = false
        explorerHighBlock = start - 1n
        indexedHeight     = undefined
      }

      if (abortRef.current) return

      // Deduplicate explorer logs by (txHash, logIndex)
      const seen = new Set<string>()
      const collected: SwarmEvent[] = []

      const addLog = (raw: RawLog) => {
        const key = `${raw.transactionHash}:${Number(raw.logIndex)}`
        if (seen.has(key)) return
        seen.add(key)
        const ev = decodeLog(raw)
        if (ev) collected.push(ev)
      }

      for (const l of explorerLogs) addLog(l)

      // Emit explorer results immediately so the page feels responsive
      if (explorerOk && collected.length > 0) {
        collected.sort((a, b) =>
          a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex
        )
        setEvents([...collected])
        setProgress({ scanned: explorerHighBlock - start, total: head - start, head })
      }

      // ── Phase 2: RPC gap-fill ────────────────────────────────────────────
      // Use the explorer's indexed tip (not just the newest event block) so
      // the gap-fill window is small even when the contract has been quiet.
      // Fall back to explorerHighBlock when the indexed-height fetch failed.
      const explorerCoveredTo = indexedHeight !== undefined && indexedHeight > explorerHighBlock
        ? indexedHeight
        : explorerHighBlock
      const rpcStart = explorerOk ? explorerCoveredTo + 1n : start
      if (rpcStart <= head) {
        setProgressText('')
        let window               = SCAN_MAX_WINDOW
        let rateLimitDelay       = RATE_BASE_MS
        let consecutiveSuccesses = 0
        let cursor               = rpcStart

        while (cursor <= head && !abortRef.current) {
          const to = cursor + window - 1n < head ? cursor + window - 1n : head

          let raw: RawLog[]
          try {
            raw = await getLogsRpc(cursor, to)
          } catch (e: unknown) {
            if (e instanceof RangeTooLargeError) {
              consecutiveSuccesses = 0
              if (window <= SCAN_MIN_WINDOW) {
                throw new Error(
                  `Block range rejected even at minimum window (${SCAN_MIN_WINDOW} blocks). ` +
                  `Try again later.`
                )
              }
              window = window / 2n
              if (window < SCAN_MIN_WINDOW) window = SCAN_MIN_WINDOW
              continue
            }
            if (e instanceof RateLimitError) {
              consecutiveSuccesses = 0
              await new Promise(r => setTimeout(r, rateLimitDelay))
              rateLimitDelay = Math.min(rateLimitDelay * 2, RATE_MAX_MS)
              continue
            }
            throw e
          }

          rateLimitDelay = RATE_BASE_MS
          consecutiveSuccesses++
          if (consecutiveSuccesses >= GROW_AFTER && window < SCAN_MAX_WINDOW) {
            window = growWindow(window)
          }

          for (const r of raw) addLog(r)

          collected.sort((a, b) =>
            a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex
          )
          setEvents([...collected])
          setProgress({ scanned: to - start, total: head - start, head })
          cursor = to + 1n
        }
      } else {
        // Explorer covered everything up to head
        setProgress({ scanned: head - start, total: head - start, head })
      }

      setProgressText('')
      setScanState('done')
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError((e as Error).message ?? 'Scan failed')
      setScanState('error')
    }
  }, [])

  const stop = useCallback(() => {
    abortRef.current = true
    explorerAbortRef.current?.abort()
  }, [])

  // ── Derived stats ──────────────────────────────────────────────────────────

  const stats: ProofStats = (() => {
    const s: ProofStats = {
      totalCommits:        0n,
      totalRefunds:        0n,
      totalClaimed:        0n,
      totalWithdrawn:      0n,
      totalExcess:         0n,
      totalUnitsSold:      0n,
      goodsClaimedByToken: new Map(),
      distinctBuyers:      new Set(),
      tierBreaks:          0,
      deals:               new Map(),
    }

    const knownTokenDecimals = new Map<string, number>(
      GOODS_TOKENS.map(t => [t.address.toLowerCase(), t.decimals])
    )

    const getDeal = (id: string): DealProof => {
      if (!s.deals.has(id)) {
        s.deals.set(id, {
          dealId:            id,
          goodsToken:        '',
          commitsIn:         0n,
          excessIn:          0n,
          supplierCredited:  0n,
          refundsOut:        0n,
          usdcConserved:     null,
          totalUnitsSettled: 0n,
          unitsDelivered:    0n,
          settled:           false,
          refunded:          false,
          goodsNote:         '',
        })
      }
      return s.deals.get(id)!
    }

    for (const ev of events) {
      const a = ev.args
      switch (ev.type) {
        case 'DealPosted': {
          const dealId = String(a.dealId)
          const tok    = (a.goodsToken as string | undefined ?? '').toLowerCase()
          if (tok) getDeal(dealId).goodsToken = tok
          break
        }
        case 'Committed': {
          const dealId = String(a.dealId)
          const escrow = BigInt(String(a.escrow))
          getDeal(dealId).commitsIn += escrow
          s.totalCommits            += escrow
          s.distinctBuyers.add(String(a.buyer).toLowerCase())
          break
        }
        case 'Withdrawn': {
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
          const dealId         = String(a.dealId)
          const cp             = BigInt(String(a.clearingPrice))
          const totalUnits     = BigInt(String(a.totalUnits))
          const evRefunds      = BigInt(String(a.totalRefunds))
          const unitsDelivered = BigInt(String(a.unitsDelivered))
          const deal           = getDeal(dealId)
          deal.settled           = true
          deal.supplierCredited  = cp * totalUnits
          deal.refundsOut       += evRefunds
          deal.totalUnitsSettled = totalUnits
          deal.unitsDelivered    = unitsDelivered
          s.totalRefunds        += evRefunds
          s.totalUnitsSold      += totalUnits
          break
        }
        case 'Refunded': {
          const dealId = String(a.dealId)
          const amt    = BigInt(String(a.amount))
          const deal   = getDeal(dealId)
          deal.refunded   = true
          deal.refundsOut += amt
          s.totalRefunds  += amt
          break
        }
        case 'ExcessCredited': {
          const dealId = String(a.dealId)
          const amt    = BigInt(String(a.amount))
          getDeal(dealId).excessIn += amt
          s.totalExcess            += amt
          break
        }
        case 'Claimed':
          s.totalClaimed += BigInt(String(a.amount))
          break
        case 'GoodsClaimed': {
          const tokenAddr = (typeof a.token === 'string' ? a.token : '').toLowerCase()
          const amt       = BigInt(String(a.amount))
          const prev      = s.goodsClaimedByToken.get(tokenAddr) ?? 0n
          s.goodsClaimedByToken.set(tokenAddr, prev + amt)
          break
        }
      }
    }

    // ── Conservation checks ───────────────────────────────────────────────
    for (const deal of s.deals.values()) {
      if (deal.settled) {
        deal.usdcConserved = deal.commitsIn === deal.supplierCredited + deal.refundsOut
      } else if (deal.refunded) {
        deal.usdcConserved = deal.commitsIn === deal.refundsOut
      }

      if (deal.settled) {
        const dec = deal.goodsToken ? knownTokenDecimals.get(deal.goodsToken) : undefined
        const fmt = (v: bigint) => dec !== undefined ? formatTokenAmount(v, dec) : v.toString()
        const tok = deal.goodsToken
          ? (GOODS_TOKENS.find(t => t.address.toLowerCase() === deal.goodsToken)?.symbol ?? 'tokens')
          : 'tokens'
        deal.goodsNote = deal.unitsDelivered > 0n
          ? `${fmt(deal.unitsDelivered)} ${tok} delivered to buyers`
          : 'No tokens delivered (all stock unsold or deal had zero buyers)'
      } else if (deal.refunded) {
        deal.goodsNote = 'Refunded — full stock returned to supplier'
      }
    }

    return s
  })()

  return { events, scanState, progress, progressText, error, stats, scan, stop }
}
