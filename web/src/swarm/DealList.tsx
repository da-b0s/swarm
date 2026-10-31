/**
 * DealList — browse all deals, grouped into Active / Ended tabs.
 *
 * Reads dealCount then batches getDeal calls for all deal IDs.
 * Active deals are sorted by time left (soonest deadline first).
 * Clicking a card calls onSelectDeal(dealId).
 * With no active deals, shows an empty state with a Post button.
 * Logged-out users see the list but not the order actions.
 */

import { useMemo, useState, useCallback } from 'react'
import { useReadContracts } from 'wagmi'
import { motion } from 'framer-motion'
import { Clock, ChevronRight, PlusCircle, Package } from 'lucide-react'
import { CONTRACTS_ACTIVE, ARC_NETWORK, GOODS_TOKENS, POLL_DEAL_ROOM, POLL_LIST } from './config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI, SETTLER_ABI } from './abis'
import { useDealCount, useChainNow, useGoodsTokenMeta } from './hooks'
import { formatUsdcPrice, formatCountdown, computePriceAt } from './utils'
import { PricePerToken } from './PricePerToken'
import { useMarketRates } from './useMarketRates'

const CHAIN_ID = ARC_NETWORK.chainId

export type DealListTab = 'active' | 'ended' | 'yours'

interface Props {
  activeTab:      DealListTab
  onTabChange:    (t: DealListTab) => void
  onSelectDeal:   (id: bigint) => void
  onPost:         () => void
  walletAddr:     `0x${string}` | undefined
}

interface DealSummary {
  dealId:        bigint
  title:         string
  goodsToken:    `0x${string}`
  tokensPerUnit: bigint
  tiers:         { minUnits: number; pricePerUnit: bigint }[]
  minUnits:      number
  maxUnits:      number
  deadline:      bigint
  state:         number
  totalUnits:    number
  clearingPrice: bigint
  supplier:      `0x${string}`
}

export function DealList({ activeTab, onTabChange, onSelectDeal, onPost, walletAddr }: Props) {
  const { data: dealCountRaw } = useDealCount()
  const dealCount   = dealCountRaw !== undefined ? Number(dealCountRaw) : 0
  const nowSec      = useChainNow()
  const marketRates = useMarketRates()
  const [tokenFilter, setTokenFilter] = useState<string>('all')

  // Build batched getDeal calls for IDs 1..dealCount
  const dealCalls = useMemo(() =>
    Array.from({ length: dealCount }, (_, i) => ({
      address: CONTRACTS_ACTIVE.DealFactory,
      abi: DEAL_FACTORY_ABI,
      functionName: 'getDeal' as const,
      args: [BigInt(i + 1)] as const,
      chainId: CHAIN_ID,
    })),
    [dealCount]
  )

  // Batch totalUnits calls
  const totalUnitsCalls = useMemo(() =>
    Array.from({ length: dealCount }, (_, i) => ({
      address: CONTRACTS_ACTIVE.DemandPool,
      abi: DEMAND_POOL_ABI,
      functionName: 'totalUnits' as const,
      args: [BigInt(i + 1)] as const,
      chainId: CHAIN_ID,
    })),
    [dealCount]
  )

  // Batch unitsOf calls for the connected wallet — to detect buyer membership
  const unitsOfCalls = useMemo(() => {
    if (!walletAddr) return []
    const zero = '0x0000000000000000000000000000000000000000' as `0x${string}`
    return Array.from({ length: dealCount }, (_, i) => ({
      address: CONTRACTS_ACTIVE.DemandPool,
      abi: DEMAND_POOL_ABI,
      functionName: 'unitsOf' as const,
      args: [BigInt(i + 1), walletAddr ?? zero] as const,
      chainId: CHAIN_ID,
    }))
  }, [dealCount, walletAddr])

  const { data: dealResults } = useReadContracts({
    contracts: dealCalls,
    query: { enabled: dealCount > 0, refetchInterval: POLL_LIST, refetchIntervalInBackground: false },
  })

  const { data: unitResults } = useReadContracts({
    contracts: totalUnitsCalls,
    query: { enabled: dealCount > 0, refetchInterval: POLL_DEAL_ROOM, refetchIntervalInBackground: false },
  })

  const { data: myUnitsResults } = useReadContracts({
    contracts: unitsOfCalls,
    query: { enabled: unitsOfCalls.length > 0, refetchInterval: POLL_DEAL_ROOM, refetchIntervalInBackground: false },
  })

  // ── Claimable batch ───────────────────────────────────────────────────────
  // One call: claimable(wallet)
  // N calls:  goodsClaimable(token, wallet) for each distinct goods token
  // Only meaningful when the wallet is connected and there are deals.
  const claimableCalls = useMemo(() => {
    if (!walletAddr || dealCount === 0) return []
    return [
      {
        address: CONTRACTS_ACTIVE.Settler,
        abi: SETTLER_ABI,
        functionName: 'claimable' as const,
        args: [walletAddr] as const,
        chainId: CHAIN_ID,
      },
    ]
  }, [walletAddr, dealCount])

  const goodsClaimableCalls = useMemo(() => {
    if (!walletAddr || dealCount === 0) return []
    // Collect distinct token addresses seen so far; fall back to GOODS_TOKENS
    // if deal data isn't loaded yet.
    const tokens = new Set(GOODS_TOKENS.map(t => t.address.toLowerCase() as `0x${string}`))
    return Array.from(tokens).map(token => ({
      address: CONTRACTS_ACTIVE.Settler,
      abi: SETTLER_ABI,
      functionName: 'goodsClaimable' as const,
      args: [token, walletAddr] as const,
      chainId: CHAIN_ID,
    }))
  }, [walletAddr, dealCount])

  const { data: claimableResults, refetch: refetchClaimable } = useReadContracts({
    contracts: claimableCalls,
    query: { enabled: claimableCalls.length > 0, refetchInterval: POLL_DEAL_ROOM, refetchIntervalInBackground: false },
  })
  const { data: goodsClaimableResults, refetch: refetchGoodsClaimable } = useReadContracts({
    contracts: goodsClaimableCalls,
    query: { enabled: goodsClaimableCalls.length > 0, refetchInterval: POLL_DEAL_ROOM, refetchIntervalInBackground: false },
  })

  // After a claim anywhere, re-read claimable totals.
  // (GlobalClaimsBanner fires its own refetch; we mirror it here for DealList.)
  // Build lookup: token (lowercase) → claimable amount
  const goodsClaimableMap = useMemo(() => {
    const m = new Map<string, bigint>()
    const tokens = Array.from(new Set(GOODS_TOKENS.map(t => t.address.toLowerCase() as `0x${string}`)))
    tokens.forEach((token, i) => {
      const raw = goodsClaimableResults?.[i]?.result
      m.set(token, raw !== undefined ? BigInt(raw) : 0n)
    })
    return m
  }, [goodsClaimableResults])

  const usdcClaimable = useMemo(() => {
    const raw = claimableResults?.[0]?.result
    return raw !== undefined ? BigInt(raw) : 0n
  }, [claimableResults])

  // Expose refetch so callers can trigger it (unused here but available if needed)
  void refetchClaimable
  void refetchGoodsClaimable

  const deals: DealSummary[] = useMemo(() => {
    if (!dealResults) return []
    return dealResults.map((r, i) => {
      if (r.status !== 'success' || !r.result) return null
      const d = r.result
      const tiers = d.tiers.map(t => ({
        minUnits: Number(t.minUnits),
        pricePerUnit: BigInt(t.pricePerUnit),
      }))
      const totalUnitsRaw = unitResults?.[i]?.result
      const totalUnits    = totalUnitsRaw !== undefined ? Number(totalUnitsRaw) : 0
      const clearingPrice = computePriceAt(tiers, totalUnits)
      return {
        dealId:        BigInt(i + 1),
        title:         d.title,
        goodsToken:    d.goodsToken,
        tokensPerUnit: BigInt(d.tokensPerUnit),
        tiers,
        minUnits:      Number(d.minUnits),
        maxUnits:      Number(d.maxUnits),
        deadline:      BigInt(d.deadline),
        state:         Number(d.state),
        totalUnits,
        clearingPrice,
        supplier:      d.supplier,
      }
    }).filter((d): d is DealSummary => d !== null)
  }, [dealResults, unitResults])

  // Split active vs ended
  const active = useMemo(() => deals
    .filter(d => d.state === 0 && (nowSec === 0 || Number(d.deadline) > nowSec))
    .sort((a, b) => Number(a.deadline) - Number(b.deadline)),
    [deals, nowSec]
  )
  const ended = useMemo(() => deals
    .filter(d => d.state !== 0 || (nowSec > 0 && Number(d.deadline) <= nowSec))
    .sort((a, b) => Number(b.deadline) - Number(a.deadline)),
    [deals, nowSec]
  )

  // "Your deals" — supplier OR buyer, newest first
  const yours = useMemo(() => {
    if (!walletAddr) return []
    const walletLower = walletAddr.toLowerCase()
    return deals
      .filter((d, i) => {
        const isSupplier = d.supplier.toLowerCase() === walletLower
        const myUnitsRaw = myUnitsResults?.[i]?.result
        const myUnits    = myUnitsRaw !== undefined ? Number(myUnitsRaw) : 0
        return isSupplier || myUnits > 0
      })
      .sort((a, b) => Number(b.dealId) - Number(a.dealId))
  }, [deals, walletAddr, myUnitsResults])

  /**
   * Whether the wallet has something claimable on this deal.
   * - settled buyer:   goodsClaimable[token] > 0 or usdcClaimable > 0
   * - refunded buyer:  usdcClaimable > 0
   * - settled seller:  usdcClaimable > 0 or goodsClaimable[token] > 0 (unsold stock)
   * - refunded seller: goodsClaimable[token] > 0
   * We use wallet-level totals (not per-deal), which is correct because `claimable`
   * and `goodsClaimable` accumulate across deals and drain to 0 after `claim()`.
   */
  const hasClaimable = useCallback((deal: DealSummary, i: number): boolean => {
    if (!walletAddr) return false
    const walletLower   = walletAddr.toLowerCase()
    const isSupplier    = deal.supplier.toLowerCase() === walletLower
    const myUnitsRaw    = myUnitsResults?.[i]?.result
    const myUnits       = myUnitsRaw !== undefined ? Number(myUnitsRaw) : 0
    const isBuyer       = myUnits > 0
    const tokenLower    = deal.goodsToken.toLowerCase()
    const goodsAmt      = goodsClaimableMap.get(tokenLower) ?? 0n

    if (deal.state === 1) { // settled
      if (isSupplier) return usdcClaimable > 0n || goodsAmt > 0n
      if (isBuyer)    return goodsAmt > 0n || usdcClaimable > 0n
    }
    if (deal.state === 2) { // refunded
      if (isSupplier) return goodsAmt > 0n
      if (isBuyer)    return usdcClaimable > 0n
    }
    return false
  }, [walletAddr, myUnitsResults, usdcClaimable, goodsClaimableMap])

  const allShown = activeTab === 'active' ? active : activeTab === 'ended' ? ended : yours
  const shown = activeTab === 'yours' || tokenFilter === 'all'
    ? allShown
    : allShown.filter(d => d.goodsToken.toLowerCase() === tokenFilter.toLowerCase())

  if (dealCount === 0 && dealResults === undefined) {
    return (
      <div className="px-4 pt-8 flex flex-col items-center gap-3">
        <div className="size-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} />
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading deals…</p>
      </div>
    )
  }

  return (
    <div className="px-4 pt-5 pb-10 space-y-4">

      {/* Controls row: tabs + Post button */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--surface-muted)' }}>
          {(['active', 'ended', ...(walletAddr ? ['yours'] : [])] as DealListTab[]).map(t => (
            <button key={t}
              onClick={() => onTabChange(t)}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
              style={{
                background: activeTab === t ? 'var(--surface)' : 'transparent',
                color: activeTab === t ? 'var(--ink)' : 'var(--muted)',
                boxShadow: activeTab === t ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
              }}>
              {t === 'yours' ? 'Your deals' : t.charAt(0).toUpperCase() + t.slice(1)}
              {t === 'active' && active.length > 0 && (
                <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full font-semibold"
                  style={{ background: 'var(--accent)', color: '#fff' }}>
                  {active.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        <button onClick={onPost}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:scale-[1.01]"
          style={{ background: 'var(--accent)', color: '#fff' }}>
          <PlusCircle className="size-4" /> Post a deal
        </button>
      </div>

      {/* Token filter pills */}
      {GOODS_TOKENS.length > 1 && (
        <div className="flex gap-1.5 flex-wrap">
          {['all', ...GOODS_TOKENS.map(t => t.address)].map((addr) => {
            const tok = GOODS_TOKENS.find(t => t.address === addr)
            const label = tok ? tok.symbol : 'All'
            const isActive = tokenFilter === addr
            return (
              <button key={addr}
                onClick={() => setTokenFilter(addr)}
                className="px-3 py-1 rounded-full text-xs font-medium transition-all"
                style={{
                  background: isActive ? 'var(--accent)' : 'var(--surface-muted)',
                  color: isActive ? '#fff' : 'var(--muted)',
                  border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                }}>
                {label}
              </button>
            )
          })}
        </div>
      )}

      {/* Empty state */}
      {shown.length === 0 && (
        <motion.div
          className="rounded-2xl p-10 text-center"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        >
          {activeTab === 'yours' ? (
            <>
              <Package className="size-8 mx-auto mb-3" style={{ color: 'var(--muted)' }} />
              <p className="font-semibold" style={{ color: 'var(--ink)' }}>No deals yet</p>
              <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
                Deals you post or join show up here.
              </p>
            </>
          ) : activeTab === 'active' ? (
            <>
              <p className="font-semibold" style={{ color: 'var(--ink)' }}>No active deals</p>
              <p className="text-sm mt-1 mb-5" style={{ color: 'var(--muted)' }}>
                Post the first deal and watch the price fall as buyers join.
              </p>
              <button onClick={onPost}
                className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:scale-[1.02]"
                style={{ background: 'var(--accent)', color: '#fff' }}>
                <span className="flex items-center gap-1.5">
                  <PlusCircle className="size-4" /> Post a deal
                </span>
              </button>
            </>
          ) : (
            <>
              <Package className="size-8 mx-auto mb-3" style={{ color: 'var(--muted)' }} />
              <p className="font-semibold" style={{ color: 'var(--ink)' }}>No ended deals yet</p>
            </>
          )}
        </motion.div>
      )}

      {/* Deal cards — responsive grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((deal, idx) => {
          const origIdx = deals.indexOf(deal)
          let roleLabel: string | undefined
          let highlight = false
          if (activeTab === 'yours' && walletAddr) {
            const walletLower = walletAddr.toLowerCase()
            const isSupplier  = deal.supplier.toLowerCase() === walletLower
            const myUnitsRaw  = origIdx >= 0 ? myUnitsResults?.[origIdx]?.result : undefined
            const myUnits     = myUnitsRaw !== undefined ? Number(myUnitsRaw) : 0
            roleLabel = isSupplier ? 'Selling' : myUnits > 0 ? `Joined · ${myUnits} unit${myUnits !== 1 ? 's' : ''}` : undefined
            highlight = origIdx >= 0 ? hasClaimable(deal, origIdx) : false
          }
          return (
            <DealCard
              key={deal.dealId.toString()}
              deal={deal}
              nowSec={nowSec}
              onSelect={onSelectDeal}
              delay={idx * 0.03}
              marketRates={marketRates}
              roleLabel={roleLabel}
              highlight={highlight}
            />
          )
        })}
      </div>
    </div>
  )
}

// ── Deal card ─────────────────────────────────────────────────────────────────

interface DealCardProps {
  deal:        DealSummary
  nowSec:      number
  onSelect:    (id: bigint) => void
  delay:       number
  marketRates?: Map<string, number>
  roleLabel?:  string
  highlight?:  boolean
}

function DealCard({ deal, nowSec, onSelect, delay, marketRates, roleLabel, highlight }: DealCardProps) {
  const secondsLeft  = nowSec > 0 ? Math.max(0, Number(deal.deadline) - nowSec) : undefined
  const isEnded      = deal.state !== 0 || (nowSec > 0 && secondsLeft === 0)
  const fillPct      = deal.maxUnits > 0 ? Math.min(1, deal.totalUnits / deal.maxUnits) : 0
  const tokenConfig  = GOODS_TOKENS.find(t => t.address.toLowerCase() === deal.goodsToken.toLowerCase())
  // Fall back to on-chain reads for tokens not in GOODS_TOKENS
  const onChainMeta  = useGoodsTokenMeta(tokenConfig ? undefined : deal.goodsToken)
  const tokenSymbol  = tokenConfig?.symbol ?? onChainMeta?.symbol ?? '?'
  const tokenDecimals = tokenConfig?.decimals ?? onChainMeta?.decimals
  const marketRate   = tokenConfig?.marketSymbol ? marketRates?.get(tokenConfig.marketSymbol) : undefined
  const urgent       = secondsLeft !== undefined && secondsLeft < 3600 && !isEnded

  // Next tier hint
  let nextHint: string | null = null
  for (let i = 0; i < deal.tiers.length; i++) {
    if (deal.totalUnits < deal.tiers[i].minUnits && deal.tiers[i].pricePerUnit < deal.clearingPrice) {
      const needed = deal.tiers[i].minUnits - deal.totalUnits
      nextHint = `${needed} more unit${needed !== 1 ? 's' : ''} → ${formatUsdcPrice(deal.tiers[i].pricePerUnit)}/unit`
      break
    }
  }

  return (
    <motion.button
      className="w-full rounded-2xl p-4 text-left transition-all hover:scale-[1.01] active:scale-[0.99]"
      style={{
        background: 'var(--surface)',
        border: `1px solid ${highlight ? 'var(--success)' : 'var(--border)'}`,
      }}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay }}
      onClick={() => onSelect(deal.dealId)}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {/* Title + state badge + role badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm leading-tight" style={{ color: 'var(--ink)' }}>
              {deal.title}
            </span>
            {isEnded && (
              <span className="text-xs px-1.5 py-0.5 rounded-md"
                style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
                {deal.state === 1 ? 'Settled' : deal.state === 2 ? 'Refunded' : 'Ended'}
              </span>
            )}
            {roleLabel && (
              <span className="text-xs px-1.5 py-0.5 rounded-md font-medium"
                style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)' }}>
                {roleLabel}
              </span>
            )}
            {highlight && (
              <span className="text-xs px-1.5 py-0.5 rounded-md font-medium"
                style={{ background: 'rgba(26,128,71,0.1)', color: 'var(--success)' }}>
                Ready to collect
              </span>
            )}
          </div>

          {/* Price + units */}
          <div className="flex items-baseline gap-3 mt-1 flex-wrap">
            <span className="text-base font-bold tabular-nums" style={{ color: 'var(--accent)' }}>
              {formatUsdcPrice(deal.clearingPrice)}/unit
            </span>
            <PricePerToken
              pricePerUnit={deal.clearingPrice} tokensPerUnit={deal.tokensPerUnit}
              tokenDecimals={tokenDecimals} tokenSymbol={tokenSymbol}
              marketRate={marketRate}
              className="text-xs"
            />
            <span className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
              {deal.totalUnits}/{deal.maxUnits} units
            </span>
          </div>

          {/* Fill bar */}
          <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
            <div className="h-full rounded-full transition-all"
              style={{ width: `${fillPct * 100}%`, background: 'var(--accent)' }} />
          </div>

          {/* Time left + next tier hint */}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {!isEnded && secondsLeft !== undefined && (
              <span className="flex items-center gap-1 text-xs"
                style={{ color: urgent ? 'var(--danger)' : 'var(--subtle)' }}>
                <Clock className="size-3" />
                {formatCountdown(secondsLeft)}
              </span>
            )}
            {nextHint && !isEnded && (
              <span className="text-xs" style={{ color: 'var(--accent)' }}>
                {nextHint}
              </span>
            )}
          </div>
        </div>

        <ChevronRight className="size-4 shrink-0 mt-1" style={{ color: 'var(--subtle)' }} />
      </div>
    </motion.button>
  )
}
