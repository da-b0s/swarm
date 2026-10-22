import { useState, useEffect } from 'react'
import { useWriteContract, useWaitForTransactionReceipt, useAccount } from 'wagmi'
import { motion } from 'framer-motion'
import { ExternalLink, Users, Clock, Share2, Copy, Check } from 'lucide-react'
import { PriceHero } from './PriceHero'
import { TierProgress } from './TierProgress'
import { CommitFlow } from './CommitFlow'
import { useLiveDealState, useBlockCountdown, useClaimable } from './hooks'
import { useDealHistory } from './useDealHistory'
import { SETTLER_ABI } from './abis'
import { formatUsdcPrice, formatCountdown, shortAddr, txUrl } from './utils'
import { ARC_NETWORK, CONTRACTS_ACTIVE } from './config'

interface Props {
  dealId: bigint
}

const fadeUp = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.24, ease: [0.25, 0.1, 0.25, 1.0] as number[] } }

/** Hash a 4-char hex prefix to a hue 0–359 */
function addrHue(addr: string): number {
  const hex = addr.slice(2, 6)
  return parseInt(hex, 16) % 360
}

export function DealRoom({ dealId }: Props) {
  const { deal, dealLoading, buyerCount, clearingPrice, nextTier, tierProgress, refetchAll } = useLiveDealState(dealId)
  const secondsLeft = useBlockCountdown(deal?.deadline)
  const history = useDealHistory(deal ? dealId : undefined)
  const [copied, setCopied] = useState(false)

  const handleShare = () => {
    const url = `${window.location.origin}?deal=${dealId.toString()}`
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => { /* ignore */ })
  }

  const shareLabel = (() => {
    if (!deal || !nextTier) return null
    const needed = nextTier.buyersNeeded
    const nextPrice = nextTier.tier.pricePerUnit
    return `Bring ${needed} friend${needed === 1 ? '' : 's'} and your price drops to ${formatUsdcPrice(nextPrice)}`
  })()

  if (dealLoading || !deal) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="size-8 rounded-full border-2 animate-spin" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} />
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading deal…</p>
      </div>
    )
  }

  const recentHistory = history.slice(0, 12)
  const count = buyerCount ?? 0

  return (
    <div className="w-full max-w-md mx-auto px-4 pb-8 space-y-5">
      {/* Hero price */}
      <motion.div
        className="rounded-3xl p-6 flex flex-col items-center"
        style={{ background: 'var(--surface)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)', border: '1px solid var(--border)' }}
        {...fadeUp}
      >
        <PriceHero price={clearingPrice} loading={dealLoading} />
        <div className="mt-5 w-full">
          <TierProgress
            buyerCount={count}
            tiers={deal.tiers}
            minBuyers={deal.minBuyers}
            progress={tierProgress}
            nextTier={nextTier}
          />
        </div>
      </motion.div>

      {/* Stats row */}
      <motion.div
        className="grid grid-cols-2 gap-3"
        {...fadeUp}
        transition={{ ...fadeUp.transition, delay: 0.05 }}
      >
        <div className="rounded-2xl p-4 flex flex-col gap-1" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-1.5">
            <Users className="size-3.5" style={{ color: 'var(--muted)' }} />
            <span className="text-xs" style={{ color: 'var(--muted)' }}>Buyers</span>
          </div>
          <span className="display text-2xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{count}</span>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>cap {deal.cap}</span>
        </div>

        <div className="rounded-2xl p-4 flex flex-col gap-1" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-1.5">
            <Clock className="size-3.5" style={{ color: 'var(--muted)' }} />
            <span className="text-xs" style={{ color: 'var(--muted)' }}>Time left</span>
          </div>
          <span className="display text-2xl font-bold tabular-nums" style={{ color: secondsLeft !== undefined && secondsLeft < 3600 ? 'var(--danger)' : 'var(--ink)' }}>
            {secondsLeft === undefined ? '—' : formatCountdown(secondsLeft)}
          </span>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>min {deal.minBuyers} buyers</span>
        </div>
      </motion.div>

      {/* Commit / Withdraw */}
      <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.08 }}>
        <CommitFlow
          dealId={dealId}
          clearingPrice={clearingPrice}
          buyerCount={count}
          tiers={deal.tiers}
          deadline={deal.deadline}
          state={deal.state}
          onCommitted={refetchAll}
        />
      </motion.div>

      {/* Share */}
      {shareLabel && deal.state === 0 && (
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <button
            onClick={handleShare}
            className="w-full rounded-2xl px-4 py-3 flex items-center gap-3 text-left transition-all hover:scale-[1.01] active:scale-[0.99]"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
          >
            {copied
              ? <Check className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
              : <Share2 className="size-4 shrink-0" style={{ color: 'var(--muted)' }} />}
            <span className="text-sm flex-1" style={{ color: 'var(--ink-2)' }}>
              {copied ? 'Link copied!' : shareLabel}
            </span>
            {!copied && <Copy className="size-3.5 shrink-0" style={{ color: 'var(--subtle)' }} />}
          </button>
        </motion.div>
      )}

      {/* Recent commits — built from events, newest first */}
      {recentHistory.length > 0 && (
        <motion.div
          className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid var(--border)' }}
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.12 }}
        >
          <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>
              Activity
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {recentHistory.map((entry) => {
              const hue = addrHue(entry.buyer)
              return (
                <a
                  key={entry.txHash + entry.logIndex}
                  href={txUrl(entry.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 px-4 py-3 hover:bg-black/[0.02] transition-colors"
                >
                  <div
                    className="size-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                    style={{
                      background: entry.withdrawn ? 'var(--surface-muted)' : `hsl(${hue}deg 60% 88%)`,
                      color:      entry.withdrawn ? 'var(--muted)'          : `hsl(${hue}deg 60% 32%)`,
                    }}
                  >
                    {entry.buyer.slice(2, 4).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="mono text-sm block truncate" style={{ color: entry.withdrawn ? 'var(--muted)' : 'var(--ink-2)' }}>
                      {shortAddr(entry.buyer)}
                    </span>
                    {entry.withdrawn ? (
                      <span className="text-xs" style={{ color: 'var(--subtle)' }}>left</span>
                    ) : (
                      <span className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
                        {formatUsdcPrice(entry.pricePaid)}
                      </span>
                    )}
                  </div>
                  <ExternalLink className="size-3.5 shrink-0" style={{ color: 'var(--subtle)' }} />
                </a>
              )
            })}
          </div>
        </motion.div>
      )}

      {/* Settle / Refund / Claim — shown after deadline */}
      {deal.state === 0 && secondsLeft !== undefined && secondsLeft === 0 && (
        <SettleOrRefundPanel dealId={dealId} count={count} minBuyers={deal.minBuyers} onDone={refetchAll} />
      )}
    </div>
  )
}

// ── Settle/Refund/Claim panel ─────────────────────────────────────────────────

interface SettleProps {
  dealId: bigint
  count: number
  minBuyers: number
  onDone: () => void
}

function SettleOrRefundPanel({ dealId, count, minBuyers, onDone }: SettleProps) {
  const { address } = useAccount()
  const { data: claimable, refetch: refetchClaimable } = useClaimable(address)
  const { writeContract } = useWriteContract()
  const [hash, setHash] = useState<`0x${string}` | undefined>()
  const [busy, setBusy] = useState(false)
  const { isSuccess } = useWaitForTransactionReceipt({ hash, chainId: ARC_NETWORK.chainId })

  useEffect(() => {
    if (!isSuccess) return
    onDone()
    void refetchClaimable()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess])

  const canSettle = count >= minBuyers

  const send = (fn: 'settle' | 'refundAll' | 'claim') => {
    setBusy(true)
    const onSuccess = (h: `0x${string}`) => { setHash(h); setBusy(false) }
    const onError = () => setBusy(false)
    if (fn === 'claim') {
      writeContract({ address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'claim', args: [], chainId: ARC_NETWORK.chainId }, { onSuccess, onError })
    } else if (fn === 'settle') {
      writeContract({ address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'settle', args: [dealId], chainId: ARC_NETWORK.chainId }, { onSuccess, onError })
    } else {
      writeContract({ address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'refundAll', args: [dealId], chainId: ARC_NETWORK.chainId }, { onSuccess, onError })
    }
  }

  return (
    <motion.div
      className="rounded-2xl p-4 space-y-3"
      style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Deadline reached</p>
      {canSettle ? (
        <button
          onClick={() => send('settle')}
          disabled={busy}
          className="w-full rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          Settle deal
        </button>
      ) : (
        <button
          onClick={() => send('refundAll')}
          disabled={busy}
          className="w-full rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-40"
          style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--border)' }}
        >
          Refund all
        </button>
      )}
      {claimable !== undefined && BigInt(claimable) > 0n && (
        <button
          onClick={() => send('claim')}
          disabled={busy}
          className="w-full rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-40"
          style={{ background: 'rgba(26,128,71,0.1)', color: 'var(--success)', border: '1px solid rgba(26,128,71,0.2)' }}
        >
          Claim {formatUsdcPrice(BigInt(claimable))} USDC
        </button>
      )}
      {hash && (
        <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
          View transaction <ExternalLink className="size-3" />
        </a>
      )}
    </motion.div>
  )
}
