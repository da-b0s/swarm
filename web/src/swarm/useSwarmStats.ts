import { useMemo } from 'react'
import { useReadContracts } from 'wagmi'
import { CONTRACTS_ACTIVE, ARC_NETWORK, POLL_LIST } from './config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI } from './abis'
import { useDealCount } from './hooks'
import { computePriceAt } from './utils'

export interface SwarmStats {
  volume:   bigint   // USDC (6 dp): units × price, settled deals plus open orders at today's price
  saved:    bigint   // USDC (6 dp): what buyers saved against each deal's starting price
  units:    number
  buyers:   number   // unique wallets
  deals:    number
}

/** Headline numbers for the homepage, read live from the contracts. Refunded deals count as no volume. */
export function useSwarmStats(): SwarmStats | undefined {
  const { data: countRaw } = useDealCount()
  const count = countRaw !== undefined ? Number(countRaw) : 0
  const ids = useMemo(() => Array.from({ length: count }, (_, i) => BigInt(i + 1)), [count])
  const chainId = ARC_NETWORK.chainId
  const q = { enabled: count > 0, refetchInterval: POLL_LIST, refetchIntervalInBackground: false }

  const { data: deals } = useReadContracts({ query: q, contracts: ids.map((id) => ({
    address: CONTRACTS_ACTIVE.DealFactory, abi: DEAL_FACTORY_ABI, functionName: 'getDeal' as const, args: [id] as const, chainId })) })
  const { data: units } = useReadContracts({ query: q, contracts: ids.map((id) => ({
    address: CONTRACTS_ACTIVE.DemandPool, abi: DEMAND_POOL_ABI, functionName: 'totalUnits' as const, args: [id] as const, chainId })) })
  const { data: buyers } = useReadContracts({ query: q, contracts: ids.map((id) => ({
    address: CONTRACTS_ACTIVE.DemandPool, abi: DEMAND_POOL_ABI, functionName: 'getBuyers' as const, args: [id] as const, chainId })) })

  return useMemo(() => {
    if (countRaw === undefined) return undefined
    if (count > 0 && (!deals || !units || !buyers)) return undefined
    const s: SwarmStats = { volume: 0n, saved: 0n, units: 0, buyers: 0, deals: count }
    const wallets = new Set<string>()
    ids.forEach((_, i) => {
      const d = deals?.[i]?.result
      const n = Number(units?.[i]?.result ?? 0)
      if (!d || d.state === 2 || n === 0) return
      const tiers = d.tiers.map((t) => ({ minUnits: Number(t.minUnits), pricePerUnit: BigInt(t.pricePerUnit) }))
      const price = computePriceAt(tiers, n)
      s.volume += price * BigInt(n)
      if (tiers.length) s.saved += (tiers[0].pricePerUnit - price) * BigInt(n)
      s.units += n
      for (const b of (buyers?.[i]?.result ?? []) as readonly string[]) wallets.add(b.toLowerCase())
    })
    s.buyers = wallets.size
    return s
  }, [countRaw, count, ids, deals, units, buyers])
}
