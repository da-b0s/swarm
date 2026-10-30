/**
 * SwarmLogo — a cluster of hexagons converging toward one larger central hex.
 * "Many come together" in a single mark.
 *
 * Renders as an inline SVG; uses `currentColor` for the satellite hexes and
 * `var(--accent)` for the central hex so it picks up the site's blue accent
 * on both light and dark backgrounds.
 *
 * Props:
 *   size        — px width/height (default 32)
 *   accentColor — overrides the fill of the centre hex (use in favicon)
 */

interface Props {
  size?: number
  accentColor?: string
}

export function SwarmLogo({ size = 32, accentColor }: Props) {
  const accent = accentColor ?? 'var(--accent)'

  // Flat-top hexagon path centred at (cx, cy) with outer radius r
  const hex = (cx: number, cy: number, r: number) => {
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 180) * (60 * i)
      return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`
    })
    return `M ${pts.join(' L ')} Z`
  }

  // Geometry: centre hex + 6 satellite hexes arranged in a tight ring.
  // The ring hexes are slightly smaller and sit closer than a normal honeycomb
  // so they appear to converge inward.
  const C = 50          // viewBox centre
  const R = 18          // centre hex radius
  const r = 11          // satellite radius
  const D = 29          // ring distance (< R+r means slight overlap = "converging")

  const satellites = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 30)
    return { cx: C + D * Math.cos(a), cy: C + D * Math.sin(a) }
  })

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Satellite hexes — dim, current colour */}
      {satellites.map(({ cx, cy }, i) => (
        <path
          key={i}
          d={hex(cx, cy, r)}
          fill="currentColor"
          opacity={0.28 + i * 0.02}
        />
      ))}
      {/* Centre hex — accent colour, fully opaque */}
      <path d={hex(C, C, R)} fill={accent} />
    </svg>
  )
}
