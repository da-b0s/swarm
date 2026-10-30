/**
 * TierCurveEditor — interactive SVG price-curve editor.
 *
 * Renders a step chart of the deal's tiers and lets the seller drag each
 * handle to adjust prices (y) and unit thresholds (x).  Typing in the tier
 * inputs updates the chart; dragging the chart updates the inputs.
 *
 * Two correctness invariants:
 *  1. The scale (price domain, unit domain) is FROZEN on pointerdown and
 *     re-derived only after drag ends, so mid-drag tier changes do not feed
 *     back into the coordinate transform and cause the handles to jump or
 *     invert direction.
 *  2. Arrow-key steps equal the snap quantum, so snap never undoes a step.
 */

import { useRef, useEffect, useState } from 'react'
import { formatUsdcPrice, pricePerToken } from './utils'

// ── Public types ──────────────────────────────────────────────────────────────

export interface TierRow {
  minUnits:     string   // '' while the user is typing
  pricePerUnit: string   // '' while the user is typing
}

export interface TierCurveEditorProps {
  tiers:             TierRow[]
  /** Called with a full new tiers array whenever a drag changes a value */
  onChange:          (tiers: TierRow[]) => void
  /** Maximum units (stock) — used as the right edge of the chart */
  maxUnits:          number
  /** Token amount per unit in base units — for the handle tooltip */
  tokensPerUnit:     bigint | null
  /** Decimals of the goods token */
  tokenDecimals:     number
  /** Symbol of the goods token */
  tokenSymbol:       string
  /** Market price per unit as a decimal USDC string — draws a dashed reference line */
  marketPricePerUnit?: string | null
}

// ── Layout constants ──────────────────────────────────────────────────────────

const PAD_L  = 44   // left  (y-axis labels)
const PAD_R  = 14   // right
const PAD_T  = 16   // top
const PAD_B  = 26   // bottom (x-axis labels)
const H_DESK = 220  // SVG height — desktop
const H_MOB  = 180  // SVG height — phones (≤ 480px wide)

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Parse a decimal USDC string to integer micro-USDC (6 dp). */
function parseMicro(s: string): number {
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : 0
}

/**
 * Snap micro-USDC to the display precision:
 *   ≥ $1  → nearest cent   (10_000 micro, 2 dp)
 *   < $1  → nearest 0.0001 (100 micro, 4 dp)
 */
function snapPrice(micro: number): number {
  if (micro <= 0) return 100          // floor at $0.0001
  const quantum = micro / 1_000_000 < 1 ? 100 : 10_000
  return Math.round(micro / quantum) * quantum
}

/**
 * The step used for arrow-key price changes equals the snap quantum so that
 * snap(value ± step) === value ± step (no undo).
 * Shift multiplies by 10.
 */
function priceStep(micro: number, shift: boolean): number {
  const base = micro / 1_000_000 < 1 ? 100 : 10_000   // 1 snap unit
  return shift ? base * 10 : base
}

function microToDisplay(micro: number): string {
  const dollars = micro / 1_000_000
  const dp = dollars < 1 ? 4 : 2
  return dollars.toFixed(dp)
}

// ── Domain helpers ────────────────────────────────────────────────────────────

interface Domain {
  priceMin:    number   // micro-USDC
  priceMax:    number
  unitsMax:    number
}

/** Derive the chart domain from the current tiers with headroom.
 *
 * Headroom is ±25% of the spread (not of the absolute price), so a tight
 * cluster like $1.15–$1.20 uses 37.5% of the chart for the actual data and
 * the rest as breathing room, rather than a vanishingly thin band.
 * When the spread is zero, ±5% of the price is used.
 */
function computeDomain(
  tiers:             TierRow[],
  maxUnits:          number,
  marketPricePerUnit?: string | null,
): Domain {
  const prices: number[] = []
  const units:  number[] = []

  for (const t of tiers) {
    const p = parseMicro(t.pricePerUnit)
    const u = parseInt(t.minUnits) || 0
    if (p > 0) prices.push(p)
    if (u > 0) units.push(u)
  }

  const marketMicro = marketPricePerUnit ? parseMicro(marketPricePerUnit) : 0
  if (marketMicro > 0) prices.push(marketMicro)

  const rawMax  = Math.max(...prices, 1_000)   // at least $0.001
  const rawMin  = prices.length > 0 ? Math.min(...prices) : rawMax
  const spread  = rawMax - rawMin
  // Pad by 25% of the spread, or 5% of the price when spread is zero.
  const pad     = spread > 0 ? spread * 0.25 : rawMax * 0.05

  return {
    priceMax: rawMax + pad,
    priceMin: Math.max(0, rawMin - pad),
    unitsMax: Math.max(...units, maxUnits, 1),
  }
}

// ── Coordinate transforms (from a frozen domain) ──────────────────────────────

function toX(units: number, dom: Domain, w: number): number {
  return PAD_L + (units / dom.unitsMax) * (w - PAD_L - PAD_R)
}

function toY(micro: number, dom: Domain, h: number): number {
  const range = dom.priceMax - dom.priceMin || 1
  return PAD_T + ((dom.priceMax - micro) / range) * (h - PAD_T - PAD_B)
}

/** Price per pixel — positive means up = higher price. */
function microPerPx(dom: Domain, h: number): number {
  const range = dom.priceMax - dom.priceMin || 1
  return range / (h - PAD_T - PAD_B)
}

/** Units per pixel — positive means right = more units. */
function unitsPerPx(dom: Domain, w: number): number {
  return dom.unitsMax / (w - PAD_L - PAD_R)
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TierCurveEditor({
  tiers, onChange, maxUnits, tokensPerUnit, tokenDecimals, tokenSymbol, marketPricePerUnit,
}: TierCurveEditorProps) {
  const svgRef  = useRef<SVGSVGElement>(null)
  const [w, setW] = useState(320)
  const [h, setH] = useState(H_DESK)

  // Observe container width and set responsive height.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const cw = entries[0].contentRect.width
      setW(Math.max(cw, 120))
      setH(cw < 480 ? H_MOB : H_DESK)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Stable (frozen) domain ───────────────────────────────────────────────────
  // Updated at rest; frozen during drag so coordinate transforms never change
  // mid-drag (which would cause jumps and direction inversions).
  const [domain, setDomain] = useState<Domain>(() =>
    computeDomain(tiers, maxUnits, marketPricePerUnit)
  )
  const isDragging = useRef(false)

  // Refit domain whenever tiers/maxUnits change but no drag is in progress.
  // We do it in the render path (not in an effect) to avoid an extra frame.
  if (!isDragging.current) {
    const next = computeDomain(tiers, maxUnits, marketPricePerUnit)
    // Only call setDomain when the values actually differ (avoids infinite loop).
    if (
      next.priceMin !== domain.priceMin ||
      next.priceMax !== domain.priceMax ||
      next.unitsMax !== domain.unitsMax
    ) {
      setDomain(next)
    }
  }

  // ── Drag state ───────────────────────────────────────────────────────────────
  // Frozen at pointerdown; cleared at pointerup.
  const dragRef = useRef<{
    idx:        number
    startX:     number   // pointer px at drag start
    startY:     number
    origMicro:  number   // tier price at drag start (micro-USDC)
    origUnits:  number   // tier minUnits at drag start
    frozenDom:  Domain   // domain snapshot — never changes during this drag
    frozenW:    number   // SVG width snapshot
    frozenH:    number   // SVG height snapshot
  } | null>(null)

  // Active handle for tooltip / keyboard
  const [activeIdx, setActiveIdx] = useState<number | null>(null)

  // ── Tooltip text ─────────────────────────────────────────────────────────────
  const tooltipForIdx = (idx: number): string => {
    const t = tiers[idx]
    const micro = parseMicro(t.pricePerUnit)
    const units = parseInt(t.minUnits) || 0
    const pricePart = formatUsdcPrice(micro)
    let ppt = ''
    if (tokensPerUnit && tokensPerUnit > 0n && micro > 0) {
      const pptStr = pricePerToken(BigInt(micro), tokensPerUnit, tokenDecimals)
      if (pptStr) ppt = ` · ${pptStr} per ${tokenSymbol}`
    }
    return `${units}+ units · ${pricePart}${ppt}`
  }

  // ── Pointer coords in SVG space ───────────────────────────────────────────────
  const svgPoint = (e: PointerEvent): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // ── Pointer down — freeze scale ───────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent, idx: number) => {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    isDragging.current = true
    const pt: { x: number; y: number } = {
      x: e.clientX - svgRef.current!.getBoundingClientRect().left,
      y: e.clientY - svgRef.current!.getBoundingClientRect().top,
    }
    dragRef.current = {
      idx,
      startX:    pt.x,
      startY:    pt.y,
      origMicro: parseMicro(tiers[idx].pricePerUnit),
      origUnits: parseInt(tiers[idx].minUnits) || 0,
      frozenDom: { ...domain },   // snapshot — immutable for the whole drag
      frozenW:   w,
      frozenH:   h,
    }
    setActiveIdx(idx)
  }

  // ── Global pointermove / pointerup ────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || !svgRef.current) return
      const pt = svgPoint(e)

      const { idx, startX, startY, origMicro, origUnits, frozenDom, frozenW, frozenH } = drag

      // ── Price (y axis) ────────────────────────────────────────────────────
      // Dragging UP (smaller y) = higher price.
      const dyPx      = pt.y - startY                                    // positive = downward
      const deltaMicro = -dyPx * microPerPx(frozenDom, frozenH)          // negative dy = price rises
      const newMicroRaw = origMicro + deltaMicro

      const leftMicro  = idx > 0              ? parseMicro(tiers[idx - 1].pricePerUnit) : Infinity
      const rightMicro = idx < tiers.length-1 ? parseMicro(tiers[idx + 1].pricePerUnit) : 0
      const minGap     = origMicro / 1_000_000 < 1 ? 100 : 10_000

      const priceClamped = Math.max(
        rightMicro > 0 ? rightMicro + minGap : minGap,
        Math.min(Number.isFinite(leftMicro) ? leftMicro - minGap : newMicroRaw, newMicroRaw),
      )
      const priceSnapped = snapPrice(Math.max(minGap, priceClamped))

      // ── Units (x axis) ────────────────────────────────────────────────────
      let finalUnits = origUnits
      if (idx > 0) {
        const dxPx = pt.x - startX
        const deltaUnits = dxPx * unitsPerPx(frozenDom, frozenW)
        const newUnitsRaw = origUnits + deltaUnits

        const leftUnits  = parseInt(tiers[idx - 1].minUnits) || 0
        const rightUnits = idx < tiers.length-1
          ? (parseInt(tiers[idx + 1].minUnits) || 0)
          : Infinity

        finalUnits = Math.max(
          leftUnits + 1,
          Math.min(
            Number.isFinite(rightUnits) ? rightUnits - 1 : maxUnits,
            Math.min(maxUnits, Math.max(1, Math.round(newUnitsRaw))),
          ),
        )
      }

      const next = tiers.map((t, i) =>
        i !== idx ? t : {
          minUnits:     String(finalUnits),
          pricePerUnit: microToDisplay(priceSnapped),
        }
      )
      onChange(next)
    }

    const onUp = () => {
      isDragging.current = false
      dragRef.current = null
      // Refit domain after drag ends.
      setDomain(computeDomain(tiers, maxUnits, marketPricePerUnit))
      setActiveIdx(a => a)   // keep focus indicator — do not clear
    }

    const onCancel = () => {
      isDragging.current = false
      dragRef.current = null
      setDomain(computeDomain(tiers, maxUnits, marketPricePerUnit))
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup',     onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',     onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  // tiers / maxUnits / marketPricePerUnit are read inside the handlers but we
  // do NOT list them as deps — we want the handlers to see the *current* tiers
  // for neighbour clamping without re-registering the listeners on every render.
  // dragRef.current holds the frozen origin so it is safe to close over `tiers`
  // here only for neighbour reads (not for the origin itself).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange])

  // ── Keyboard handler ──────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const unitStep = e.shiftKey ? 10 : 1
    const next = tiers.map(t => ({ ...t }))
    const cur  = next[idx]
    const curMicro = parseMicro(cur.pricePerUnit)
    const curUnits = parseInt(cur.minUnits) || 0

    const leftMicro  = idx > 0              ? parseMicro(next[idx - 1].pricePerUnit) : Infinity
    const rightMicro = idx < next.length-1  ? parseMicro(next[idx + 1].pricePerUnit) : 0
    const leftUnits  = idx > 0              ? parseInt(next[idx - 1].minUnits) || 0 : 0
    const rightUnits = idx < next.length-1  ? (parseInt(next[idx + 1].minUnits) || 0) : Infinity

    // Price step = snap quantum, so snap(value ± step) === value ± step exactly.
    const pStep = priceStep(curMicro, e.shiftKey)
    const minGap = curMicro / 1_000_000 < 1 ? 100 : 10_000

    switch (e.key) {
      case 'ArrowUp': {
        e.preventDefault()
        const cap = Number.isFinite(leftMicro) ? leftMicro - minGap : Infinity
        const raw = snapPrice(curMicro + pStep)
        cur.pricePerUnit = microToDisplay(Math.min(cap, raw))
        break
      }
      case 'ArrowDown': {
        e.preventDefault()
        const floor = rightMicro > 0 ? rightMicro + minGap : minGap
        const raw = snapPrice(curMicro - pStep)
        cur.pricePerUnit = microToDisplay(Math.max(floor, raw))
        break
      }
      case 'ArrowRight': {
        if (idx === 0) return
        e.preventDefault()
        const cap = Number.isFinite(rightUnits) ? rightUnits - 1 : maxUnits
        cur.minUnits = String(Math.max(leftUnits + 1, Math.min(cap, curUnits + unitStep)))
        break
      }
      case 'ArrowLeft': {
        if (idx === 0) return
        e.preventDefault()
        const floor = leftUnits + 1
        cur.minUnits = String(Math.min(
          Number.isFinite(rightUnits) ? rightUnits - 1 : maxUnits,
          Math.max(floor, curUnits - unitStep),
        ))
        break
      }
      default: return
    }
    onChange(next)
  }

  // ── SVG rendering ─────────────────────────────────────────────────────────────

  const validTiers = tiers
    .map(t => ({ minUnits: parseInt(t.minUnits) || 0, priceMicro: parseMicro(t.pricePerUnit) }))
    .filter(t => t.minUnits > 0 && t.priceMicro > 0)

  // Step path + fill area (close down to bottom edge)
  const { strokeD, fillD } = (() => {
    if (validTiers.length === 0) return { strokeD: '', fillD: '' }
    const segs: string[] = []
    for (let i = 0; i < validTiers.length; i++) {
      const x0 = toX(validTiers[i].minUnits, domain, w)
      const y0 = toY(validTiers[i].priceMicro, domain, h)
      const x1 = i + 1 < validTiers.length
        ? toX(validTiers[i + 1].minUnits, domain, w)
        : toX(domain.unitsMax, domain, w)
      segs.push(i === 0 ? `M ${x0} ${y0}` : `L ${x0} ${y0}`)
      segs.push(`L ${x1} ${y0}`)
    }
    const stroke = segs.join(' ')
    // Fill: continue to bottom-right, bottom-left, back to start
    const lastX = toX(domain.unitsMax, domain, w)
    const firstX = toX(validTiers[0].minUnits, domain, w)
    const fill = stroke + ` L ${lastX} ${h - PAD_B} L ${firstX} ${h - PAD_B} Z`
    return { strokeD: stroke, fillD: fill }
  })()

  // Y-axis tick candidates: domain endpoints + each tier price; de-duplicate and
  // drop labels that are within 12px of a previously placed one.
  const yTickCandidates: number[] = (() => {
    const seen = new Set<number>()
    const candidates: number[] = [domain.priceMin, domain.priceMax]
    for (const t of validTiers) candidates.push(t.priceMicro)
    return candidates.filter(m => {
      const rounded = Math.round(m)
      if (seen.has(rounded)) return false
      seen.add(rounded)
      return true
    })
  })()

  const yTicksFiltered: number[] = (() => {
    // Sort by y position (top to bottom = high to low price) then cull overlaps.
    const sorted = [...yTickCandidates].sort((a, b) =>
      toY(b, domain, h) - toY(a, domain, h)   // ascending y = descending price
    )
    const kept: number[] = []
    for (const m of sorted) {
      const y = toY(m, domain, h)
      if (kept.every(prev => Math.abs(toY(prev, domain, h) - y) >= 12)) {
        kept.push(m)
      }
    }
    return kept
  })()

  const marketMicro = marketPricePerUnit ? parseMicro(marketPricePerUnit) : 0
  const marketY     = marketMicro > 0 ? toY(marketMicro, domain, h) : null

  const tooltipIdx  = activeIdx !== null
    ? (parseMicro(tiers[activeIdx]?.pricePerUnit ?? '') > 0 ? activeIdx : null)
    : null

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--surface-muted)' }}>
      <div className="px-3 pt-2.5 pb-1">
        <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
          Price curve - drag the points to edit
        </span>
      </div>

      <svg
        ref={svgRef}
        className="w-full block"
        style={{ height: h, touchAction: 'none', userSelect: 'none', cursor: 'default' }}
        aria-label="Price curve editor"
        role="img"
      >
        {/* Grid + y-axis labels (de-overlapped) */}
        {yTicksFiltered.map((micro, i) => {
          const y = toY(micro, domain, h)
          return (
            <g key={i}>
              <line x1={PAD_L} x2={w - PAD_R} y1={y} y2={y}
                stroke="var(--border)" strokeWidth={0.5} />
              <text x={PAD_L - 4} y={y + 3.5} fontSize={7.5}
                fill="var(--subtle)" textAnchor="end" fontFamily="monospace">
                {formatUsdcPrice(micro)}
              </text>
            </g>
          )
        })}

        {/* Market reference line */}
        {marketY !== null && (
          <g>
            <line x1={PAD_L} x2={w - PAD_R} y1={marketY} y2={marketY}
              stroke="var(--accent)" strokeWidth={1} strokeDasharray="5 3" opacity={0.45} />
            <text x={w - PAD_R - 3} y={marketY - 4} fontSize={7.5}
              fill="var(--accent)" textAnchor="end" fontFamily="monospace" opacity={0.7}>
              Market
            </text>
          </g>
        )}

        {/* Fill area under the step path */}
        {fillD && (
          <path d={fillD} fill="var(--accent)" fillOpacity={0.07} stroke="none" />
        )}

        {/* Step path — thicker */}
        {strokeD && (
          <path d={strokeD} fill="none" stroke="var(--accent)"
            strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        )}

        {/* Handles */}
        {tiers.map((tier, idx) => {
          const micro = parseMicro(tier.pricePerUnit)
          const units = parseInt(tier.minUnits) || 0
          if (micro <= 0 || units <= 0) return null
          const cx = toX(units, domain, w)
          const cy = toY(micro, domain, h)
          const isActive = activeIdx === idx
          return (
            <g key={idx}>
              {/* Focus / active ring — rendered behind the dot */}
              {isActive && (
                <circle cx={cx} cy={cy} r={13}
                  fill="none" stroke="var(--accent)" strokeWidth={1.5} opacity={0.3}
                  style={{ pointerEvents: 'none' }} />
              )}
              {/* Large transparent hit area */}
              <circle
                cx={cx} cy={cy} r={14}
                fill="transparent"
                style={{ cursor: isDragging.current && activeIdx === idx ? 'grabbing' : 'grab', touchAction: 'none' }}
                role="slider"
                tabIndex={0}
                aria-label={`Tier ${idx + 1}: from ${units} units at ${formatUsdcPrice(micro)}`}
                aria-valuenow={micro}
                aria-valuemin={1}
                aria-valuemax={5_000_000}
                onPointerDown={e => onPointerDown(e, idx)}
                onFocus={() => setActiveIdx(idx)}
                onBlur={() => { if (!isDragging.current) setActiveIdx(null) }}
                onKeyDown={e => onKeyDown(e, idx)}
              />
              {/* Visible dot — larger when active */}
              <circle
                cx={cx} cy={cy} r={isActive ? 8 : 6}
                fill="var(--surface)"
                stroke="var(--accent)"
                strokeWidth={isActive ? 3 : 2}
                style={{ pointerEvents: 'none' }}
              />
              {/* Tier index badge */}
              <text x={cx} y={cy + 1} fontSize={6.5} fill="var(--accent)"
                textAnchor="middle" dominantBaseline="middle" fontWeight="bold"
                style={{ pointerEvents: 'none' }}>
                {idx + 1}
              </text>
            </g>
          )
        })}

        {/* Tooltip — clamped inside chart bounds */}
        {tooltipIdx !== null && (() => {
          const tier  = tiers[tooltipIdx]
          const micro = parseMicro(tier.pricePerUnit)
          const units = parseInt(tier.minUnits) || 0
          if (micro <= 0 || units <= 0) return null
          const cx    = toX(units, domain, w)
          const cy    = toY(micro, domain, h)
          const label = tooltipForIdx(tooltipIdx)
          const tipW  = Math.min(label.length * 6.2 + 20, w - PAD_L - PAD_R)
          const tipH  = 20
          // Keep tooltip inside chart: prefer above, fall back to below
          const tipYAbove = cy - tipH - 8
          const tipYBelow = cy + 14
          const tipY = tipYAbove >= PAD_T ? tipYAbove : tipYBelow
          const tipX = Math.max(PAD_L, Math.min(cx - tipW / 2, w - PAD_R - tipW))
          return (
            <g style={{ pointerEvents: 'none' }}>
              <rect x={tipX} y={tipY} width={tipW} height={tipH} rx={4}
                fill="var(--surface)" stroke="var(--border)" strokeWidth={1} />
              <text x={tipX + tipW / 2} y={tipY + 13} fontSize={8}
                fill="var(--ink)" textAnchor="middle" fontFamily="monospace">
                {label}
              </text>
            </g>
          )
        })()}

        {/* X-axis labels at each tier */}
        {validTiers.map((t, i) => (
          <text key={i} x={toX(t.minUnits, domain, w)} y={h - PAD_B + 11}
            fontSize={7.5} fill="var(--subtle)" textAnchor="middle" fontFamily="monospace">
            {t.minUnits}
          </text>
        ))}
      </svg>
    </div>
  )
}
