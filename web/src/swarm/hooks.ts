/** Swarm v2 contract hooks — thin wrappers around wagmi useReadContract */

import { useReadContract, useReadContracts, useBlock } from 'wagmi'
import { useState, useEffect, useMemo, useRef } from 'react'
import { CONTRACTS_ACTIVE, ARC_NETWORK } from './config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI, SETTLER_ABI, ERC20_ABI } from './abis'

const CHAIN_ID = ARC_NETWORK.chainId

// ─── Deal types ───────────────────────────────────────────────────────────────

export type DealTier = {
  minUnits: number     // unit threshold to unlock this price
  pricePerUnit: bigint // 6-decimal USDC per unit
}

export type DealData = {
  supplier:         `0x${string}`
  goodsToken:       `0x${string}`
  tokensPerUnit:    bigint
  tiers:            DealTier[]
  minUnits:         number
  maxUnits:         number
  maxUnitsPerBuyer: number
  maxBuyers:        number
  deadline:         bigint
  state:            number    // 0=Open, 1=Settled, 2=Refunded
  title:            string
  description:      string
}

// ─── Deal reads ───────────────────────────────────────────────────────────────

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
      supplier:         data.supplier,
      goodsToken:       data.goodsToken,
      tokensPerUnit:    BigInt(data.tokensPerUnit),
      tiers:            data.tiers.map(t => ({
        minUnits:     Number(t.minUnits),
        pricePerUnit: BigInt(t.pricePerUnit),
      })),
      minUnits:         Number(data.minUnits),
      maxUnits:         Number(data.maxUnits),
      maxUnitsPerBuyer: Number(data.maxUnitsPerBuyer),
      maxBuyers:        Number(data.maxBuyers),
      deadline:         BigInt(data.deadline),
      state:            Number(data.state),
      title:            data.title,
      description:      data.description,
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

// ─── Pool reads ───────────────────────────────────────────────────────────────

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

export function useTotalUnits(dealId: bigint | undefined) {
  return useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'totalUnits',
    args: dealId !== undefined ? [dealId] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: dealId !== undefined, refetchInterval: 3000 },
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

/** Returns the buyer's committed units (0 if not committed). */
export function useUnitsOf(dealId: bigint | undefined, buyer: `0x${string}` | undefined) {
  return useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'unitsOf',
    args: dealId !== undefined && buyer ? [dealId, buyer] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: dealId !== undefined && !!buyer, refetchInterval: 4000 },
  })
}

/** Returns the per-unit price the buyer paid at commit time. */
export function usePaidPerUnit(dealId: bigint | undefined, buyer: `0x${string}` | undefined) {
  return useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'paidPerUnit',
    args: dealId !== undefined && buyer ? [dealId, buyer] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: dealId !== undefined && !!buyer, refetchInterval: 4000 },
  })
}

/** Returns the total USDC escrowed by the buyer (paidPerUnit × units). */
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

/** Fetch tierCount for each tier in a deal — used for WouldStrandBuyer simulation */
export function useTierCounts(dealId: bigint | undefined, tiers: DealTier[]) {
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

  const tierCountMap = new Map<bigint, number>()
  if (data) {
    tiers.forEach((t, i) => {
      const v = data[i]?.result
      if (v !== undefined) tierCountMap.set(t.pricePerUnit, Number(v))
    })
  }

  return { tierCountMap, refetch }
}

// ─── Settler reads ────────────────────────────────────────────────────────────

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

/** How many tokens of `goodsToken` the address can claim from the Settler. */
export function useGoodsClaimable(
  goodsToken: `0x${string}` | undefined,
  who: `0x${string}` | undefined,
) {
  const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`
  return useReadContract({
    address: CONTRACTS_ACTIVE.Settler,
    abi: SETTLER_ABI,
    functionName: 'goodsClaimable',
    args: goodsToken && who ? [goodsToken, who] : undefined,
    chainId: CHAIN_ID,
    query: {
      enabled: !!goodsToken && goodsToken !== ZERO && !!who,
      refetchInterval: 6000,
    },
  })
}

// ─── Goods token metadata ─────────────────────────────────────────────────────

export type GoodsTokenMeta = { symbol: string; decimals: number }

export function useGoodsTokenMeta(
  goodsToken: `0x${string}` | undefined,
): GoodsTokenMeta | undefined {
  const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`
  const enabled = !!goodsToken && goodsToken !== ZERO

  const { data: sym } = useReadContract({
    address: goodsToken,
    abi: ERC20_ABI,
    functionName: 'symbol',
    chainId: CHAIN_ID,
    query: { enabled, staleTime: Infinity },
  })
  const { data: dec } = useReadContract({
    address: goodsToken,
    abi: ERC20_ABI,
    functionName: 'decimals',
    chainId: CHAIN_ID,
    query: { enabled, staleTime: Infinity },
  })

  if (!sym || dec === undefined) return undefined
  return { symbol: sym, decimals: Number(dec) }
}

// ─── Block-based countdown ───────────────────────────────────────────────────

/**
 * Returns the current chain timestamp in seconds, anchored on the latest block
 * and ticked locally from measured elapsed time. Returns 0 until the first
 * block arrives — callers must not treat 0 as a valid timestamp.
 */
export function useChainNow(): number {
  const { data: block } = useBlock({ chainId: CHAIN_ID, watch: true })

  const anchorRef = useRef<{ chainTs: number; localMs: number } | null>(null)
  const [nowSec, setNowSec] = useState(0)

  const blockTs = block?.timestamp !== undefined ? Number(block.timestamp) : undefined

  useEffect(() => {
    if (blockTs === undefined) return
    anchorRef.current = { chainTs: blockTs, localMs: Date.now() }
  }, [blockTs])

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
 * Returns seconds remaining to deadline, driven by chain time.
 * Returns undefined until chain time is known.
 */
export function useBlockCountdown(deadlineTimestamp: bigint | undefined): number | undefined {
  const now = useChainNow()
  if (!deadlineTimestamp) return 0
  if (now === 0) return undefined
  const remaining = Number(deadlineTimestamp) - now
  return remaining > 0 ? remaining : 0
}

// ─── Computed live state ──────────────────────────────────────────────────────

/** Full live state for a v2 deal room — batched reads */
export function useLiveDealState(dealId: bigint | undefined) {
  const { deal, isLoading: dealLoading, refetch: refetchDeal } = useDeal(dealId)
  const { data: buyerCount,   refetch: refetchCount  } = useBuyerCount(dealId)
  const { data: totalUnitsBN, refetch: refetchUnits  } = useTotalUnits(dealId)
  const { data: clearingPriceBN, refetch: refetchPrice } = useClearingPrice(dealId)

  const refetchAll = () => {
    void refetchDeal()
    void refetchCount()
    void refetchUnits()
    void refetchPrice()
  }

  const currentPrice  = clearingPriceBN !== undefined ? BigInt(clearingPriceBN) : 0n
  const totalUnitsNum = totalUnitsBN    !== undefined ? Number(totalUnitsBN)     : 0
  const buyerCountNum = buyerCount      !== undefined ? Number(buyerCount)       : 0

  // Next cheaper tier: the first unreached tier that is cheaper than the
  // current live price. Skipping tiers that are not cheaper means we never
  // tell the user "X more units and everyone pays the same price".
  let nextTier: { tier: DealTier; unitsNeeded: number } | undefined = undefined
  if (deal && totalUnitsBN !== undefined) {
    for (let i = 0; i < deal.tiers.length; i++) {
      if (
        totalUnitsNum < deal.tiers[i].minUnits &&
        deal.tiers[i].pricePerUnit < currentPrice
      ) {
        nextTier = {
          tier: deal.tiers[i],
          unitsNeeded: deal.tiers[i].minUnits - totalUnitsNum,
        }
        break
      }
    }
  }

  // Progress toward next tier (0..1) measured in units
  let tierProgress = 1
  if (deal && totalUnitsBN !== undefined && nextTier) {
    let prevThreshold = 0
    for (let i = deal.tiers.length - 1; i >= 0; i--) {
      if (totalUnitsNum >= deal.tiers[i].minUnits) {
        prevThreshold = deal.tiers[i].minUnits
        break
      }
    }
    const range = nextTier.tier.minUnits - prevThreshold
    tierProgress = range > 0 ? (totalUnitsNum - prevThreshold) / range : 1
  }

  return {
    deal,
    dealLoading,
    buyerCount:   buyerCount      !== undefined ? buyerCountNum   : undefined,
    totalUnits:   totalUnitsBN    !== undefined ? totalUnitsNum   : undefined,
    clearingPrice: currentPrice,
    nextTier,
    tierProgress,
    refetchAll,
  }
}
