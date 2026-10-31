/**
 * ProofPage v2 — conservation proof for both USDC and goods tokens.
 *
 * USDC:
 *   settled:  commitsIn = supplierCredited + refundsOut
 *   refunded: commitsIn = refundsOut
 *
 * Goods (ERC-20):
 *   settled:  unitsDelivered reported from Settled event
 *   refunded: full stock returned to supplier
 */

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Play, Square, ExternalLink, CheckCircle, XCircle } from 'lucide-react'
import { useEventLog } from './useEventLog'
import { formatUsdcPrice, txUrl, shortAddr, formatTokenAmount } from './utils'
import { ARC_NETWORK, GOODS_TOKENS } from './config'
import { useGoodsTokenMeta } from './hooks'

const fadeUp = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.22 } }

export function ProofPage() {
  const { events, scanState, progress, progressText, error, stats, scan, stop } = useEventLog()
  const [dealsShown, setDealsShown] = useState(5)
  const [eventsShown, setEventsShown] = useState(20)
  const dealsNewestFirst = Array.from(stats.deals.values()).sort((a, b) => Number(b.dealId) - Number(a.dealId))

  // Auto-start scan when the page mounts
  useEffect(() => {
    void scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pct = progress.total > 0n
    ? Math.min(100, Math.round(Number((progress.scanned * 100n) / progress.total)))
    : 0

  const scanning = scanState === 'scanning'

  return (
    <div className="w-full px-4 pb-12 space-y-6">
      <motion.div {...fadeUp} className="pt-6">
        <h1 className="display text-2xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>
          Every deal, accounted for
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Every payment, refund and payout, read live from {ARC_NETWORK.name}. For each closed deal, the money paid in equals what the seller received plus what buyers got back, to the last cent.
        </p>
      </motion.div>

      {/* ── Scan controls ───────────────────────────────────────────────── */}
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
            : <><Play className="size-3.5" /> Refresh</>}
        </button>

        {scanning && (
          <div className="flex-1 space-y-1">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
              <motion.div
                className="h-full rounded-full"
                style={{ background: 'var(--accent)' }}
                animate={{ width: progressText ? '5%' : `${pct}%` }}
                transition={{ duration: 0.4 }}
              />
            </div>
            <p className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
              {progressText
                ? progressText
                : `${pct}% · ${events.length} events · ${progress.head.toString()} head`}
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

      {/* ── Stats summary ───────────────────────────────────────────────── */}
      {scanState !== 'idle' && (
        <motion.div {...fadeUp} transition={{ delay: 0.06 }}
          className="grid grid-cols-2 gap-3"
        >
          {[
            { label: 'USDC paid in (net)',  value: formatUsdcPrice(stats.totalCommits) },
            { label: 'USDC refunded',       value: formatUsdcPrice(stats.totalRefunds) },
            { label: 'Excess credited',     value: formatUsdcPrice(stats.totalExcess) },
            { label: 'USDC claimed',        value: formatUsdcPrice(stats.totalClaimed) },
            { label: 'Units sold (settled)',value: stats.totalUnitsSold.toString() },
            { label: 'Distinct buyers',     value: stats.distinctBuyers.size.toString() },
            { label: 'Tier breaks',         value: stats.tierBreaks.toString() },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{label}</p>
              <p className="display text-xl font-bold tabular-nums mt-0.5" style={{ color: 'var(--ink)' }}>{value}</p>
            </div>
          ))}
          {/* Items collected — one tile, formatted per token */}
          {stats.goodsClaimedByToken.size > 0 && (
            <div className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>Items collected</p>
              <GoodsClaimedStat map={stats.goodsClaimedByToken} />
            </div>
          )}
        </motion.div>
      )}

      {/* ── Per-deal conservation table ─────────────────────────────────── */}
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
            {dealsNewestFirst.slice(0, dealsShown).map(deal => (
              <div key={deal.dealId} className="px-4 py-3 space-y-2">
                {/* Deal header */}
                <div className="flex items-center justify-between">
                  <span className="mono text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                    Deal #{deal.dealId}
                  </span>
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full"
                    style={{
                      background: deal.settled  ? 'rgba(26,128,71,0.1)'
                                : deal.refunded ? 'rgba(107,101,128,0.1)'
                                : 'var(--surface-muted)',
                      color: deal.settled  ? 'var(--success)'
                           : deal.refunded ? 'var(--muted)'
                           : 'var(--subtle)',
                    }}
                  >
                    {deal.settled ? 'Settled' : deal.refunded ? 'Refunded' : 'Open'}
                  </span>
                </div>

                {/* USDC conservation */}
                <div>
                  <p className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>USDC</p>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4" style={{ color: 'var(--muted)' }}>
                    <div>
                      <p>Paid in</p>
                      <p className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{formatUsdcPrice(deal.commitsIn)}</p>
                    </div>
                    {deal.excessIn > 0n && (
                      <div>
                        <p>Excess credited</p>
                        <p className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{formatUsdcPrice(deal.excessIn)}</p>
                      </div>
                    )}
                    <div>
                      <p>Seller</p>
                      <p className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{formatUsdcPrice(deal.supplierCredited)}</p>
                    </div>
                    <div>
                      <p>Refunds</p>
                      <p className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{formatUsdcPrice(deal.refundsOut)}</p>
                    </div>
                  </div>
                  {(deal.settled || deal.refunded) && deal.usdcConserved !== null && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      {deal.usdcConserved
                        ? <CheckCircle className="size-3.5" style={{ color: 'var(--success)' }} />
                        : <XCircle className="size-3.5" style={{ color: 'var(--danger)' }} />}
                      <span className="text-xs" style={{ color: deal.usdcConserved ? 'var(--success)' : 'var(--danger)' }}>
                        {deal.usdcConserved ? 'USDC conservation verified' : 'USDC conservation FAILED — investigate'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Goods conservation */}
                {deal.goodsNote && (
                  <div className="rounded-lg px-3 py-2" style={{ background: 'var(--surface-muted)' }}>
                    <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--muted)' }}>Goods</p>
                    <p className="text-xs" style={{ color: 'var(--ink-2)' }}>{deal.goodsNote}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
          {dealsNewestFirst.length > dealsShown && (
            <button onClick={() => setDealsShown((n) => n + 10)}
              className="w-full py-3 text-sm font-medium transition-all hover:opacity-70"
              style={{ color: 'var(--accent-hover)', borderTop: '1px solid var(--border)' }}>
              Show older deals ({dealsNewestFirst.length - dealsShown} more)
            </button>
          )}
        </motion.div>
      )}

      {/* ── Event log ───────────────────────────────────────────────────── */}
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
            {events.slice().reverse().slice(0, eventsShown).map((ev, i) => (
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
          {events.length > eventsShown && (
            <button onClick={() => setEventsShown((n) => n + 50)}
              className="w-full py-3 text-sm font-medium transition-all hover:opacity-70"
              style={{ color: 'var(--accent-hover)', borderTop: '1px solid var(--border)' }}>
              Show older events ({events.length - eventsShown} more)
            </button>
          )}
        </motion.div>
      )}
    </div>
  )
}

// ── GoodsClaimedStat — formatted per-token totals ─────────────────────────────
//
// Resolves each token's symbol/decimals (listed tokens from GOODS_TOKENS;
// unlisted via on-chain reads) and renders "2 EURC · 875 FAZE" style text.

function GoodsClaimedStat({ map }: { map: Map<string, bigint> }) {
  const entries = Array.from(map.entries())   // [tokenAddr, amount]
  return (
    <p className="display text-xl font-bold tabular-nums mt-0.5 leading-snug" style={{ color: 'var(--ink)' }}>
      {entries.map(([addr, amt], i) => (
        <GoodsClaimedToken key={addr} addr={addr} amount={amt} sep={i < entries.length - 1} />
      ))}
    </p>
  )
}

function GoodsClaimedToken({ addr, amount, sep }: { addr: string; amount: bigint; sep: boolean }) {
  const listed  = GOODS_TOKENS.find(t => t.address.toLowerCase() === addr.toLowerCase())
  const onChain = useGoodsTokenMeta(listed ? undefined : addr as `0x${string}`)
  const sym = listed?.symbol ?? onChain?.symbol
  const dec = listed?.decimals ?? onChain?.decimals
  const text = sym !== undefined && dec !== undefined
    ? `${formatTokenAmount(amount, dec)} ${sym}`
    : `${amount.toString()} (${addr.slice(0, 8)}…)`
  return <>{text}{sep && <span style={{ color: 'var(--subtle)' }}> · </span>}</>
}

// ── Event badge ───────────────────────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  DealPosted:     'var(--ink)',
  Committed:      '#1a8047',
  Withdrawn:      '#6b6580',
  TierBroken:     '#1061a6',
  Settled:        '#1a8047',
  Refunded:       '#ba2b4c',
  Claimed:        '#1a8047',
  GoodsClaimed:   '#1a8047',
  ExcessCredited: '#b45309',
}

function EventBadge({ type }: { type: string }) {
  return (
    <span
      className="shrink-0 mt-0.5 inline-block rounded-md px-1.5 py-0.5 text-xs font-semibold"
      style={{ background: `${EVENT_COLORS[type] ?? '#666'}18`, color: EVENT_COLORS[type] ?? 'var(--muted)' }}
    >
      {type}
    </span>
  )
}

// ── Event summary ─────────────────────────────────────────────────────────────

function EventSummary({ ev }: { ev: import('./useEventLog').SwarmEvent }) {
  const a = ev.args
  switch (ev.type) {
    case 'DealPosted':
      return (
        <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
          Deal #{String(a.dealId)} · start {formatUsdcPrice(BigInt(String(a.startPrice)))} · {String(a.minUnits)} min units · {String(a.maxUnits)} max
        </p>
      )
    case 'Committed':
      // v2: units, paidPerUnit, escrow
      return (
        <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
          Deal #{String(a.dealId)} · {shortAddr(String(a.buyer))} · {String(a.units)} unit{Number(a.units) !== 1 ? 's' : ''} @ {formatUsdcPrice(BigInt(String(a.paidPerUnit)))}/unit · {formatUsdcPrice(BigInt(String(a.escrow)))} escrowed
        </p>
      )
    case 'Withdrawn':
      return (
        <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
          Deal #{String(a.dealId)} · {shortAddr(String(a.buyer))} withdrew {formatUsdcPrice(BigInt(String(a.amountReturned)))} · {String(a.buyerCount)} buyers remain
        </p>
      )
    case 'TierBroken':
      return (
        <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
          Deal #{String(a.dealId)} · price → {formatUsdcPrice(BigInt(String(a.newPrice)))} at {String(a.newTotalUnits)} units
        </p>
      )
    case 'Settled':
      // v2: totalUnits, buyerCount, totalRefunds, unitsDelivered
      return (
        <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
          Deal #{String(a.dealId)} · cleared at {formatUsdcPrice(BigInt(String(a.clearingPrice)))} · {String(a.totalUnits)} units · {String(a.buyerCount)} buyers · {String(a.unitsDelivered)} delivered
        </p>
      )
    case 'Refunded':
      return (
        <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
          Deal #{String(a.dealId)} · {shortAddr(String(a.buyer))} refunded {formatUsdcPrice(BigInt(String(a.amount)))}
        </p>
      )
    case 'ExcessCredited':
      return (
        <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
          Deal #{String(a.dealId)} · {shortAddr(String(a.buyer))} excess {formatUsdcPrice(BigInt(String(a.amount)))} credited
        </p>
      )
    case 'Claimed':
      return (
        <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
          {shortAddr(String(a.claimant))} claimed {formatUsdcPrice(BigInt(String(a.amount)))} USDC
        </p>
      )
    case 'GoodsClaimed':
      return (
        <GoodsClaimedSummary
          claimant={String(a.claimant)}
          amount={BigInt(String(a.amount))}
          token={(a.token as string | undefined) ?? ''}
        />
      )
    default:
      return <p className="text-xs" style={{ color: 'var(--muted)' }}>Unknown event</p>
  }
}

// ── GoodsClaimed summary — resolves unlisted token metadata on-chain ──────────

function GoodsClaimedSummary({ claimant, amount, token }: { claimant: string; amount: bigint; token: string }) {
  const listed = GOODS_TOKENS.find(t => t.address.toLowerCase() === token.toLowerCase())
  const onChain = useGoodsTokenMeta(listed ? undefined : token as `0x${string}`)
  const sym = listed?.symbol ?? onChain?.symbol
  const dec = listed?.decimals ?? onChain?.decimals
  const amtStr = sym !== undefined && dec !== undefined
    ? `${formatTokenAmount(amount, dec)} ${sym}`
    : `${amount.toString()} (unlisted token)`
  return (
    <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
      {shortAddr(claimant)} claimed {amtStr}
    </p>
  )
}
