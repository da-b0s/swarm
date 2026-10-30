import { useState, useEffect } from 'react'
import { useWriteContract, useWaitForTransactionReceipt, useAccount } from 'wagmi'
import { motion } from 'framer-motion'
import { ExternalLink, Share2, Copy, Check, Package } from 'lucide-react'
import { PriceHero } from './PriceHero'
import { TierProgress } from './TierProgress'
import { CommitFlow } from './CommitFlow'
import {
  useLiveDealState, useBlockCountdown, useClaimable, useGoodsClaimable,
  useGoodsTokenMeta, useChainNow,
} from './hooks'
import { useDealHistory } from './useDealHistory'
import { SETTLER_ABI } from './abis'
import { formatUsdcPrice, formatCountdown, shortAddr, txUrl, formatTokenAmount } from './utils'
import { ARC_NETWORK, CONTRACTS_ACTIVE, ARC_TX_FEES, GOODS_TOKENS } from './config'
import { PricePerToken } from './PricePerToken'
import { useMarketRates } from './useMarketRates'

interface Props { dealId: bigint }

const fadeUp = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24, ease: [0.25, 0.1, 0.25, 1.0] as number[] },
}

function addrHue(addr: string): number {
  return parseInt(addr.slice(2, 6), 16) % 360
}

export function DealRoom({ dealId }: Props) {
  const {
    deal, dealLoading, buyerCount, totalUnits, clearingPrice,
    nextTier, tierProgress, refetchAll,
  } = useLiveDealState(dealId)

  const secondsLeft  = useBlockCountdown(deal?.deadline)
  const history      = useDealHistory(deal ? dealId : undefined)
  const tokenMeta    = useGoodsTokenMeta(deal?.goodsToken)
  const marketRates  = useMarketRates()
  const tokenConfig  = deal ? GOODS_TOKENS.find(t => t.address.toLowerCase() === deal.goodsToken.toLowerCase()) : undefined
  const marketRate   = tokenConfig?.marketSymbol ? marketRates?.get(tokenConfig.marketSymbol) : undefined
  const isVerifiedToken = !!tokenConfig
  const [copied, setCopied] = useState(false)

  const handleShare = () => {
    const url = `${window.location.origin}?deal=${dealId.toString()}`
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => { /* ignore */ })
  }

  // Share line counts units, not buyers
  const shareLabel = (() => {
    if (!deal || !nextTier) return null
    const needed = nextTier.unitsNeeded
    const nextPrice = nextTier.tier.pricePerUnit
    return `${needed} more unit${needed === 1 ? '' : 's'} and everyone pays ${formatUsdcPrice(nextPrice)}`
  })()

  if (dealLoading || !deal) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="size-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} />
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading deal…</p>
      </div>
    )
  }

  const count       = buyerCount  ?? 0
  const unitCount   = totalUnits  ?? 0
  const symbol      = tokenMeta?.symbol ?? '…'
  const recentHistory = history.slice(0, 12)

  // ── Two-column layout from lg, single column below ───────────────────────
  const leftCol = (
    <div className="space-y-5">
      {/* Title + goods info */}
      <motion.div className="space-y-1" {...fadeUp}>
        <h1 className="text-2xl font-bold leading-tight" style={{ color: 'var(--ink)' }}>
          {deal.title}
        </h1>
        {deal.description && (
          <p className="text-sm" style={{ color: 'var(--ink-2)' }}>{deal.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
          <div className="flex items-center gap-1.5">
            <Package className="size-3.5 shrink-0" style={{ color: 'var(--muted)' }} />
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {tokenMeta?.decimals !== undefined
                ? `1 unit = ${formatTokenAmount(deal.tokensPerUnit, tokenMeta.decimals)} ${symbol}`
                : symbol !== '…' ? `1 unit = ? ${symbol}` : null}
            </span>
          </div>
          {!isVerifiedToken && symbol !== '…' && (
            <span className="text-xs px-1.5 py-0.5 rounded-md"
              style={{ background: 'rgba(255,160,0,0.12)', color: 'var(--warn, #b45309)' }}>
              Unverified token
            </span>
          )}
        </div>
      </motion.div>

      {/* Hero price */}
      <motion.div
        className="rounded-3xl p-6 flex flex-col items-center"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        {...fadeUp}
      >
        <PriceHero price={clearingPrice} loading={dealLoading} />
        {tokenMeta && (
          <div className="mt-1 text-sm text-center">
            <PricePerToken
              pricePerUnit={clearingPrice} tokensPerUnit={deal.tokensPerUnit}
              tokenDecimals={tokenMeta.decimals} tokenSymbol={symbol}
              marketRate={marketRate} className="text-sm font-medium"
            />
          </div>
        )}
        <div className="mt-5 w-full">
          <TierProgress
            buyerCount={unitCount} tiers={deal.tiers}
            minBuyers={deal.minUnits} progress={tierProgress}
            nextTier={nextTier ? { tier: nextTier.tier, buyersNeeded: nextTier.unitsNeeded } : undefined}
          />
        </div>
      </motion.div>

      {/* Stats row */}
      <motion.div className="grid grid-cols-2 gap-3" {...fadeUp}
        transition={{ ...fadeUp.transition, delay: 0.05 }}>
        <div className="rounded-2xl p-4 flex flex-col gap-1"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Units sold</span>
          <span className="display text-2xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
            {unitCount}
            <span className="text-base font-normal" style={{ color: 'var(--subtle)' }}> / {deal.maxUnits}</span>
          </span>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>
            {count} buyer{count !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="rounded-2xl p-4 flex flex-col gap-1"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Time left</span>
          <span className="display text-2xl font-bold tabular-nums"
            style={{ color: secondsLeft !== undefined && secondsLeft < 3600 ? 'var(--danger)' : 'var(--ink)' }}>
            {secondsLeft === undefined ? '—' : formatCountdown(secondsLeft)}
          </span>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>
            minimum {deal.minUnits} {deal.minUnits === 1 ? 'unit' : 'units'}
          </span>
        </div>
      </motion.div>

      {/* Activity list */}
      {recentHistory.length > 0 && (
        <motion.div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}
          {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.12 }}>
          <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>
              Activity
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {recentHistory.map((entry) => {
              const hue = addrHue(entry.buyer)
              return (
                <a key={entry.txHash + String(entry.logIndex)} href={txUrl(entry.txHash)}
                  target="_blank" rel="noreferrer"
                  className="flex items-center gap-3 px-4 py-3 hover:bg-black/[0.02] transition-colors">
                  <div className="size-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                    style={{
                      background: entry.withdrawn ? 'var(--surface-muted)' : `hsl(${hue}deg 60% 88%)`,
                      color:      entry.withdrawn ? 'var(--muted)'          : `hsl(${hue}deg 60% 32%)`,
                    }}>
                    {entry.buyer.slice(2, 4).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="mono text-sm block truncate"
                      style={{ color: entry.withdrawn ? 'var(--muted)' : 'var(--ink-2)' }}>
                      {shortAddr(entry.buyer)}
                    </span>
                    {entry.withdrawn ? (
                      <span className="text-xs" style={{ color: 'var(--subtle)' }}>left</span>
                    ) : (
                      <div className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
                        <span>{entry.units} unit{entry.units !== 1 ? 's' : ''} @ {formatUsdcPrice(entry.paidPerUnit)}/unit</span>
                        <div><PricePerToken pricePerUnit={entry.paidPerUnit} tokensPerUnit={deal.tokensPerUnit}
                          tokenDecimals={tokenMeta?.decimals} tokenSymbol={symbol} marketRate={marketRate} className="text-xs" /></div>
                      </div>
                    )}
                  </div>
                  <ExternalLink className="size-3.5 shrink-0" style={{ color: 'var(--subtle)' }} />
                </a>
              )
            })}
          </div>
        </motion.div>
      )}
    </div>
  )

  const rightCol = (
    <div className="space-y-4">
      {/* Commit / Withdraw */}
      <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.08 }}>
        <CommitFlow
          dealId={dealId} clearingPrice={clearingPrice} totalUnits={unitCount}
          buyerCount={count} tiers={deal.tiers} maxUnits={deal.maxUnits}
          maxUnitsPerBuyer={deal.maxUnitsPerBuyer} deadline={deal.deadline}
          state={deal.state} goodsToken={deal.goodsToken}
          goodsSymbol={symbol} goodsDecimals={tokenMeta?.decimals}
          tokensPerUnit={deal.tokensPerUnit} onCommitted={refetchAll}
        />
      </motion.div>

      {/* Share */}
      {shareLabel && deal.state === 0 && (
        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <button onClick={handleShare}
            className="w-full rounded-2xl px-4 py-3 flex items-center gap-3 text-left transition-all hover:scale-[1.01] active:scale-[0.99]"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
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

      {/* Settle / Refund */}
      {deal.state === 0 && secondsLeft !== undefined && secondsLeft === 0 && (
        <SettleOrRefundPanel dealId={dealId} totalUnits={unitCount} minUnits={deal.minUnits}
          goodsToken={deal.goodsToken} goodsSymbol={symbol} goodsDecimals={tokenMeta?.decimals}
          onDone={refetchAll} />
      )}

      {/* Settled / refunded — claim */}
      {(deal.state === 1 || deal.state === 2) && (
        <ClaimPanel goodsToken={deal.goodsToken} goodsSymbol={symbol}
          goodsDecimals={tokenMeta?.decimals} onDone={refetchAll} />
      )}
    </div>
  )

  return (
    <div className="px-4 pt-5 pb-10">
      {/* Two-column from lg */}
      <div className="lg:grid lg:grid-cols-[1fr_380px] lg:gap-8 lg:items-start">
        {leftCol}
        <div className="mt-5 lg:mt-0 lg:sticky lg:top-20">
          {rightCol}
        </div>
      </div>
    </div>
  )
}

// ── Settle/Refund panel ───────────────────────────────────────────────────────

interface SettleProps {
  dealId: bigint
  totalUnits: number
  minUnits: number
  goodsToken: `0x${string}`
  goodsSymbol: string
  goodsDecimals?: number
  onDone: () => void
}

function SettleOrRefundPanel({ dealId, totalUnits, minUnits, goodsToken, goodsSymbol, goodsDecimals, onDone }: SettleProps) {
  const { address } = useAccount()
  const { data: claimable,      refetch: refetchClaimable }      = useClaimable(address)
  const { data: goodsClaimable, refetch: refetchGoodsClaimable } = useGoodsClaimable(goodsToken, address)
  const { writeContract } = useWriteContract()
  const [hash, setHash]   = useState<`0x${string}` | undefined>()
  const [busy, setBusy]   = useState(false)
  const { isSuccess } = useWaitForTransactionReceipt({ hash, chainId: ARC_NETWORK.chainId })

  useEffect(() => {
    if (!isSuccess) return
    onDone()
    void refetchClaimable()
    void refetchGoodsClaimable()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess])

  const canSettle  = totalUnits >= minUnits
  const claimableN = claimable      !== undefined ? BigInt(claimable)      : 0n
  const goodsN     = goodsClaimable !== undefined ? BigInt(goodsClaimable) : 0n

  const send = (fn: 'settle' | 'refundAll' | 'claim' | 'claimGoods') => {
    setBusy(true)
    const onSuccess = (h: `0x${string}`) => { setHash(h); setBusy(false) }
    const onError   = () => setBusy(false)
    const chainId   = ARC_NETWORK.chainId
    if (fn === 'settle') {
      writeContract({ address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'settle',    args: [dealId], ...ARC_TX_FEES, chainId }, { onSuccess, onError })
    } else if (fn === 'refundAll') {
      writeContract({ address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'refundAll', args: [dealId], ...ARC_TX_FEES, chainId }, { onSuccess, onError })
    } else if (fn === 'claim') {
      writeContract({ address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'claim',     args: [],       ...ARC_TX_FEES, chainId }, { onSuccess, onError })
    } else {
      writeContract({ address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'claimGoods', args: [goodsToken], ...ARC_TX_FEES, chainId }, { onSuccess, onError })
    }
  }

  return (
    <motion.div
      className="rounded-2xl p-4 space-y-3"
      style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
        {canSettle ? 'This deal closed successfully' : 'This deal closed below its minimum'}
      </p>
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        {canSettle
          ? 'It is being finalised automatically, usually within a minute. You can then collect your items or payment here.'
          : 'Everyone is being refunded automatically, usually within a minute. Your USDC will then be ready to collect here.'}
      </p>
      <button onClick={() => send(canSettle ? 'settle' : 'refundAll')} disabled={busy}
        className="text-xs underline underline-offset-2 disabled:opacity-40" style={{ color: 'var(--muted)' }}>
        Taking too long? Finalise it yourself
      </button>

      {claimableN > 0n && (
        <button onClick={() => send('claim')} disabled={busy}
          className="w-full rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-40"
          style={{ background: 'rgba(26,128,71,0.1)', color: 'var(--success)', border: '1px solid rgba(26,128,71,0.2)' }}>
          Claim {formatUsdcPrice(claimableN)} USDC
        </button>
      )}

      {goodsN > 0n && (
        <button onClick={() => send('claimGoods')} disabled={busy}
          className="w-full rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-40"
          style={{ background: 'rgba(26,128,71,0.1)', color: 'var(--success)', border: '1px solid rgba(26,128,71,0.2)' }}>
          Claim {goodsDecimals !== undefined ? formatTokenAmount(goodsN, goodsDecimals) : goodsN.toString()} {goodsSymbol}
        </button>
      )}

      {hash && (
        <a href={txUrl(hash)} target="_blank" rel="noreferrer"
          className="flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
          View transaction <ExternalLink className="size-3" />
        </a>
      )}
    </motion.div>
  )
}

// ── Claim panel (settled/refunded state) ──────────────────────────────────────

interface ClaimPanelProps {
  goodsToken:   `0x${string}`
  goodsSymbol:  string
  goodsDecimals?: number
  onDone:       () => void
}

function ClaimPanel({ goodsToken, goodsSymbol, goodsDecimals, onDone }: ClaimPanelProps) {
  const { address }  = useAccount()
  const { data: claimable,      refetch: refetchClaimable }      = useClaimable(address)
  const { data: goodsClaimable, refetch: refetchGoodsClaimable } = useGoodsClaimable(goodsToken, address)
  const { writeContract } = useWriteContract()
  const [hash, setHash]   = useState<`0x${string}` | undefined>()
  const [busy, setBusy]   = useState(false)
  const { isSuccess } = useWaitForTransactionReceipt({ hash, chainId: ARC_NETWORK.chainId })

  useEffect(() => {
    if (!isSuccess) return
    onDone()
    void refetchClaimable()
    void refetchGoodsClaimable()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess])

  const claimableN = claimable      !== undefined ? BigInt(claimable)      : 0n
  const goodsN     = goodsClaimable !== undefined ? BigInt(goodsClaimable) : 0n

  if (claimableN === 0n && goodsN === 0n) return null

  const send = (fn: 'claim' | 'claimGoods') => {
    setBusy(true)
    const onSuccess = (h: `0x${string}`) => { setHash(h); setBusy(false) }
    const onError   = () => setBusy(false)
    if (fn === 'claim') {
      writeContract({ address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'claim', args: [], ...ARC_TX_FEES, chainId: ARC_NETWORK.chainId }, { onSuccess, onError })
    } else {
      writeContract({ address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'claimGoods', args: [goodsToken], ...ARC_TX_FEES, chainId: ARC_NETWORK.chainId }, { onSuccess, onError })
    }
  }

  return (
    <motion.div
      className="rounded-2xl p-4 space-y-3"
      style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Your claims</p>

      {claimableN > 0n && (
        <button onClick={() => send('claim')} disabled={busy}
          className="w-full rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-40"
          style={{ background: 'rgba(26,128,71,0.1)', color: 'var(--success)', border: '1px solid rgba(26,128,71,0.2)' }}>
          Claim {formatUsdcPrice(claimableN)} USDC
        </button>
      )}

      {goodsN > 0n && (
        <button onClick={() => send('claimGoods')} disabled={busy}
          className="w-full rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-40"
          style={{ background: 'rgba(26,128,71,0.1)', color: 'var(--success)', border: '1px solid rgba(26,128,71,0.2)' }}>
          Claim {goodsDecimals !== undefined ? formatTokenAmount(goodsN, goodsDecimals) : goodsN.toString()} {goodsSymbol}
        </button>
      )}

      {hash && (
        <a href={txUrl(hash)} target="_blank" rel="noreferrer"
          className="flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
          View transaction <ExternalLink className="size-3" />
        </a>
      )}
    </motion.div>
  )
}

// Re-export useChainNow so existing imports from DealRoom still work
export { useChainNow }
