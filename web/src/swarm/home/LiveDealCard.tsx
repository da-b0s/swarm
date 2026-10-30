/**
 * LiveDealCard — hero section right column.
 *
 * Shows the most-recent active deal with title, token, current price, tier
 * ladder, units progress and time left.  Falls back to the most-recently
 * settled deal when nothing is open.  Falls back to null (renders nothing)
 * when no deals exist yet.
 */

import { useMemo } from 'react'
import { useReadContracts } from 'wagmi'
import { ArrowRight } from 'lucide-react'
import {
  CONTRACTS_ACTIVE, ARC_NETWORK, POLL_LIST, GOODS_TOKENS,
} from '../config'
import { DEAL_FACTORY_ABI, DEMAND_POOL_ABI } from '../abis'
import { useDealCount, useGoodsTokenMeta, useChainNow, type DealData, type DealTier } from '../hooks'
import { computePriceAt, formatUsdcPrice, pricePerToken } from '../utils'

interface Props {
  onJoin: (id: bigint) => void
  onPost: () => void
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtTimeLeft(secsLeft: number): string {
  if (secsLeft <= 0) return 'Closed'
  if (secsLeft < 60) return `${secsLeft}s`
  if (secsLeft < 3600) return `${Math.floor(secsLeft / 60)}m`
  const h = Math.floor(secsLeft / 3600)
  const m = Math.floor((secsLeft % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

// ── sub-components ────────────────────────────────────────────────────────────

function TierLadder({
  tiers, totalUnits, finalPrice,
}: {
  tiers: DealTier[]
  totalUnits: number
  finalPrice?: bigint
}) {
  if (tiers.length === 0) return null
  const activeIdx = tiers.reduce((best, t, i) =>
    totalUnits >= t.minUnits ? i : best, 0
  )
  return (
    <div className="flex flex-col gap-1">
      {tiers.map((t, i) => {
        const isActive = i === activeIdx && !finalPrice
        const isFinal  = finalPrice !== undefined && t.pricePerUnit === finalPrice
        return (
          <div key={i} className="flex items-center justify-between gap-2 text-xs"
            style={{ opacity: i < activeIdx && !finalPrice ? 0.45 : 1 }}>
            <span style={{ color: 'var(--muted)' }}>
              {i === 0 ? 'Any' : `${t.minUnits}+`} units
            </span>
            <span className="font-semibold tabular-nums"
              style={{
                color: isActive || isFinal ? 'var(--accent)' : 'var(--ink-2)',
                fontWeight: isActive || isFinal ? 700 : 500,
              }}>
              {formatUsdcPrice(t.pricePerUnit)}
              {(isActive || isFinal) && (
                <span className="ml-1 text-[10px] font-normal px-1 rounded"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)', opacity: 0.9 }}>
                  {isFinal ? 'final' : 'now'}
                </span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function LiveDealCard({ onJoin, onPost }: Props) {
  const { data: countRaw, isLoading: countLoading } = useDealCount()
  const count = countRaw !== undefined ? Number(countRaw) : 0
  const chainId = ARC_NETWORK.chainId
  const q = { enabled: count > 0, refetchInterval: POLL_LIST, refetchIntervalInBackground: false }

  const ids = useMemo(() =>
    Array.from({ length: count }, (_, i) => BigInt(i + 1)),
    [count]
  )

  const { data: dealsRaw } = useReadContracts({ query: q, contracts: ids.map(id => ({
    address: CONTRACTS_ACTIVE.DealFactory, abi: DEAL_FACTORY_ABI,
    functionName: 'getDeal' as const, args: [id] as const, chainId,
  })) })

  const { data: unitsRaw } = useReadContracts({ query: q, contracts: ids.map(id => ({
    address: CONTRACTS_ACTIVE.DemandPool, abi: DEMAND_POOL_ABI,
    functionName: 'totalUnits' as const, args: [id] as const, chainId,
  })) })

  const now = useChainNow()

  // Pick the most recent active deal; fall back to most recent settled.
  const picked = useMemo<{
    id: bigint; deal: DealData; totalUnits: number; isSettled: boolean
  } | null>(() => {
    if (!dealsRaw) return null
    let activeBest: { id: bigint; deal: DealData; totalUnits: number } | null = null
    let settledBest: { id: bigint; deal: DealData; totalUnits: number } | null = null

    for (let i = 0; i < ids.length; i++) {
      const raw = dealsRaw[i]?.result
      if (!raw) continue
      const deal: DealData = {
        supplier: raw.supplier,
        goodsToken: raw.goodsToken,
        tokensPerUnit: BigInt(raw.tokensPerUnit),
        tiers: raw.tiers.map(t => ({ minUnits: Number(t.minUnits), pricePerUnit: BigInt(t.pricePerUnit) })),
        minUnits: Number(raw.minUnits),
        maxUnits: Number(raw.maxUnits),
        maxUnitsPerBuyer: Number(raw.maxUnitsPerBuyer),
        maxBuyers: Number(raw.maxBuyers),
        deadline: BigInt(raw.deadline),
        state: Number(raw.state),
        title: raw.title,
        description: raw.description,
      }
      const totalUnits = Number(unitsRaw?.[i]?.result ?? 0)
      // Active = Open AND deadline still in the future (past-deadline open deals
      // are waiting for the keeper, not joinable).
      const deadlinePassed = now !== null && now !== undefined && Number(deal.deadline) <= now
      if (deal.state === 0 && !deadlinePassed) activeBest = { id: ids[i], deal, totalUnits }
      // Always overwrite settled so we end up with the highest-id settled deal.
      else if (deal.state === 1) settledBest = { id: ids[i], deal, totalUnits }
    }

    if (activeBest) return { ...activeBest, isSettled: false }
    if (settledBest) return { ...settledBest, isSettled: true }
    return null
  }, [ids, dealsRaw, unitsRaw, now])

  const tokenMeta = useGoodsTokenMeta(picked?.deal.goodsToken)
  const knownToken = picked
    ? GOODS_TOKENS.find(t => t.address.toLowerCase() === picked.deal.goodsToken.toLowerCase())
    : undefined
  const symbol   = knownToken?.symbol ?? tokenMeta?.symbol ?? '…'
  const decimals = knownToken?.decimals ?? tokenMeta?.decimals ?? 6

  // Still loading: show a skeleton that holds the same size as the card.
  const isLoading = countLoading || (count > 0 && !dealsRaw)
  if (isLoading) {
    return (
      <div className="rounded-2xl p-5 min-h-[280px] flex flex-col gap-3 animate-pulse"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="h-4 w-16 rounded-lg" style={{ background: 'var(--surface-muted)' }} />
        <div className="h-6 w-40 rounded-lg" style={{ background: 'var(--surface-muted)' }} />
        <div className="h-8 w-24 rounded-lg mt-1" style={{ background: 'var(--surface-muted)' }} />
        <div className="flex flex-col gap-2 mt-2">
          {[0, 1, 2].map(i => (
            <div key={i} className="flex justify-between">
              <div className="h-3 w-16 rounded" style={{ background: 'var(--surface-muted)' }} />
              <div className="h-3 w-12 rounded" style={{ background: 'var(--surface-muted)' }} />
            </div>
          ))}
        </div>
        <div className="h-9 w-full rounded-xl mt-auto" style={{ background: 'var(--surface-muted)' }} />
      </div>
    )
  }

  if (!picked) {
    // No deals yet — show a prompt to post one.
    return (
      <div className="rounded-2xl p-6 flex flex-col gap-4 items-start justify-center min-h-[280px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>No live deals yet.</p>
        <button onClick={onPost}
          className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all hover:opacity-90"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          Post the first deal <ArrowRight className="size-4" />
        </button>
      </div>
    )
  }

  const { id, deal, totalUnits, isSettled } = picked
  const secsLeft = now ? Math.max(0, Number(deal.deadline) - now) : null
  const currentPrice = computePriceAt(deal.tiers, totalUnits)
  const ppt = deal.tokensPerUnit > 0n
    ? pricePerToken(currentPrice, deal.tokensPerUnit, decimals)
    : null
  const nextTier = deal.tiers.find(t => t.minUnits > totalUnits)
  const toNext = nextTier ? nextTier.minUnits - totalUnits : 0

  // Determine whether this is a 1:1 (one full token per unit) deal.
  // If tokensPerUnit == 10^decimals the price-per-token equals the price-per-unit,
  // so we skip the redundant "per unit" part.
  const oneTokenPerUnit = deal.tokensPerUnit === BigInt(10 ** decimals)

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>

      {/* Header */}
      <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-xs font-medium px-2 py-0.5 rounded-lg mb-1.5 inline-block"
            style={{ background: isSettled ? 'var(--surface-muted)' : 'rgba(26,128,71,0.1)', color: isSettled ? 'var(--muted)' : 'var(--success)' }}>
            {isSettled ? 'Last deal' : 'Live'}
          </span>
          <p className="font-bold text-base leading-snug truncate" style={{ color: 'var(--ink)' }}>
            {deal.title || `Deal #${id}`}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{symbol}</p>
        </div>
        {secsLeft !== null && !isSettled && (
          <span className="shrink-0 text-xs font-semibold tabular-nums px-2 py-1 rounded-lg"
            style={{ background: 'var(--surface-muted)', color: secsLeft < 600 ? 'var(--danger)' : 'var(--muted)' }}>
            {fmtTimeLeft(secsLeft)}
          </span>
        )}
      </div>

      {/* Price hero */}
      <div className="px-5 pb-3">
        {isSettled ? (
          // Settled: "Closed at $1.11 per EURC · 60 units"
          <p className="text-sm tabular-nums" style={{ color: 'var(--muted)' }}>
            Closed at{' '}
            <span className="font-semibold" style={{ color: 'var(--ink)' }}>
              {formatUsdcPrice(currentPrice)}
            </span>
            {ppt && !oneTokenPerUnit && (
              <> per unit, {ppt} per {symbol}</>
            )}
            {ppt && oneTokenPerUnit && (
              <> per {symbol}</>
            )}
            {' '}&middot; {totalUnits} unit{totalUnits !== 1 ? 's' : ''}
          </p>
        ) : (
          <>
            <span className="display text-3xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
              {formatUsdcPrice(currentPrice)}
            </span>
            {ppt && (
              <span className="ml-2 text-sm" style={{ color: 'var(--muted)' }}>
                {oneTokenPerUnit
                  ? `per ${symbol}`
                  : `per unit · ${ppt} per ${symbol}`}
              </span>
            )}
          </>
        )}
      </div>

      {/* Tier ladder */}
      <div className="px-5 pb-3">
        <TierLadder
          tiers={deal.tiers}
          totalUnits={totalUnits}
          finalPrice={isSettled ? currentPrice : undefined}
        />
      </div>

      {/* Units progress */}
      {!isSettled && (
        <div className="px-5 pb-4">
          <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
            <span>{totalUnits.toLocaleString('en-US')} sold</span>
            {nextTier
              ? <span>{toNext} more to {formatUsdcPrice(nextTier.pricePerUnit)}</span>
              : <span>max reached</span>}
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-muted)' }}>
            <div className="h-full rounded-full transition-all"
              style={{
                background: 'var(--accent)',
                width: `${Math.min(100, (totalUnits / deal.maxUnits) * 100)}%`,
              }} />
          </div>
        </div>
      )}

      {/* CTA */}
      <div className="px-5 pb-5">
        <button
          onClick={() => (isSettled ? onPost() : onJoin(id))}
          className="w-full rounded-xl py-2.5 text-sm font-semibold transition-all hover:opacity-90 flex items-center justify-center gap-2"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          {isSettled ? 'Post a deal' : 'Join this deal'}
          <ArrowRight className="size-4" />
        </button>
      </div>
    </div>
  )
}
