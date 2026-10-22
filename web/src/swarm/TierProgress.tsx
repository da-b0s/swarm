import { motion } from 'framer-motion'
import { formatUsdcPrice } from './utils'
import type { DealTier } from './hooks'

interface Props {
  buyerCount: number
  tiers: DealTier[]
  minBuyers: number
  progress: number          // 0..1 progress to next tier
  nextTier: { tier: DealTier; buyersNeeded: number } | undefined
}

export function TierProgress({ buyerCount, tiers, minBuyers, progress, nextTier }: Props) {
  if (tiers.length === 0) return null

  const atBestTier = !nextTier
  const metMinimum = buyerCount >= minBuyers

  return (
    <div className="space-y-3">
      {/* Next tier call to action */}
      <div
        className="rounded-2xl px-4 py-3"
        style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
      >
        {atBestTier ? (
          <p className="text-sm font-semibold" style={{ color: 'var(--success)' }}>
            Best price unlocked
          </p>
        ) : (
          <p className="text-sm font-medium" style={{ color: 'var(--ink-2)' }}>
            <span className="font-bold" style={{ color: 'var(--ink)' }}>
              {nextTier.buyersNeeded} more {nextTier.buyersNeeded === 1 ? 'buyer' : 'buyers'}
            </span>{' '}
            and everyone pays{' '}
            <span className="font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
              {formatUsdcPrice(nextTier.tier.pricePerUnit)}
            </span>
          </p>
        )}

        {!atBestTier && (
          <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
            <motion.div
              className="h-full rounded-full"
              style={{ background: 'var(--accent)', transformOrigin: 'left' }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: progress }}
              transition={{ type: 'spring', stiffness: 200, damping: 28 }}
            />
          </div>
        )}
      </div>

      {/* Tier curve mini-legend */}
      <div className="flex gap-2 flex-wrap">
        {tiers.map((t, i) => {
          const unlocked = buyerCount >= t.minBuyers
          const active = buyerCount >= t.minBuyers && (i === tiers.length - 1 || buyerCount < tiers[i + 1].minBuyers)
          return (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium"
              style={{
                background: active ? 'var(--accent)' : unlocked ? 'rgba(26,128,71,0.10)' : 'var(--surface-muted)',
                color: active ? '#fff' : unlocked ? 'var(--success)' : 'var(--muted)',
                border: `1px solid ${active ? 'transparent' : unlocked ? 'rgba(26,128,71,0.2)' : 'var(--border)'}`,
              }}
            >
              <span className="tabular-nums font-bold">{formatUsdcPrice(t.pricePerUnit)}</span>
              <span>@ {t.minBuyers}+</span>
            </div>
          )
        })}
      </div>

      {/* Minimum threshold status */}
      {!metMinimum && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {minBuyers - buyerCount} more needed to meet the deal minimum of {minBuyers}
        </p>
      )}
    </div>
  )
}
