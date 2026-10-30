/**
 * PriceFallAnimation — self-contained SVG/CSS animation showing one deal fill.
 *
 * Buyers join one by one; the units counter rises; price steps down at each
 * tier threshold.  At the end, every buyer dot gets the same final price and
 * early joiners see a small "refund" tick.  Respects prefers-reduced-motion:
 * skips straight to the finished state.
 *
 * No external data — pure illustration.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

// ── Constants ─────────────────────────────────────────────────────────────────

const TIERS = [
  { minUnits: 1,  price: '$1.20' },
  { minUnits: 25, price: '$1.17' },
  { minUnits: 50, price: '$1.15' },
] as const

const TOTAL_BUYERS = 8   // dot count in the animation
// Buyer join events: units, paidAtJoin (the price the buyer saw when joining)
type TierPrice = '$1.20' | '$1.17' | '$1.15'
const JOIN_SEQUENCE: { units: number; paidAt: TierPrice }[] = [
  { units: 5,  paidAt: '$1.20' },
  { units: 11, paidAt: '$1.20' },
  { units: 18, paidAt: '$1.20' },
  { units: 25, paidAt: '$1.20' }, // hits tier 2 boundary
  { units: 32, paidAt: '$1.17' },
  { units: 40, paidAt: '$1.17' },
  { units: 50, paidAt: '$1.17' }, // hits tier 3 boundary
  { units: 57, paidAt: '$1.15' },
]
const STEP_MS = 550   // ms between buyer joins during animation
const SETTLE_DELAY = 900  // ms pause before showing settlement

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnimState {
  step: number          // 0 = start, 1..N = N buyers joined, N+1 = settled
  settled: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const mq = typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
  const [reduced, setReduced] = useState(mq?.matches ?? false)
  useEffect(() => {
    if (!mq) return
    const handler = () => setReduced(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [mq])
  return reduced
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PriceFallAnimation() {
  const reduced = usePrefersReducedMotion()
  const [anim, setAnim] = useState<AnimState>({ step: 0, settled: false })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const totalSteps = JOIN_SEQUENCE.length  // one step per buyer

  const endState: AnimState = { step: totalSteps, settled: true }

  const runAnimation = useCallback(() => {
    setAnim({ step: 0, settled: false })
    let s = 0
    const tick = () => {
      s++
      if (s <= totalSteps) {
        setAnim({ step: s, settled: false })
        timerRef.current = setTimeout(tick, STEP_MS)
      } else {
        timerRef.current = setTimeout(() => {
          setAnim({ step: totalSteps, settled: true })
        }, SETTLE_DELAY)
      }
    }
    timerRef.current = setTimeout(tick, STEP_MS)
  }, [totalSteps])

  // Auto-play on mount; skip to end if reduced motion.
  useEffect(() => {
    if (reduced) {
      setAnim(endState)
      return
    }
    runAnimation()
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced])

  const replay = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (reduced) { setAnim(endState); return }
    runAnimation()
  }

  const { step, settled } = anim
  const visibleBuyers = Math.min(step, TOTAL_BUYERS)
  const totalUnits = step > 0 ? JOIN_SEQUENCE[Math.min(step, totalSteps) - 1].units : 0
  const livePrice  = step > 0 ? JOIN_SEQUENCE[Math.min(step, totalSteps) - 1].paidAt : TIERS[0].price
  const finalPrice = '$1.15'

  // ── Layout params ──────────────────────────────────────────────────────────
  const W = 320
  const H = 200
  const DOT_R = 8
  const COLS  = 8
  const DOT_SPACING_X = 28
  const DOT_SPACING_Y = 26
  const GRID_X0 = 20
  const GRID_Y0 = 42

  // ── SVG rendering ──────────────────────────────────────────────────────────
  return (
    <div>
      <div className="rounded-2xl overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>

        {/* Price + units display above the chart */}
        <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>Current price</p>
            <p className="display text-2xl font-bold tabular-nums" style={{ color: 'var(--accent)' }}>
              {settled ? finalPrice : livePrice}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>Units ordered</p>
            <p className="display text-2xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
              {totalUnits}
            </p>
          </div>
        </div>

        {/* SVG */}
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }} aria-hidden>

          {/* Tier threshold lines */}
          {TIERS.slice(1).map((t, i) => {
            const pct = t.minUnits / JOIN_SEQUENCE[totalSteps - 1].units
            const x = GRID_X0 + pct * (W - GRID_X0 - 20)
            return (
              <g key={i}>
                <line x1={x} x2={x} y1={4} y2={H - 30}
                  stroke="var(--border)" strokeWidth={1} strokeDasharray="3 3" />
                <text x={x + 3} y={12} fontSize={8} fill="var(--muted)" fontFamily="monospace">
                  {t.minUnits} units: {t.price}
                </text>
              </g>
            )
          })}

          {/* Price step line */}
          {(() => {
            const pts: string[] = []
            let prevY = H - 30
            for (const t of TIERS) {
              const xPct = t.minUnits / JOIN_SEQUENCE[totalSteps - 1].units
              const x = GRID_X0 + xPct * (W - GRID_X0 - 20)
              // y maps $1.15–$1.20 to chart height
              const priceNum = parseFloat(t.price.replace('$', ''))
              const y = H - 30 - ((priceNum - 1.14) / 0.07) * (H - 60)
              if (t.minUnits === 1) {
                pts.push(`M ${GRID_X0} ${y}`)
                prevY = y
              } else {
                pts.push(`L ${x} ${prevY} L ${x} ${y}`)
                prevY = y
              }
            }
            pts.push(`L ${W - 20} ${prevY}`)
            return (
              <path d={pts.join(' ')} fill="none"
                stroke="var(--accent)" strokeWidth={2} strokeOpacity={0.4}
                strokeLinecap="round" strokeLinejoin="round" />
            )
          })()}

          {/* Buyer dots */}
          {Array.from({ length: TOTAL_BUYERS }, (_, i) => {
            const col = i % COLS
            const row = Math.floor(i / COLS)
            const cx = GRID_X0 + col * DOT_SPACING_X + 14
            const cy = GRID_Y0 + row * DOT_SPACING_Y + 100
            const joined = i < visibleBuyers
            const joinStep = i  // 0-indexed join step
            const buyerPaid = joinStep < JOIN_SEQUENCE.length ? JOIN_SEQUENCE[joinStep].paidAt : livePrice
            const gotRefund = settled && buyerPaid !== finalPrice

            return (
              <g key={i}
                style={{
                  transition: reduced ? 'none' : 'opacity 0.3s',
                  opacity: joined ? 1 : 0,
                }}>
                {/* Ring for settled state */}
                {settled && (
                  <circle cx={cx} cy={cy} r={DOT_R + 4}
                    fill="none" stroke="var(--accent)" strokeWidth={1} opacity={0.3} />
                )}
                <circle cx={cx} cy={cy} r={DOT_R}
                  fill={joined ? 'var(--accent)' : 'var(--surface-muted)'}
                  style={{ transition: reduced ? 'none' : 'fill 0.3s' }} />
                {/* Refund tick */}
                {gotRefund && (
                  <text x={cx} y={cy - DOT_R - 3} fontSize={8}
                    fill="var(--success)" textAnchor="middle" fontWeight="bold">
                    ↩
                  </text>
                )}
              </g>
            )
          })}

          {/* "Everyone pays final price" banner when settled */}
          {settled && (
            <rect x={0} y={H - 28} width={W} height={24}
              fill="var(--accent)" fillOpacity={0.1} />
          )}
          {settled && (
            <text x={W / 2} y={H - 13} fontSize={9}
              fill="var(--accent)" textAnchor="middle" fontWeight="bold" fontFamily="monospace">
              Everyone pays {finalPrice}. Refunds sent.
            </text>
          )}
        </svg>

        {/* Tier indicator row */}
        <div className="px-5 pb-4 pt-1 flex gap-2">
          {TIERS.map((t, i) => {
            const active = (settled ? finalPrice : livePrice) === t.price
            return (
              <div key={i} className="flex items-center gap-1 text-xs">
                <span className="size-2 rounded-full" style={{
                  background: active ? 'var(--accent)' : 'var(--surface-muted)',
                  transition: 'background 0.3s',
                }} />
                <span style={{ color: active ? 'var(--accent)' : 'var(--muted)', fontWeight: active ? 600 : 400 }}>
                  {t.price}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Caption + Replay */}
      <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--muted)', maxWidth: '42ch' }}>
        Early buyers aren&apos;t punished. When the deal closes, everyone pays the final price and the difference comes back.
      </p>
      <button onClick={replay}
        className="mt-2 text-sm font-medium hover:opacity-70 transition-opacity"
        style={{ color: 'var(--accent)' }}>
        Replay
      </button>
    </div>
  )
}
