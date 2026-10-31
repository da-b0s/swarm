/**
 * HomePage — calm, centred landing page.
 *
 * Sections:
 *  1. Hero: gradient background, centred headline, search-style entry card,
 *     token chips, "or sell on Swarm" link.
 *  2. Stats band (unchanged from previous version).
 *  3. How it works: three cards inside one large rounded container.
 */

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Search, ArrowRight } from 'lucide-react'
import { useTheme } from './theme'
import { useSwarmStats } from './useSwarmStats'
import { formatUsdcPrice } from './utils'
import { ACTIVE_NETWORK, GOODS_TOKENS } from './config'

interface Props {
  onBrowse:     () => void
  onSell:       () => void
  onSelectDeal?: (id: bigint) => void
}

const fade = {
  initial: { opacity: 0, y: 12 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true },
  transition: { duration: 0.38 },
}

// ── Stats band ────────────────────────────────────────────────────────────────

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
    <motion.section {...fade} transition={{ duration: 0.38, delay: 0.1 }}
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

// ── How it works ──────────────────────────────────────────────────────────────

const HOW_STEPS = [
  {
    label: 'Post a deal',
    value: '50 EURC deposited',
    body: 'The seller sets a price ladder and locks stock in the contract. Nothing moves until the deal closes.',
  },
  {
    label: 'Join and watch the price fall',
    value: '25 units: $1.17',
    body: 'Each tier threshold unlocks a lower price for everyone, including buyers who joined first.',
  },
  {
    label: 'Close',
    value: 'Everyone pays $1.15',
    body: 'A keeper settles the deal. Tokens are delivered, overpayments refunded. Nobody has to press a button.',
  },
] as const

function HowItWorks({ onBrowse, onSell }: { onBrowse: () => void; onSell: () => void }) {
  return (
    <motion.section {...fade}>
      <div className="rounded-2xl overflow-hidden"
        style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div className="px-6 pt-6 pb-2">
          <h2 className="display text-xl font-bold" style={{ color: 'var(--ink)' }}>
            How it works
          </h2>
        </div>
        <div className="grid sm:grid-cols-3 gap-px" style={{ background: 'var(--border)' }}>
          {HOW_STEPS.map(({ label, value, body }, i) => (
            <div key={i} className="px-6 py-6 flex flex-col gap-3"
              style={{ background: 'var(--surface)' }}>
              <span className="text-xs font-semibold tabular-nums"
                style={{ color: 'var(--muted)' }}>{i + 1}.</span>
              <p className="text-lg font-bold leading-snug" style={{ color: 'var(--accent)' }}>
                {value}
              </p>
              <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{label}</p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{body}</p>
            </div>
          ))}
        </div>
        <div className="px-6 py-4 flex items-center justify-between border-t flex-wrap gap-3"
          style={{ borderColor: 'var(--border)' }}>
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>
            Early buyers are not penalised. When the deal closes, everyone pays the final price and gets the difference back.
          </p>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={onSell}
              className="text-sm font-medium transition-opacity hover:opacity-70"
              style={{ color: 'var(--muted)' }}>
              Sell on Swarm
            </button>
            <button onClick={onBrowse}
              className="flex items-center gap-1.5 text-sm font-semibold rounded-xl px-4 py-2 transition-all hover:opacity-90"
              style={{ background: 'var(--accent)', color: '#fff' }}>
              Browse deals <ArrowRight className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </motion.section>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function HomePage({ onBrowse, onSell }: Props) {
  const [query, setQuery] = useState('')
  const theme = useTheme()
  const isDark = theme === 'dark'

  // Hero colour palette adapts to theme.
  const heroText        = isDark ? 'rgba(255,255,255,0.9)'  : '#122d45'
  const heroSubtext     = isDark ? 'rgba(255,255,255,0.65)' : '#334155'
  const heroPill        = isDark ? 'rgba(74,222,128,0.12)'  : 'rgba(26,128,71,0.1)'
  const heroPillText    = isDark ? '#4ade80'                 : '#1a8047'
  const heroDotColor    = isDark ? '#4ade80'                 : '#1a8047'
  const heroInputBg     = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.6)'
  const heroInputBorder = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(18,45,69,0.2)'
  const heroInputColor  = isDark ? 'rgba(255,255,255,0.9)'  : '#122d45'
  const heroChipBg      = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(18,45,69,0.07)'
  const heroChipBorder  = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(18,45,69,0.14)'
  const heroChipText    = isDark ? 'rgba(255,255,255,0.75)' : '#122d45'
  const heroLinkColor   = isDark ? 'rgba(255,255,255,0.4)'  : '#6b6580'
  const heroGlow        = isDark
    ? 'radial-gradient(ellipse 60% 50% at 50% 55%, rgba(30,120,200,0.18) 0%, transparent 70%)'
    : 'radial-gradient(ellipse 60% 50% at 50% 55%, rgba(18,45,69,0.06) 0%, transparent 70%)'
  const heroIconColor   = isDark ? 'rgba(255,255,255,0.4)'  : '#6b6580'

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    onBrowse()
  }

  return (
    <div>

      {/* 1. Hero — gradient background */}
      <section
        className="relative overflow-hidden"
        style={{
          background: 'var(--hero-bg, linear-gradient(160deg, #0d1f33 0%, #122d45 50%, #0a1a28 100%))',
          minHeight: '520px',
        }}
      >
        {/* Radial glow behind centre */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: heroGlow }} />

        <div className="relative max-w-2xl mx-auto px-4 pt-20 pb-16 flex flex-col items-center text-center">

          {/* Live pill */}
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32 }}
            className="mb-6 inline-flex items-center gap-2">
            <span className="relative flex size-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                style={{ background: heroDotColor }} />
              <span className="relative inline-flex rounded-full size-2"
                style={{ background: heroDotColor }} />
            </span>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{ background: heroPill, color: heroPillText }}>
              {ACTIVE_NETWORK === 'testnet' ? 'Live on Arc testnet' : 'Live on Arc mainnet'}
            </span>
          </motion.div>

          {/* Headline */}
          <motion.h1
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.36, delay: 0.06 }}
            className="display text-5xl sm:text-6xl font-bold leading-tight tracking-tight"
            style={{ color: heroText }}>
            Buy together.<br />Pay less.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.36, delay: 0.12 }}
            className="mt-4 text-base sm:text-lg max-w-md"
            style={{ color: heroSubtext }}>
            Group deals on assets on Arc. The more people buy, the better everyone&apos;s rate.
          </motion.p>

          {/* Search / entry card */}
          <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.36, delay: 0.18 }}
            className="mt-8 w-full max-w-lg">
            <form onSubmit={handleSearch}
              className="flex items-center rounded-2xl overflow-hidden shadow-lg"
              style={{ background: heroInputBg, border: `1px solid ${heroInputBorder}`, backdropFilter: 'blur(12px)' }}>
              <Search className="ml-4 size-4 shrink-0" style={{ color: heroIconColor }} />
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="What do you want to buy?"
                className="flex-1 bg-transparent px-3 py-3.5 text-sm outline-none placeholder:opacity-40"
                style={{ color: heroInputColor }}
              />
              <button type="submit"
                className="m-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold shrink-0 transition-all hover:opacity-90"
                style={{ background: 'var(--accent)', color: '#fff' }}>
                Browse deals
              </button>
            </form>

            {/* Token chips */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {GOODS_TOKENS.map(tok => (
                <button key={tok.address}
                  onClick={onBrowse}
                  className="text-xs font-semibold px-3 py-1.5 rounded-full transition-all hover:opacity-80"
                  style={{ background: heroChipBg, border: `1px solid ${heroChipBorder}`, color: heroChipText }}>
                  {tok.symbol}
                </button>
              ))}
              <button onClick={onSell}
                className="text-xs transition-opacity hover:opacity-70"
                style={{ color: heroLinkColor }}>
                or sell on Swarm
              </button>
            </div>
          </motion.div>

        </div>
      </section>

      {/* 2. Stats + 3. How it works */}
      <div className="max-w-6xl mx-auto px-4 py-12 space-y-10">
        <StatsBand />
        <HowItWorks onBrowse={onBrowse} onSell={onSell} />
      </div>

    </div>
  )
}
