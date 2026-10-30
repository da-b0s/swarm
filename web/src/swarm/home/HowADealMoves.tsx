/**
 * HowADealMoves — four steps, each anchored by a large concrete example value.
 * No icons. Numbers and type do the work.
 */

const STEPS = [
  {
    num: '1.',
    label: 'Post',
    value: '50 EURC deposited',
    body: 'The seller locks their stock in the contract and sets the price ladder. Nothing moves until the deal closes.',
  },
  {
    num: '2.',
    label: 'Join',
    value: '1.20 USDC per unit, held in the contract',
    body: 'Buyers place orders in USDC. One signature, no gas token. Money sits in the contract, not with anyone.',
  },
  {
    num: '3.',
    label: 'Price drops',
    value: '25 units sold: 1.17',
    body: 'Each tier threshold unlocks a lower price for everyone, including the people who joined first.',
  },
  {
    num: '4.',
    label: 'Close',
    value: 'Everyone pays 1.15. Refunds and EURC in one transaction.',
    body: 'When the timer ends, a keeper settles the deal. Tokens are delivered, overpayments refunded. Nobody has to press a button.',
  },
] as const

export function HowADealMoves() {
  return (
    <section>
      <h2 className="display text-xl font-bold mb-6" style={{ color: 'var(--ink)' }}>
        How a deal moves
      </h2>
      <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-4 rounded-2xl overflow-hidden"
        style={{ background: 'var(--border)' }}>
        {STEPS.map(({ num, label, value, body }) => (
          <div key={num} className="px-5 py-5 flex flex-col gap-3"
            style={{ background: 'var(--surface)' }}>
            <div>
              <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
                {num} {label}
              </span>
            </div>
            <p className="display text-lg font-bold leading-snug" style={{ color: 'var(--accent)' }}>
              {value}
            </p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
              {body}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
