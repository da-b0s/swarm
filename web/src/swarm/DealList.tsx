/**
 * DealList — browse all deals, grouped into Active / Ended tabs.
 *
 * Reads dealCount then batches getDeal calls for all deal IDs.
 * Active deals are sorted by time left (soonest deadline first).
 * Clicking a card calls onSelectDeal(dealId).
 * With no active deals, shows an empty state with a Post button.
 * Logged-out users see the list but not the order actions.
 */

import { useMemo } from 'react'
import { useReadContracts } from 'wagmi'
import { motion } from 'framer-motion'
import { Clock, Layers, ChevronRight, PlusCircle, Package } from 'lucide-react'
import { CONTRACTS_ACTIVE, ARC_NETWORK } from './config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI } from './abis'
import { useDealCount, useChainNow } from './hooks'
import { POLL_DEAL_ROOM, POLL_LIST } from './config'
import { formatUsdcPrice, formatCountdown, computePriceAt } from './utils'

const CHAIN_ID = ARC_NETWORK.chainId

interface Props {
  activeTab:      'active' | 'ended'
  onTabChange:    (t: 'active' | 'ended') => void
  onSelectDeal:   (id: bigint) => void
  onPost:         () => void
}

interface DealSummary {
  dealId:       bigint
  title:        string
  goodsToken:   `0x${string}`
  tiers:        { minUnits: number; pricePerUnit: bigint }[]
  minUnits:     number
  maxUnits:     number
  deadline:     bigint
  state:        number
  totalUnits:   number
  clearingPrice:bigint
}

export function DealList({ activeTab, onTabChange, onSelectDeal, onPost }: Props) {
  const { data: dealCountRaw } = useDealCount()
  const dealCount = dealCountRaw !== undefined ? Number(dealCountRaw) : 0
  const nowSec    = useChainNow()

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

  const { data: dealResults } = useReadContracts({
    contracts: dealCalls,
    query: { enabled: dealCount > 0, refetchInterval: POLL_LIST, refetchIntervalInBackground: false },
  })

  const { data: unitResults } = useReadContracts({
    contracts: totalUnitsCalls,
    query: { enabled: dealCount > 0, refetchInterval: POLL_DEAL_ROOM, refetchIntervalInBackground: false },
  })

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
        dealId:       BigInt(i + 1),
        title:        d.title,
        goodsToken:   d.goodsToken,
        tiers,
        minUnits:     Number(d.minUnits),
        maxUnits:     Number(d.maxUnits),
        deadline:     BigInt(d.deadline),
        state:        Number(d.state),
        totalUnits,
        clearingPrice,
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

  const shown = activeTab === 'active' ? active : ended

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
    <div className="px-4 pt-4 pb-8 space-y-4">
      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--surface-muted)' }}>
        {(['active', 'ended'] as const).map(t => (
          <button key={t}
            onClick={() => onTabChange(t)}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-all"
            style={{
              background: activeTab === t ? 'var(--surface)' : 'transparent',
              color: activeTab === t ? 'var(--ink)' : 'var(--muted)',
              boxShadow: activeTab === t ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === 'active' && active.length > 0 && (
              <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full font-semibold"
                style={{ background: 'var(--accent)', color: '#fff' }}>
                {active.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {shown.length === 0 && (
        <motion.div
          className="rounded-2xl p-8 text-center"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        >
          {activeTab === 'active' ? (
            <>
              <Layers className="size-8 mx-auto mb-3" style={{ color: 'var(--muted)' }} />
              <p className="font-semibold" style={{ color: 'var(--ink)' }}>No active deals</p>
              <p className="text-sm mt-1 mb-4" style={{ color: 'var(--muted)' }}>
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

      {/* Deal cards */}
      <div className="space-y-2">
        {shown.map((deal, idx) => (
          <DealCard
            key={deal.dealId.toString()}
            deal={deal}
            nowSec={nowSec}
            onSelect={onSelectDeal}
            delay={idx * 0.04}
          />
        ))}
      </div>
    </div>
  )
}

// ── Deal card ─────────────────────────────────────────────────────────────────

interface DealCardProps {
  deal:     DealSummary
  nowSec:   number
  onSelect: (id: bigint) => void
  delay:    number
}

function DealCard({ deal, nowSec, onSelect, delay }: DealCardProps) {
  const secondsLeft  = nowSec > 0 ? Math.max(0, Number(deal.deadline) - nowSec) : undefined
  const isEnded      = deal.state !== 0 || (nowSec > 0 && secondsLeft === 0)
  const fillPct      = deal.maxUnits > 0 ? Math.min(1, deal.totalUnits / deal.maxUnits) : 0
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
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay }}
      onClick={() => onSelect(deal.dealId)}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {/* Title + state badge */}
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
          </div>

          {/* Price + units */}
          <div className="flex items-baseline gap-3 mt-1 flex-wrap">
            <span className="text-base font-bold tabular-nums" style={{ color: 'var(--accent)' }}>
              {formatUsdcPrice(deal.clearingPrice)}/unit
            </span>
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
