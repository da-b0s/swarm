/** Swarm contract hooks — thin wrappers around wagmi useReadContract */

import { useReadContract, useReadContracts, useBlock } from 'wagmi'
import { useState, useEffect, useMemo, useRef } from 'react'
import { CONTRACTS_ACTIVE, ARC_NETWORK } from './config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI, SETTLER_ABI } from './abis'


const CHAIN_ID = ARC_NETWORK.chainId

// ─── Deal data ────────────────────────────────────────────────────────────────

export type DealTier = { minBuyers: number; pricePerUnit: bigint }

export type DealData = {
  supplier: `0x${string}`
  tiers: DealTier[]
  minBuyers: number
  deadline: bigint
  cap: number
  state: number  // 0=Open, 1=Settled, 2=Refunded
}

export function useDeal(dealId: bigint | undefined) {
  const { data, isLoading, refetch } = useReadContract({
    address: CONTRACTS_ACTIVE.DealFactory,
    abi: DEAL_FACTORY_ABI,
    functionName: 'getDeal',
    args: dealId !== undefined ? [dealId] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: dealId !== undefined, refetchInterval: 4000 },
  })

  const deal = useMemo<DealData | undefined>(() => {
    if (!data) return undefined
    return {
      supplier: data.supplier,
      tiers: data.tiers.map(t => ({ minBuyers: Number(t.minBuyers), pricePerUnit: BigInt(t.pricePerUnit) })),
      minBuyers: Number(data.minBuyers),
      deadline: BigInt(data.deadline),
      cap: Number(data.cap),
      state: Number(data.state),
    }
  }, [data])

  return { deal, isLoading, refetch }
}

export function useDealCount() {
  return useReadContract({
    address: CONTRACTS_ACTIVE.DealFactory,
    abi: DEAL_FACTORY_ABI,
    functionName: 'dealCount',
    chainId: CHAIN_ID,
    query: { refetchInterval: 5000 },
  })
}

// ─── Pool state ───────────────────────────────────────────────────────────────

export function useBuyerCount(dealId: bigint | undefined) {
  return useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'getBuyerCount',
    args: dealId !== undefined ? [dealId] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: dealId !== undefined, refetchInterval: 3000 },
  })
}

export function useBuyers(dealId: bigint | undefined) {
  return useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'getBuyers',
    args: dealId !== undefined ? [dealId] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: dealId !== undefined, refetchInterval: 5000 },
  })
}

export function useClearingPrice(dealId: bigint | undefined) {
  return useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'clearingPrice',
    args: dealId !== undefined ? [dealId] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: dealId !== undefined, refetchInterval: 3000 },
  })
}

export function useEscrowed(dealId: bigint | undefined, buyer: `0x${string}` | undefined) {
  return useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'escrowed',
    args: dealId !== undefined && buyer ? [dealId, buyer] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: dealId !== undefined && !!buyer, refetchInterval: 4000 },
  })
}

// Fetch tierCount for each tier in a deal — used for WouldStrandBuyer simulation
export function useTierCounts(dealId: bigint | undefined, tiers: DealTier[]) {
  // Build a stable key from tier prices to avoid memoization issues
  const tiersKey = tiers.map(t => t.pricePerUnit.toString()).join(',')

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const contracts = useMemo(() =>
    tiers.map(t => ({
      address: CONTRACTS_ACTIVE.DemandPool,
      abi: DEMAND_POOL_ABI,
      functionName: 'tierCount' as const,
      args: [dealId!, t.pricePerUnit] as const,
      chainId: CHAIN_ID,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dealId, tiersKey]
  )

  const { data, refetch } = useReadContracts({
    contracts,
    query: { enabled: dealId !== undefined && tiers.length > 0, refetchInterval: 4000 },
  })

  // Build tierCountMap inline (no useMemo — avoid React Compiler memoization warnings)
  const tierCountMap = new Map<bigint, number>()
  if (data) {
    tiers.forEach((t, i) => {
      const v = data[i]?.result
      if (v !== undefined) tierCountMap.set(t.pricePerUnit, Number(v))
    })
  }

  return { tierCountMap, refetch }
}

// ─── Settler ─────────────────────────────────────────────────────────────────

export function useClaimable(who: `0x${string}` | undefined) {
  return useReadContract({
    address: CONTRACTS_ACTIVE.Settler,
    abi: SETTLER_ABI,
    functionName: 'claimable',
    args: who ? [who] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!who, refetchInterval: 6000 },
  })
}

// ─── Block-based countdown ───────────────────────────────────────────────────

/**
 * Seconds remaining to the deadline, measured against CHAIN time.
 *
 * The contract compares `block.timestamp >= deal.deadline`, so the browser clock
 * is the wrong reference: a viewer whose clock runs minutes fast sees "Ended"
 * while commits still succeed, and one running slow sees time left while
 * `commit` reverts with DeadlinePassed. Neither is acceptable on the screen that
 * exists to tell people how long they have.
 *
 * So anchor on the latest block's timestamp and tick locally from that anchor
 * using elapsed wall time, which only measures an interval rather than trusting
 * the clock's absolute value. Re-anchors as new blocks arrive.
 */
export function useChainNow(): number {
  const { data: block } = useBlock({ chainId: CHAIN_ID, watch: true })

  // The anchor lives in a ref, not state: writing it must not start a render,
  // and nothing reads it during one.
  const anchorRef = useRef<{ chainTs: number; localMs: number } | null>(null)
  const [nowSec, setNowSec] = useState(0)

  const blockTs = block?.timestamp !== undefined ? Number(block.timestamp) : undefined

  useEffect(() => {
    if (blockTs === undefined) return
    anchorRef.current = { chainTs: blockTs, localMs: Date.now() }
  }, [blockTs])

  // Tick from the anchor. Date.now() is only ever read inside this callback, so
  // render stays pure and the value advances by measured elapsed time rather
  // than by whatever the local clock claims the absolute time is.
  useEffect(() => {
    const tick = () => {
      const a = anchorRef.current
      if (!a) return
      setNowSec(a.chainTs + Math.floor((Date.now() - a.localMs) / 1000))
    }
    const t = setInterval(tick, 500)
    return () => clearInterval(t)
  }, [])

  return nowSec
}

/**
 * Returns seconds remaining to deadline, driven by `useChainNow`.
 * Returns undefined until chain time is known, so callers can withhold a
 * countdown rather than render a wrong one.
 */
export function useBlockCountdown(deadlineTimestamp: bigint | undefined): number | undefined {
  const now = useChainNow()
  if (!deadlineTimestamp) return 0
  if (now === 0) return undefined
  const remaining = Number(deadlineTimestamp) - now
  return remaining > 0 ? remaining : 0
}

// ─── Computed live state ──────────────────────────────────────────────────────

/** Full live state for a deal room — batched reads */
export function useLiveDealState(dealId: bigint | undefined) {
  const { deal, isLoading: dealLoading, refetch: refetchDeal } = useDeal(dealId)
  const { data: buyerCount, refetch: refetchCount } = useBuyerCount(dealId)
  const { data: clearingPrice, refetch: refetchPrice } = useClearingPrice(dealId)

  const refetchAll = () => {
    void refetchDeal()
    void refetchCount()
    void refetchPrice()
  }

  // Current price as bigint (0 if not loaded)
  const currentPrice = clearingPrice ? BigInt(clearingPrice) : 0n

  // Next tier threshold (inline, no useMemo — deps include deal.tiers which isn't stable)
  const count = buyerCount !== undefined ? Number(buyerCount) : 0
  let nextTier: { tier: DealTier; buyersNeeded: number } | undefined = undefined
  if (deal && buyerCount !== undefined) {
    for (let i = 0; i < deal.tiers.length; i++) {
      if (count < deal.tiers[i].minBuyers) {
        nextTier = { tier: deal.tiers[i], buyersNeeded: deal.tiers[i].minBuyers - count }
        break
      }
    }
  }

  // Progress to next tier (0..1)
  let tierProgress = 1
  if (deal && buyerCount !== undefined && nextTier) {
    let prevThreshold = 0
    for (let i = deal.tiers.length - 1; i >= 0; i--) {
      if (count >= deal.tiers[i].minBuyers) { prevThreshold = deal.tiers[i].minBuyers; break }
    }
    const range = nextTier.tier.minBuyers - prevThreshold
    tierProgress = range > 0 ? (count - prevThreshold) / range : 1
  }

  return {
    deal,
    dealLoading,
    buyerCount: buyerCount !== undefined ? count : undefined,
    clearingPrice: currentPrice,
    nextTier,
    tierProgress,
    refetchAll,
  }
}
