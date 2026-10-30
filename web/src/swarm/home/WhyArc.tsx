/**
 * WhyArc — three short columns on Arc advantages.
 * No icons; large display text anchors each column.
 */

const COLUMNS = [
  {
    anchor: 'USDC',
    heading: 'Pay in USDC, no gas token',
    body: 'On Arc the gas fee is paid in USDC, the same token you are already spending. No ETH, no extra wallet balance to maintain.',
  },
  {
    anchor: '1 sig',
    heading: 'One signature to join',
    body: 'Swarm sends orders through a relayer so you sign once and pay nothing. The relayer covers the gas; Swarm holds nothing.',
  },
  {
    anchor: 'Auto',
    heading: 'Settles itself',
    body: 'A keeper watches the chain and closes deals when the deadline passes. You just come back and collect. No manual settlement required.',
  },
] as const

export function WhyArc() {
  return (
    <section>
      <h2 className="display text-xl font-bold mb-6" style={{ color: 'var(--ink)' }}>
        Why Arc
      </h2>
      <div className="grid gap-4 sm:grid-cols-3">
        {COLUMNS.map(({ anchor, heading, body }) => (
          <div key={heading} className="rounded-2xl px-5 py-5"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <p className="display text-4xl font-bold mb-3" style={{ color: 'var(--accent)', opacity: 0.35 }}>
              {anchor}
            </p>
            <p className="font-semibold text-sm mb-1.5" style={{ color: 'var(--ink)' }}>{heading}</p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
