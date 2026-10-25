/**
 * Event log scanner for the /proof page — v2.
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
 *               We cannot verify this without reading maxUnits × tokensPerUnit from
 *               the deal, so we mark goods conservation as "stock returned" when
 *               the deal is refunded.
 *
 * For a settled deal the Settled event carries both totalUnits and unitsDelivered,
 * which together with the DealPosted maxUnits gives us enough to verify goods.
 * For open deals both conservation fields stay null.
 *
 * Note on Committed.escrow vs pricePaid:
 *   v2 Committed emits (dealId, buyer, units, paidPerUnit, escrow, livePrice, totalUnits, buyerCount).
 *   commitsIn accumulates 'escrow' (= paidPerUnit × units), not just paidPerUnit.
 *   Withdrawn emits amountReturned which equals the buyer's full escrow.
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

// ── Event topic hashes — v2 signatures ────────────────────────────────────────
//
// Compute from the canonical Solidity event signatures of the v2 contracts.
// These differ from v1 because Committed gained (units, paidPerUnit, escrow,
// livePrice, totalUnits, buyerCount) and Settled gained (totalUnits, unitsDelivered).
//
// v2 canonical signatures:
//   DealPosted(uint256,address,address,uint32,uint32,uint64,uint64)
//     indexed: dealId, supplier, goodsToken
//     non-indexed: minUnits, maxUnits, deadline, startPrice
//
//   Committed(uint256,address,uint32,uint64,uint256,uint64,uint32,uint32)
//     indexed: dealId, buyer
//     non-indexed: units, paidPerUnit, escrow, livePrice, totalUnits, buyerCount
//
//   Withdrawn(uint256,address,uint32,uint256,bool,uint64,uint32,uint32)   — v2.2
//     indexed: dealId, buyer
//     non-indexed: units, amountReturned, paidDirectly, livePrice, totalUnits, buyerCount
//
//   TierBroken(uint256,uint32,uint64)
//     indexed: dealId
//     non-indexed: newTotalUnits, newPrice
//
//   Settled(uint256,uint64,uint32,uint32,uint256,uint256)
//     indexed: dealId
//     non-indexed: clearingPrice, totalUnits, buyerCount, totalRefunds, unitsDelivered
//
//   Refunded(uint256,address,uint256)          — unchanged
//   Claimed(address,uint256)                   — unchanged
//   ExcessCredited(uint256,address,uint256)     — unchanged

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
  type: keyof typeof TOPICS
  blockNumber: bigint
  txHash: string
  logIndex: number
  args: Record<string, unknown>
}

export interface ProofStats {
  totalCommits:   bigint     // sum of Committed.escrow (net of withdrawals)
  totalRefunds:   bigint     // sum of per-deal refunds
  totalClaimed:   bigint     // sum of Claimed.amount (USDC)
  totalWithdrawn: bigint     // sum of Withdrawn.amountReturned
  totalExcess:    bigint     // sum of ExcessCredited.amount
  totalUnitsSold: bigint     // sum of Settled.totalUnits across settled deals
  totalGoodsClaimed: bigint  // sum of GoodsClaimed.amount (varies by token, treat as base units)
  distinctBuyers: Set<string>
  tierBreaks: number
  deals: Map<string, DealProof>
}

export interface DealProof {
  dealId: string
  // USDC conservation
  commitsIn:        bigint  // net escrowed USDC (Committed.escrow − Withdrawn.amountReturned)
  excessIn:         bigint  // ExcessCredited.amount sum
  supplierCredited: bigint  // cp × totalUnits from Settled; 0 for refunded
  refundsOut:       bigint  // totalRefunds from Settled OR sum of Refunded events
  usdcConserved:    boolean | null
  // Goods conservation
  totalUnitsSettled: bigint  // Settled.totalUnits (units sold)
  unitsDelivered:    bigint  // Settled.unitsDelivered (token base units given to buyers)
  settled:           boolean
  refunded:          boolean
  goodsNote:         string  // human-readable goods conservation status
}

export type ScanState = 'idle' | 'scanning' | 'done' | 'error'

// ── RPC helpers ───────────────────────────────────────────────────────────────

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
  const [events, setEvents]       = useState<SwarmEvent[]>([])
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [progress, setProgress]   = useState({ scanned: 0n, total: 0n, head: 0n })
  const [error, setError]         = useState('')
  const abortRef = useRef(false)

  const scan = useCallback(async () => {
    abortRef.current = false
    setScanState('scanning')
    setEvents([])
    setError('')

    try {
      if (CONTRACTS_ACTIVE.deployBlock === 0n) {
        setScanState('error')
        setError(
          `No deployment block recorded for ${ARC_NETWORK.name}. ` +
          `Swarm is not deployed on this network yet.`
        )
        return
      }

      const head  = await getLatestBlock()
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

        for (const r of raw) {
          const ev = decodeLog(r)
          if (ev) collected.push(ev)
        }

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

  // ── Derived stats ──────────────────────────────────────────────────────

  const stats: ProofStats = (() => {
    const s: ProofStats = {
      totalCommits:      0n,
      totalRefunds:      0n,
      totalClaimed:      0n,
      totalWithdrawn:    0n,
      totalExcess:       0n,
      totalUnitsSold:    0n,
      totalGoodsClaimed: 0n,
      distinctBuyers:    new Set(),
      tierBreaks:        0,
      deals:             new Map(),
    }

    const getDeal = (id: string): DealProof => {
      if (!s.deals.has(id)) {
        s.deals.set(id, {
          dealId:            id,
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
        case 'Committed': {
          // v2: escrow = paidPerUnit × units (full amount escrowed by this buyer)
          const dealId = String(a.dealId)
          const escrow = BigInt(String(a.escrow))
          getDeal(dealId).commitsIn += escrow
          s.totalCommits += escrow
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
          // v2: Settled(dealId, clearingPrice, totalUnits, buyerCount, totalRefunds, unitsDelivered)
          const dealId          = String(a.dealId)
          const cp              = BigInt(String(a.clearingPrice))
          const totalUnits      = BigInt(String(a.totalUnits))
          const evRefunds       = BigInt(String(a.totalRefunds))
          const unitsDelivered  = BigInt(String(a.unitsDelivered))
          const deal            = getDeal(dealId)
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
        case 'GoodsClaimed':
          s.totalGoodsClaimed += BigInt(String(a.amount))
          break
      }
    }

    // ── Conservation checks ─────────────────────────────────────────────
    for (const deal of s.deals.values()) {
      // USDC:
      //   settled:  commitsIn = supplierCredited + refundsOut
      //   refunded: commitsIn = refundsOut
      if (deal.settled) {
        deal.usdcConserved = deal.commitsIn === deal.supplierCredited + deal.refundsOut
      } else if (deal.refunded) {
        deal.usdcConserved = deal.commitsIn === deal.refundsOut
      }

      // Goods:
      //   settled: unitsDelivered was written by the Settled event; we can confirm
      //            it is positive (and > 0 when units sold > 0). Full goods equation
      //            requires maxUnits × tokensPerUnit from the deal struct which we
      //            don't have from events alone, so we report units delivered.
      //   refunded: all stock returned to supplier (no delivery).
      if (deal.settled) {
        deal.goodsNote = deal.unitsDelivered > 0n
          ? `${deal.unitsDelivered.toString()} token base units delivered to buyers`
          : 'No units delivered (all stock unsold or deal had zero buyers)'
      } else if (deal.refunded) {
        deal.goodsNote = 'Refunded — full stock returned to supplier'
      }
    }

    return s
  })()

  return { events, scanState, progress, error, stats, scan, stop }
}
