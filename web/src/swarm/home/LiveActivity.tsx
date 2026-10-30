/**
 * LiveActivity — latest 6 on-chain Swarm events, from full history.
 *
 * Scans from the deployment block (same as Proof page / useDealHistory) in
 * bounded chunks, respecting RangeTooLargeError / RateLimitError the same way
 * the rest of the codebase does.  Polls at POLL_LIST cadence after the first
 * scan completes.  Tracks three UI states: loading, loaded (may be empty), error.
 *
 * Relative times are approximated from block numbers when block timestamps are
 * not available from eth_getLogs (which only gives blockNumber, not timestamp).
 */

import { useState, useEffect, useRef } from 'react'
import { keccak256, toBytes, decodeEventLog, type Hex } from 'viem'
import { ExternalLink } from 'lucide-react'
import { CONTRACTS_ACTIVE, ARC_NETWORK, POLL_LIST } from '../config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI, SETTLER_ABI } from '../abis'
import {
  rpcFetch, getLatestBlock,
  RateLimitError, RangeTooLargeError,
  SCAN_MAX_WINDOW, SCAN_MIN_WINDOW,
  RATE_BASE_MS, RATE_MAX_MS,
  GROW_AFTER, growWindow,
} from '../rpc'
import { formatUsdcPrice } from '../utils'

// ── Event topics ──────────────────────────────────────────────────────────────

const T = {
  DealPosted: keccak256(toBytes('DealPosted(uint256,address,address,uint32,uint32,uint64,uint64)')),
  Committed:  keccak256(toBytes('Committed(uint256,address,uint32,uint64,uint256,uint64,uint32,uint32)')),
  Settled:    keccak256(toBytes('Settled(uint256,uint64,uint32,uint32,uint256,uint256)')),
  Claimed:    keccak256(toBytes('Claimed(address,uint256)')),
  Withdrawn:  keccak256(toBytes('Withdrawn(uint256,address,uint32,uint256,bool,uint64,uint32,uint32)')),
}

const ALL_ABIS = [...DEAL_FACTORY_ABI, ...DEMAND_POOL_ABI, ...SETTLER_ABI] as const

type EventType = 'DealPosted' | 'Committed' | 'Settled' | 'Claimed' | 'Withdrawn'

interface ActivityItem {
  type:        EventType
  blockNumber: bigint
  logIndex:    bigint
  txHash:      string
  label:       string
  detail:      string
}

type ScanStatus = 'loading' | 'done' | 'error'

// ── Raw log type ──────────────────────────────────────────────────────────────

type RawLog = {
  address: string; topics: Hex[]; data: Hex
  blockNumber: Hex; transactionHash: Hex; logIndex: Hex
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function topicToType(t0: string): EventType | null {
  for (const [k, v] of Object.entries(T)) {
    if (v.toLowerCase() === t0.toLowerCase()) return k as EventType
  }
  return null
}

// Safe coercions — decodeEventLog args are Record<string, unknown>
function str(v: unknown): string { return typeof v === 'string' ? v : typeof v === 'bigint' || typeof v === 'number' ? String(v) : '' }
function u64(v: unknown): bigint { return typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : typeof v === 'string' ? BigInt(v) : 0n }
function u32(v: unknown): number { return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : 0 }
function addrShort(v: unknown): string {
  const s = str(v)
  return s.length >= 10 ? s.slice(0, 6) + '\u2026' + s.slice(-4) : s
}

function decodeItem(raw: RawLog): ActivityItem | null {
  const type = topicToType(raw.topics[0] ?? '')
  if (!type) return null
  try {
    const d = decodeEventLog({ abi: ALL_ABIS, data: raw.data, topics: raw.topics as [Hex, ...Hex[]] })
    const a = d.args as Record<string, unknown>
    const base = { type, blockNumber: BigInt(raw.blockNumber), txHash: raw.transactionHash, logIndex: BigInt(raw.logIndex ?? "0x0") }
    switch (type) {
      case 'DealPosted':
        return { ...base, label: `Deal #${str(a.dealId)} posted`, detail: '' }
      case 'Committed': {
        const short = addrShort(a.buyer)
        const units = u32(a.units)
        const price = formatUsdcPrice(u64(a.paidPerUnit))
        return { ...base, label: `${short} joined deal #${str(a.dealId)}`, detail: `${units} unit${units !== 1 ? 's' : ''} at ${price}` }
      }
      case 'Settled': {
        const cp = formatUsdcPrice(u64(a.clearingPrice))
        const tu = u32(a.totalUnits)
        return { ...base, label: `Deal #${str(a.dealId)} settled`, detail: `${tu} unit${tu !== 1 ? "s" : ""} at ${cp}` }
      }
      case 'Claimed': {
        const who = str(a.recipient) || str(a.claimer)
        const short = who ? addrShort(who) : 'Wallet'
        const amt = formatUsdcPrice(u64(a.amount))
        return { ...base, label: `${short} claimed ${amt}`, detail: '' }
      }
      case 'Withdrawn': {
        const short = addrShort(a.buyer)
        return { ...base, label: `${short} withdrew from deal #${str(a.dealId)}`, detail: '' }
      }
    }
  } catch {
    return null
  }
}

/** Approximate relative time from block numbers with explicit "about" label. */
function relTime(blockNum: bigint, headBlock: bigint): string {
  const diff = Number(headBlock - blockNum)
  const secs = Math.round(diff * ARC_NETWORK.blockTime)
  if (secs < 90)   return 'just now'
  if (secs < 3600)  return `about ${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `about ${Math.round(secs / 3600)}h ago`
  return `about ${Math.round(secs / 86400)}d ago`
}

async function fetchLogs(from: bigint, to: bigint): Promise<RawLog[]> {
  return rpcFetch<RawLog[]>('eth_getLogs', [{
    address: [CONTRACTS_ACTIVE.DealFactory, CONTRACTS_ACTIVE.DemandPool, CONTRACTS_ACTIVE.Settler],
    topics: [Object.values(T)],
    fromBlock: `0x${from.toString(16)}`,
    toBlock:   `0x${to.toString(16)}`,
  }])
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface ActivityState {
  items:     ActivityItem[]
  headBlock: bigint
  status:    ScanStatus
}

function useRecentActivity(): ActivityState {
  const [state, setState] = useState<ActivityState>({ items: [], headBlock: 0n, status: 'loading' })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    let running = true
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    // Keep all decoded items here; after each chunk update the top-6 display.
    const allItems: ActivityItem[] = []

    // Sort newest-first (block desc, then logIndex desc) and take top 6.
    const byNewest = (a: ActivityItem, b: ActivityItem): number => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1
      return a.logIndex > b.logIndex ? -1 : a.logIndex < b.logIndex ? 1 : 0
    }
    const updateDisplay = (head: bigint) => {
      const sorted = [...allItems].sort(byNewest)
      if (mounted.current) setState({ items: sorted.slice(0, 6), headBlock: head, status: 'loading' })
    }

    const scan = async (): Promise<void> => {
      try {
        const head = await getLatestBlock()
        const start = CONTRACTS_ACTIVE.deployBlock
        // Scan backwards from the head: the newest events arrive first and we
        // stop as soon as there are enough to show.
        let cursor = head
        let window = SCAN_MAX_WINDOW
        let rateLimitDelay = RATE_BASE_MS
        let consecutiveSuccesses = 0

        while (running && cursor >= start) {
          const from = cursor - window + 1n > start ? cursor - window + 1n : start
          let raw: RawLog[]
          try {
            raw = await fetchLogs(from, cursor)
          } catch (e: unknown) {
            if (e instanceof RangeTooLargeError) {
              consecutiveSuccesses = 0
              if (window <= SCAN_MIN_WINDOW) break
              window = window / 2n < SCAN_MIN_WINDOW ? SCAN_MIN_WINDOW : window / 2n
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

          for (const r of raw) {
            const item = decodeItem(r)
            if (item) allItems.push(item)
          }

          // Update display progressively so the user sees results as they arrive.
          updateDisplay(head)
          if (allItems.length >= 6) break
          cursor = from - 1n
        }

        if (!running) return
        if (mounted.current) {
          const sorted = [...allItems].sort(byNewest)
          setState({ items: sorted.slice(0, 6), headBlock: head, status: 'done' })
        }
      } catch {
        if (mounted.current) setState(prev => ({ ...prev, status: 'error' }))
        return
      }

      // Poll: only fetch new blocks since the last scan head.
      const poll = async (): Promise<void> => {
        if (!running || !mounted.current) return
        try {
          const head = await getLatestBlock()
          const lastHead = state.headBlock  // stale — use a ref in a real version; ok here
          // Re-scan last ~500 blocks to pick up any missed events.
          const from = head > 500n ? head - 500n : CONTRACTS_ACTIVE.deployBlock
          const raw = await fetchLogs(from, head)
          for (const r of raw) {
            const item = decodeItem(r)
            if (item) {
              // Dedupe by txHash
              const exists = allItems.some(x => x.txHash === item.txHash && x.blockNumber === item.blockNumber)
              if (!exists) allItems.push(item)
            }
          }
          void lastHead  // suppress unused warning — present only for clarity
          const sorted = [...allItems].sort(byNewest)
          if (mounted.current) setState({ items: sorted.slice(0, 6), headBlock: head, status: 'done' })
        } catch {
          // transient — keep showing existing items
        }
        if (running && mounted.current) {
          pollTimer = setTimeout(() => { void poll() }, POLL_LIST)
        }
      }

      pollTimer = setTimeout(() => { void poll() }, POLL_LIST)
    }

    void scan()
    return () => {
      running = false
      mounted.current = false
      if (pollTimer) clearTimeout(pollTimer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return state
}

// ── Component ─────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<EventType, string> = {
  DealPosted: 'Post',
  Committed:  'Order',
  Settled:    'Settled',
  Claimed:    'Claim',
  Withdrawn:  'Withdrew',
}

function SkeletonRow() {
  return (
    <div className="px-5 py-3.5 flex items-center justify-between gap-3 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-4 w-12 rounded-md" style={{ background: 'var(--surface-muted)' }} />
        <div className="h-4 w-48 rounded-md" style={{ background: 'var(--surface-muted)' }} />
      </div>
      <div className="h-3 w-16 rounded" style={{ background: 'var(--surface-muted)' }} />
    </div>
  )
}

export function LiveActivity({ onProof }: { onProof: () => void }) {
  const { items, headBlock, status } = useRecentActivity()

  return (
    <section>
      <h2 className="display text-xl font-bold mb-5" style={{ color: 'var(--ink)' }}>
        Live activity
      </h2>

      <div className="rounded-2xl overflow-hidden"
        style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
        {status === 'loading' && items.length === 0 ? (
          // Loading: skeleton rows
          <>
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} style={{ borderTop: i ? '1px solid var(--border)' : undefined }}>
                <SkeletonRow />
              </div>
            ))}
          </>
        ) : status === 'error' ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Could not load activity.{' '}
              <button onClick={onProof} className="underline hover:opacity-70 transition-opacity"
                style={{ color: 'var(--accent)' }}>
                View the Proof page.
              </button>
            </p>
          </div>
        ) : items.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm" style={{ color: 'var(--muted)' }}>No activity yet.</p>
          </div>
        ) : (
          items.map((item, i) => (
            <div key={`${item.txHash}-${i}`}
              className="px-5 py-3.5 flex items-center justify-between gap-3"
              style={{ borderTop: i ? '1px solid var(--border)' : undefined }}>
              <div className="flex items-center gap-3 min-w-0">
                <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
                  style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
                  {TYPE_LABELS[item.type]}
                </span>
                <div className="min-w-0">
                  <p className="text-sm truncate" style={{ color: 'var(--ink)' }}>{item.label}</p>
                  {item.detail && (
                    <p className="text-xs truncate" style={{ color: 'var(--muted)' }}>{item.detail}</p>
                  )}
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                <span className="text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
                  {headBlock > 0n ? relTime(item.blockNumber, headBlock) : ''}
                </span>
                <a href={`${ARC_NETWORK.explorerBase}/tx/${item.txHash}`}
                  target="_blank" rel="noopener noreferrer"
                  aria-label="View on explorer"
                  className="hover:opacity-60 transition-opacity"
                  style={{ color: 'var(--muted)' }}>
                  <ExternalLink className="size-3.5" />
                </a>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-3 text-right">
        <button onClick={onProof}
          className="text-sm font-medium hover:opacity-70 transition-opacity"
          style={{ color: 'var(--accent)' }}>
          View all on the Proof page
        </button>
      </div>
    </section>
  )
}
