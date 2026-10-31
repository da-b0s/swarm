/**
 * useSupplierTokens — collect unique goodsToken addresses from deals where
 * the connected wallet is the supplier, using batched getDeal reads.
 *
 * Reads at most MAX_DEALS deal IDs from the factory (newest-first), filters
 * to deals owned by `walletAddr`, and returns the unique goodsToken addresses,
 * excluding any address already in GOODS_TOKENS (those are listed, not custom).
 *
 * Deliberately avoids event-log scans; uses only view calls so it works in
 * read-only mode with no wallet signature.
 */

import { useMemo } from 'react'
import { useReadContracts } from 'wagmi'
import { DEAL_FACTORY_ABI } from './abis'
import { CONTRACTS_ACTIVE, ARC_NETWORK, GOODS_TOKENS } from './config'
import { useDealCount } from './hooks'

const CHAIN_ID  = ARC_NETWORK.chainId
const MAX_DEALS = 50   // look at the most-recent 50 deals max

export function useSupplierTokens(walletAddr: `0x${string}` | undefined): string[] {
  const { data: dealCount } = useDealCount()

  // Build call list: newest-first, up to MAX_DEALS IDs
  const dealIds: bigint[] = useMemo(() => {
    if (!dealCount || dealCount === 0n) return []
    const total = Number(dealCount)
    const start = Math.max(1, total - MAX_DEALS + 1)
    const ids: bigint[] = []
    for (let id = total; id >= start; id--) ids.push(BigInt(id))
    return ids
  }, [dealCount])

  const calls = useMemo(() =>
    dealIds.map(id => ({
      address:      CONTRACTS_ACTIVE.DealFactory,
      abi:          DEAL_FACTORY_ABI,
      functionName: 'getDeal' as const,
      args:         [id] as [bigint],
      chainId:      CHAIN_ID,
    })),
    [dealIds]
  )

  const { data } = useReadContracts({
    contracts: calls,
    query: {
      enabled: calls.length > 0 && !!walletAddr,
      staleTime: 60_000,
    },
  })

  return useMemo(() => {
    if (!data || !walletAddr) return []
    const listedLower = new Set(GOODS_TOKENS.map(t => t.address.toLowerCase()))
    const seen = new Set<string>()
    const out: string[] = []
    for (const result of data) {
      if (result.status !== 'success') continue
      const deal = result.result as { supplier: `0x${string}`; goodsToken: `0x${string}` } | undefined
      if (!deal) continue
      if (deal.supplier.toLowerCase() !== walletAddr.toLowerCase()) continue
      const gtLower = deal.goodsToken.toLowerCase()
      if (listedLower.has(gtLower)) continue
      if (seen.has(gtLower)) continue
      seen.add(gtLower)
      out.push(gtLower)
    }
    return out
  }, [data, walletAddr])
}
