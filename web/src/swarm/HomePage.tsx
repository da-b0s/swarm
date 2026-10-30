import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSwarmStats } from './useSwarmStats'
import { formatUsdcPrice } from './utils'
import { ChevronDown, ArrowRight } from 'lucide-react'

interface Props {
  onBrowse: () => void
  onSell: () => void
}

const STEPS = [
  { num: '1', title: 'Join a deal',            body: 'Pick how many you want and place your order in USDC. One signature, no network fee.' },
  { num: '2', title: 'The price drops',        body: 'Every order brings the price down for everyone in the deal, including the people who joined first.' },
  { num: '3', title: 'Collect when it closes', body: 'When the timer ends, everyone pays the same final price. Collect your tokens and any difference you overpaid.' },
]

const PROMISES = [
  { title: 'Your money is never held by us',    body: 'Payments sit in a public smart contract until the deal closes. Anyone can check every deal on the Proof page.' },
  { title: 'Full refund if a deal falls short', body: 'If a deal doesn’t reach its minimum, everyone gets all of their money back.' },
  { title: 'Nothing to babysit',                body: 'Deals close by themselves when the timer ends. You just come back and collect.' },
]

const FAQ = [
  { q: 'What can I buy?',
    a: "Deals sell assets on Arc — including EURC, GBPA, MXNB, cirBTC, and WETH — paid for in USDC. Every buyer pays the same final price." },
  { q: 'How is the final price decided?',
    a: 'Each deal has price levels set by the seller, for example $1.20 each, then $1.17 once 25 are ordered. When the deal closes, the price is set by the total ordered, and everyone pays that same price. If you paid more when you joined, the difference comes back to you.' },
  { q: 'What do I need to order?',
    a: 'A crypto wallet with USDC on Arc. Ordering takes one signature in your wallet. There is no separate network fee to pay.' },
  { q: 'Can I change my mind?',
    a: 'Yes. While a deal is open you can add more, remove some units or cancel your whole order, and the money goes straight back to your wallet. The one exception: you cannot cancel if it would push the price back up above what another buyer has already paid.' },
  { q: 'What happens if not enough people join?',
    a: 'Every deal has a minimum. If it is not reached by the deadline, the deal is cancelled and everyone is refunded in full. The seller gets their tokens back.' },
  { q: 'When do I get my tokens?',
    a: 'As soon as the deal closes, usually within a minute of the deadline. A banner at the top of the site shows anything waiting for you, with a button to collect it.' },
  { q: 'How do I sell on Swarm?',
    a: 'Go to Sell, choose the token you are offering, set your price levels, minimum and deadline, and post the deal. Your stock is held by the contract and anything unsold comes back to you. Your earnings are ready to collect when the deal closes.' },
]

const fade = { initial: { opacity: 0, y: 10 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true }, transition: { duration: 0.35 } }

export function HomePage({ onBrowse, onSell }: Props) {
  const [open, setOpen] = useState<number | null>(0)
  const stats = useSwarmStats()
  const STATS = [
    { label: 'Volume',          value: stats ? formatUsdcPrice(stats.volume) : null },
    { label: 'Units sold',      value: stats ? stats.units.toLocaleString('en-US') : null },
    { label: 'Buyers',          value: stats ? stats.buyers.toLocaleString('en-US') : null },
    { label: 'Deals',           value: stats ? stats.deals.toLocaleString('en-US') : null },
    { label: 'Saved by buyers', value: stats ? formatUsdcPrice(stats.saved) : null },
  ]

  return (
    <div className="px-4 pb-16">
      {/* Hero — full width, one column */}
      <section className="pt-12 pb-6 sm:pt-16">
        <motion.h1 {...fade}
          className="display text-4xl sm:text-5xl font-bold leading-tight text-center lg:text-left"
          style={{ color: 'var(--ink)' }}>
          Buy together.<br />Pay less.
        </motion.h1>
        <motion.p {...fade} transition={{ duration: 0.35, delay: 0.05 }}
          className="mt-4 text-base sm:text-lg max-w-xl text-center lg:text-left"
          style={{ color: 'var(--muted)' }}>
          Group deals on assets on Arc. The more people buy, the better everyone&apos;s rate.
        </motion.p>
        <motion.div {...fade} transition={{ duration: 0.35, delay: 0.1 }}
          className="mt-7 flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
          <button onClick={onBrowse}
            className="inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all hover:opacity-90"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            Browse deals <ArrowRight className="size-4" />
          </button>
          <button onClick={onSell}
            className="rounded-xl px-5 py-3 text-sm font-semibold transition-all hover:opacity-80"
            style={{ color: 'var(--ink)', border: '1px solid var(--border)', background: 'var(--surface)' }}>
            Sell on Swarm
          </button>
        </motion.div>
      </section>

      {/* Stats band — full width, all five in one row on desktop */}
      <motion.section {...fade} transition={{ duration: 0.35, delay: 0.12 }}
        aria-label="Swarm in numbers"
        className="rounded-2xl overflow-hidden"
        style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
        {/* gap-px + surface-muted wrapper = 1px grid lines at any breakpoint */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px"
          style={{ background: 'var(--border)' }}>
          {STATS.map(({ label, value }, i) => (
            <div key={label}
              className={`px-5 py-5 flex flex-col gap-1${i === 4 ? ' col-span-2 sm:col-span-1' : ''}`}
              style={{ background: 'var(--surface)' }}>
              <p className="display text-4xl font-bold tabular-nums leading-none"
                style={{ color: 'var(--ink)' }}>
                {value ?? (
                  <span className="inline-block w-20 h-9 rounded-lg animate-pulse align-middle"
                    style={{ background: 'var(--surface-muted)' }} />
                )}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{label}</p>
            </div>
          ))}
        </div>
        <p className="px-5 py-2.5 text-xs border-t" style={{ color: 'var(--subtle)', borderColor: 'var(--border)' }}>
          Live from the blockchain, updated every few seconds.
        </p>
      </motion.section>

      {/* How it works */}
      <section className="py-8">
        <h2 className="display text-xl font-bold mb-5" style={{ color: 'var(--ink)' }}>How it works</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map(({ num, title, body }) => (
            <motion.div key={title} {...fade}
              className="rounded-2xl p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <span className="display text-3xl font-bold tabular-nums block mb-2"
                style={{ color: 'var(--accent)', opacity: 0.4 }}>{num}</span>
              <p className="font-semibold text-sm" style={{ color: 'var(--ink)' }}>{title}</p>
              <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>{body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Built to be fair */}
      <section className="py-8">
        <h2 className="display text-xl font-bold mb-5" style={{ color: 'var(--ink)' }}>Built to be fair</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {PROMISES.map(({ title, body }) => (
            <motion.div key={title} {...fade}
              className="rounded-2xl p-5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <p className="font-semibold text-sm mb-1" style={{ color: 'var(--ink)' }}>{title}</p>
              <p className="text-sm" style={{ color: 'var(--muted)' }}>{body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="py-8">
        <h2 className="display text-xl font-bold mb-5" style={{ color: 'var(--ink)' }}>Questions</h2>
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
          {FAQ.map(({ q, a }, i) => (
            <div key={q} style={{ borderTop: i ? '1px solid var(--border)' : undefined }}>
              <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}
                className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left text-sm font-semibold"
                style={{ color: 'var(--ink)' }}>
                {q}
                <ChevronDown className="size-4 shrink-0 transition-transform"
                  style={{ color: 'var(--muted)', transform: open === i ? 'rotate(180deg)' : undefined }} />
              </button>
              <AnimatePresence initial={false}>
                {open === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                    <p className="px-4 pb-4 text-sm" style={{ color: 'var(--muted)' }}>{a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </section>

      {/* Closing CTA */}
      <section className="pt-4 pb-4">
        <button onClick={onBrowse}
          className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all hover:opacity-90"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          See what&apos;s live <ArrowRight className="size-4" />
        </button>
      </section>
    </div>
  )
}