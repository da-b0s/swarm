import { motion } from 'framer-motion'
import { Play, Square, ExternalLink, CheckCircle, XCircle } from 'lucide-react'
import { useEventLog } from './useEventLog'
import { formatUsdcPrice, txUrl, shortAddr } from './utils'
import { ARC_NETWORK } from './config'

const fadeUp = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.22 } }

export function ProofPage() {
  const { events, scanState, progress, error, stats, scan, stop } = useEventLog()

  const pct = progress.total > 0n
    ? Math.min(100, Math.round(Number((progress.scanned * 100n) / progress.total)))
    : 0

  const scanning = scanState === 'scanning'

  return (
    <div className="w-full max-w-2xl mx-auto px-4 pb-12 space-y-6">
      <motion.div {...fadeUp} className="pt-6">
        <h1 className="display text-2xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>
          Conservation proof
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Events read live from {ARC_NETWORK.name}. Settled: commits in = supplier credited + refunds out. Refunded: commits in = refunds out. Verified to the wei.
        </p>
      </motion.div>

      {/* Scan controls */}
      <motion.div {...fadeUp} transition={{ delay: 0.04 }}
        className="rounded-2xl p-4 flex items-center gap-3"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <button
          onClick={scanning ? stop : scan}
          className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
          style={{ background: scanning ? 'var(--surface-muted)' : 'var(--accent)', color: scanning ? 'var(--ink)' : '#fff' }}
        >
          {scanning
            ? <><Square className="size-3.5" /> Stop</>
            : <><Play className="size-3.5" /> {scanState === 'done' ? 'Rescan' : 'Scan events'}</>}
        </button>

        {scanning && (
          <div className="flex-1 space-y-1">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
              <motion.div
                className="h-full rounded-full"
                style={{ background: 'var(--accent)' }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.4 }}
              />
            </div>
            <p className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
              {pct}% · {events.length} events · {progress.head.toString()} head
            </p>
          </div>
        )}

        {scanState === 'done' && (
          <span className="text-sm" style={{ color: 'var(--muted)' }}>
            {events.length} events · {stats.distinctBuyers.size} buyers · {stats.tierBreaks} tier breaks
          </span>
        )}

        {error && <span className="text-sm" style={{ color: 'var(--danger)' }}>{error}</span>}
      </motion.div>

      {/* Stats summary */}
      {scanState !== 'idle' && (
        <motion.div {...fadeUp} transition={{ delay: 0.06 }}
          className="grid grid-cols-2 gap-3"
        >
          {[
            { label: 'Total committed', value: formatUsdcPrice(stats.totalCommits) },
            { label: 'Total refunded', value: formatUsdcPrice(stats.totalRefunds) },
            { label: 'Total claimed', value: formatUsdcPrice(stats.totalClaimed) },
            { label: 'Tier breaks', value: stats.tierBreaks.toString() },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{label}</p>
              <p className="display text-xl font-bold tabular-nums mt-0.5" style={{ color: 'var(--ink)' }}>{value}</p>
            </div>
          ))}
        </motion.div>
      )}

      {/* Per-deal conservation table */}
      {stats.deals.size > 0 && (
        <motion.div {...fadeUp} transition={{ delay: 0.08 }}
          className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid var(--border)' }}
        >
          <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>
              Deals
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {Array.from(stats.deals.values()).map(deal => (
              <div key={deal.dealId} className="px-4 py-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="mono text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                    Deal #{deal.dealId}
                  </span>
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full"
                    style={{
                      background: deal.settled ? 'rgba(26,128,71,0.1)' : deal.refunded ? 'rgba(107,101,128,0.1)' : 'rgba(18,45,69,0.08)',
                      color: deal.settled ? 'var(--success)' : deal.refunded ? 'var(--muted)' : 'var(--subtle)',
                    }}
                  >
                    {deal.settled ? 'Settled' : deal.refunded ? 'Refunded' : 'Open'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                  <div>
                    <p>Commits in</p>
                    <p className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{formatUsdcPrice(deal.commitsIn)}</p>
                  </div>
                  <div>
                    <p>Supplier</p>
                    <p className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{formatUsdcPrice(deal.supplierCredited)}</p>
                  </div>
                  <div>
                    <p>Refunds</p>
                    <p className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{formatUsdcPrice(deal.refundsOut)}</p>
                  </div>
                </div>
                {(deal.settled || deal.refunded) && deal.conserved !== null && (
                  <div className="flex items-center gap-1.5 mt-1">
                    {deal.conserved
                      ? <CheckCircle className="size-3.5" style={{ color: 'var(--success)' }} />
                      : <XCircle className="size-3.5" style={{ color: 'var(--danger)' }} />}
                    <span className="text-xs" style={{ color: deal.conserved ? 'var(--success)' : 'var(--danger)' }}>
                      {deal.conserved ? 'Conservation verified' : 'Conservation FAILED — investigate'}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Event log */}
      {events.length > 0 && (
        <motion.div {...fadeUp} transition={{ delay: 0.1 }}
          className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid var(--border)' }}
        >
          <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>
              Event log — {events.length} events, newest first
            </span>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 480 }}>
            {events.slice().reverse().map((ev, i) => (
              <div
                key={`${ev.txHash}-${ev.logIndex}`}
                className="flex items-start gap-3 px-4 py-2.5"
                style={{ borderTop: i > 0 ? '1px solid var(--border)' : undefined }}
              >
                <EventBadge type={ev.type} />
                <div className="flex-1 min-w-0 space-y-0.5">
                  <EventSummary ev={ev} />
                  <a
                    href={txUrl(ev.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-xs"
                    style={{ color: 'var(--subtle)' }}
                  >
                    <span className="mono">{ev.txHash.slice(0, 10)}…</span>
                    <ExternalLink className="size-2.5" />
                  </a>
                </div>
                <span className="mono text-xs shrink-0" style={{ color: 'var(--subtle)' }}>
                  {ev.blockNumber.toString()}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  )
}

const EVENT_COLORS: Record<string, string> = {
  DealPosted: '#122d45',
  Committed:  '#1a8047',
  Withdrawn:  '#6b6580',
  TierBroken: '#1061a6',
  Settled:    '#1a8047',
  Refunded:   '#ba2b4c',
  Claimed:    '#1a8047',
}

function EventBadge({ type }: { type: string }) {
  return (
    <span
      className="shrink-0 mt-0.5 inline-block rounded-md px-1.5 py-0.5 text-xs font-semibold"
      style={{ background: `${EVENT_COLORS[type]}18`, color: EVENT_COLORS[type] ?? 'var(--muted)' }}
    >
      {type}
    </span>
  )
}

function EventSummary({ ev }: { ev: import('./useEventLog').SwarmEvent }) {
  const a = ev.args
  switch (ev.type) {
    case 'DealPosted':
      return <p className="text-xs" style={{ color: 'var(--ink-2)' }}>Deal #{String(a.dealId)} · start {formatUsdcPrice(BigInt(String(a.startPrice)))} · {String(a.minBuyers)} min</p>
    case 'Committed':
      return <p className="text-xs" style={{ color: 'var(--ink-2)' }}>Deal #{String(a.dealId)} · {shortAddr(String(a.buyer))} paid {formatUsdcPrice(BigInt(String(a.pricePaid)))} · {String(a.buyerCount)} buyers</p>
    case 'Withdrawn':
      return <p className="text-xs" style={{ color: 'var(--ink-2)' }}>Deal #{String(a.dealId)} · {shortAddr(String(a.buyer))} withdrew {formatUsdcPrice(BigInt(String(a.amountReturned)))} · {String(a.buyerCount)} buyers</p>
    case 'TierBroken':
      return <p className="text-xs" style={{ color: 'var(--ink-2)' }}>Deal #{String(a.dealId)} · price → {formatUsdcPrice(BigInt(String(a.newPrice)))} at {String(a.newBuyerCount)} buyers</p>
    case 'Settled':
      return <p className="text-xs" style={{ color: 'var(--ink-2)' }}>Deal #{String(a.dealId)} · cleared at {formatUsdcPrice(BigInt(String(a.clearingPrice)))} · {String(a.buyerCount)} buyers</p>
    case 'Refunded':
      return <p className="text-xs" style={{ color: 'var(--ink-2)' }}>Deal #{String(a.dealId)} · {shortAddr(String(a.buyer))} refunded {formatUsdcPrice(BigInt(String(a.amount)))}</p>
    case 'Claimed':
      return <p className="text-xs" style={{ color: 'var(--ink-2)' }}>{shortAddr(String(a.claimant))} claimed {formatUsdcPrice(BigInt(String(a.amount)))}</p>
    default:
      return <p className="text-xs" style={{ color: 'var(--muted)' }}>Unknown event</p>
  }
}
