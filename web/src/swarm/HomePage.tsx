/**
 * HomePage — composition root for the Swarm landing page.
 *
 * Sections (in order):
 *  1. Hero  — headline + live deal card
 *  2. Stats band
 *  3. "Watch the price fall" — PriceFallAnimation explainer
 *  4. "How a deal moves" — four concrete steps
 *  5. Why Arc — three columns
 *  6. Live activity — latest 6 on-chain events
 *  7. Closing CTA + footer
 */

import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { useSwarmStats } from './useSwarmStats'
import { formatUsdcPrice } from './utils'
import { ACTIVE_NETWORK } from './config'
import { LiveDealCard }       from './home/LiveDealCard'
import { PriceFallAnimation } from './home/PriceFallAnimation'
import { HowADealMoves }      from './home/HowADealMoves'
import { WhyArc }             from './home/WhyArc'
import { LiveActivity }       from './home/LiveActivity'
import { ClosingCta }         from './home/ClosingCta'

interface Props {
  onBrowse:     () => void
  onSell:       () => void
  onProof:      () => void
  onSelectDeal: (id: bigint) => void
}

const fade = {
  initial: { opacity: 0, y: 10 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true },
  transition: { duration: 0.35 },
}

// ── Stats band (kept exactly as-is) ──────────────────────────────────────────

function StatsBand() {
  const stats = useSwarmStats()
  const STATS = [
    { label: 'Volume',          value: stats ? formatUsdcPrice(stats.volume) : null },
    { label: 'Units sold',      value: stats ? stats.units.toLocaleString('en-US') : null },
    { label: 'Buyers',          value: stats ? stats.buyers.toLocaleString('en-US') : null },
    { label: 'Deals',           value: stats ? stats.deals.toLocaleString('en-US') : null },
    { label: 'Saved by buyers', value: stats ? formatUsdcPrice(stats.saved) : null },
  ]
  return (
    <motion.section {...fade} transition={{ duration: 0.35, delay: 0.12 }}
      aria-label="Swarm in numbers"
      className="rounded-2xl overflow-hidden"
      style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
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
      <p className="px-5 py-2.5 text-xs border-t"
        style={{ color: 'var(--subtle)', borderColor: 'var(--border)' }}>
        Live from the blockchain, updated every few seconds.
      </p>
    </motion.section>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function HomePage({ onBrowse, onSell, onProof, onSelectDeal }: Props) {
  return (
    <div className="px-4 pb-16 space-y-10">

      {/* 1. Hero */}
      <section className="pt-10 sm:pt-14 grid lg:grid-cols-[1fr_380px] lg:gap-12 lg:items-center">

        {/* Left: headline */}
        <div>
          {/* Live pill */}
          <motion.div {...fade} className="mb-4 inline-flex items-center gap-2">
            <span className="relative flex size-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                style={{ background: 'var(--success)' }} />
              <span className="relative inline-flex rounded-full size-2"
                style={{ background: 'var(--success)' }} />
            </span>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{ background: 'rgba(26,128,71,0.1)', color: 'var(--success)' }}>
              {ACTIVE_NETWORK === 'testnet' ? 'Live on Arc testnet' : 'Live on Arc mainnet'}
            </span>
          </motion.div>

          <motion.h1 {...fade} transition={{ duration: 0.35, delay: 0.04 }}
            className="display text-4xl sm:text-5xl font-bold leading-tight"
            style={{ color: 'var(--ink)' }}>
            Buy together.<br />Pay less.
          </motion.h1>

          <motion.p {...fade} transition={{ duration: 0.35, delay: 0.08 }}
            className="mt-4 text-base sm:text-lg max-w-xl"
            style={{ color: 'var(--muted)' }}>
            Group deals on assets on Arc. The more people buy, the better everyone&apos;s rate.
          </motion.p>

          <motion.div {...fade} transition={{ duration: 0.35, delay: 0.12 }}
            className="mt-7 flex flex-col sm:flex-row gap-3">
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
        </div>

        {/* Right: live deal card */}
        <motion.div {...fade} transition={{ duration: 0.35, delay: 0.18 }}
          className="mt-8 lg:mt-0">
          <LiveDealCard onJoin={onSelectDeal} onPost={onSell} />
        </motion.div>
      </section>

      {/* 2. Stats band */}
      <StatsBand />

      {/* 3. Watch the price fall */}
      <motion.section {...fade} className="grid lg:grid-cols-[1fr_360px] lg:gap-12 lg:items-start">
        <div>
          <h2 className="display text-xl font-bold mb-3" style={{ color: 'var(--ink)' }}>
            Watch the price fall
          </h2>
          <PriceFallAnimation />
        </div>
        {/* Right column padding on desktop so section doesn't look orphaned */}
        <div className="hidden lg:flex items-center justify-center pt-8">
          <div className="rounded-2xl p-6 space-y-3 text-sm"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', maxWidth: '28ch' }}>
            <p className="font-semibold" style={{ color: 'var(--ink)' }}>Three tier example</p>
            {[
              { units: 'Any units', price: '$1.20' },
              { units: '25+ units', price: '$1.17' },
              { units: '50+ units', price: '$1.15' },
            ].map(({ units, price }) => (
              <div key={units} className="flex justify-between">
                <span style={{ color: 'var(--muted)' }}>{units}</span>
                <span className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{price}</span>
              </div>
            ))}
            <p className="text-xs pt-1" style={{ color: 'var(--subtle)' }}>
              Everyone who joined at $1.20 gets a refund of $0.05 per unit when the deal closes at $1.15.
            </p>
          </div>
        </div>
      </motion.section>

      {/* 4. How a deal moves */}
      <motion.div {...fade}><HowADealMoves /></motion.div>

      {/* 5. Why Arc */}
      <motion.div {...fade}><WhyArc /></motion.div>

      {/* 6. Live activity */}
      <motion.div {...fade}><LiveActivity onProof={onProof} /></motion.div>

      {/* 7. Closing CTA + footer */}
      <motion.div {...fade}>
        <ClosingCta onBrowse={onBrowse} onPost={onSell} onProof={onProof} />
      </motion.div>

    </div>
  )
}
