import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { motion } from 'framer-motion'
import { Plus, Trash2, Loader2, ExternalLink, AlertCircle, TrendingDown } from 'lucide-react'
import { DEAL_FACTORY_ABI } from './abis'
import { CONTRACTS_ACTIVE, ARC_NETWORK, MAX_CAP } from './config'
import { useChainNow } from './hooks'
import { formatUsdcPrice, txUrl, parseRevertReason, computeClearingPrice } from './utils'

const CHAIN_ID = ARC_NETWORK.chainId

interface TierInput { minBuyers: string; pricePerUnit: string }

function defaultTiers(): TierInput[] {
  return [
    { minBuyers: '10', pricePerUnit: '2.00' },
    { minBuyers: '25', pricePerUnit: '1.50' },
    { minBuyers: '50', pricePerUnit: '1.00' },
  ]
}

function parsePriceToMicro(str: string): bigint | null {
  const n = parseFloat(str)
  if (isNaN(n) || n <= 0) return null
  return BigInt(Math.round(n * 1_000_000))
}

function validateTiers(tiers: TierInput[], minBuyers: number, cap: number): string | null {
  if (tiers.length === 0) return 'Add at least one tier.'
  let prevMin = 0, prevPrice = Infinity
  for (let i = 0; i < tiers.length; i++) {
    const mb = parseInt(tiers[i].minBuyers)
    const pr = parseFloat(tiers[i].pricePerUnit)
    if (!Number.isFinite(mb) || mb < 1) return `Tier ${i + 1}: minBuyers must be at least 1.`
    if (!Number.isFinite(pr) || pr <= 0) return `Tier ${i + 1}: price must be greater than zero.`
    if (pr > 5) return `Tier ${i + 1}: price exceeds the 5 USDC cap.`
    if (i > 0 && mb <= prevMin) return `Tier ${i + 1}: minBuyers must be strictly ascending.`
    if (i > 0 && pr >= prevPrice) return `Tier ${i + 1}: price must be strictly descending.`
    prevMin = mb; prevPrice = pr
  }
  const firstMin = parseInt(tiers[0].minBuyers)
  if (firstMin > minBuyers) return `First tier threshold (${firstMin}) exceeds minBuyers (${minBuyers}).`
  const lastMin = parseInt(tiers[tiers.length - 1].minBuyers)
  if (lastMin > cap) return `Last tier threshold (${lastMin}) exceeds cap (${cap}).`
  return null
}

export function SupplierView({ onDealPosted: _onDealPosted }: { onDealPosted: (id: bigint) => void }) {
  const { isConnected, chainId: walletChain } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain = isConnected && walletChain !== CHAIN_ID

  const [tiers, setTiers] = useState<TierInput[]>(defaultTiers)
  const [minBuyers, setMinBuyers] = useState('10')
  const [cap, setCap] = useState('100')
  const [durationHours, setDurationHours] = useState('72')
  const [validationErr, setValidationErr] = useState<string | null>(null)

  // Deadlines are compared against block.timestamp by the contract, so the
  // duration the supplier picks has to be measured from chain time. Taking it
  // from the browser clock would skew every deal's real length, and a clock far
  // enough behind would post a deadline already in the chain's past.
  const chainNow = useChainNow()

  const { writeContract } = useWriteContract()
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()
  const [busy, setBusy] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash, chainId: CHAIN_ID })

  const addTier = () => setTiers(t => [...t, { minBuyers: '', pricePerUnit: '' }])
  const removeTier = (i: number) => setTiers(t => t.filter((_, j) => j !== i))
  const updateTier = (i: number, field: keyof TierInput, val: string) =>
    setTiers(t => t.map((tier, j) => j === i ? { ...tier, [field]: val } : tier))

  // Parsed tiers for chart
  const parsedTiers = tiers.map(t => ({
    minBuyers: parseInt(t.minBuyers) || 0,
    pricePerUnit: parsePriceToMicro(t.pricePerUnit) ?? 0n,
  })).filter(t => t.minBuyers > 0 && t.pricePerUnit > 0n)

  // Chart: show curve at key buyer counts
  const chartPoints = (() => {
    if (parsedTiers.length === 0) return []
    const maxCount = Math.max(...parsedTiers.map(t => t.minBuyers), parseInt(cap) || 100)
    const pts = []
    for (const t of parsedTiers) pts.push({ x: t.minBuyers, y: Number(t.pricePerUnit) / 1_000_000 })
    pts.push({ x: maxCount, y: Number(parsedTiers[parsedTiers.length - 1].pricePerUnit) / 1_000_000 })
    return pts
  })()

  const minPrice = chartPoints.length ? Math.min(...chartPoints.map(p => p.y)) : 0
  const maxPrice = chartPoints.length ? Math.max(...chartPoints.map(p => p.y)) : 1
  const maxCount = chartPoints.length ? Math.max(...chartPoints.map(p => p.x)) : 100

  const toSvgX = (x: number) => (x / maxCount) * 260
  const toSvgY = (y: number) => 80 - ((y - minPrice) / (maxPrice - minPrice || 1)) * 70

  // Current clearing price at current simulated buyer count for supplier preview
  const capNum = parseInt(cap) || 100
  const currentClearingAtFull = parsedTiers.length ? computeClearingPrice(parsedTiers, capNum) : 0n
  const supplierRevAtFull = currentClearingAtFull * BigInt(capNum)

  const handlePost = () => {
    const capNum = parseInt(cap)
    const minNum = parseInt(minBuyers)
    const err = validateTiers(tiers, minNum, capNum)
    if (err) { setValidationErr(err); return }
    if (!Number.isFinite(capNum) || capNum < 1 || capNum > MAX_CAP) { setValidationErr(`Cap must be 1–${MAX_CAP}.`); return }
    if (!Number.isFinite(minNum) || minNum < 1 || minNum > capNum) { setValidationErr('minBuyers must be ≥ 1 and ≤ cap.'); return }
    const hours = parseFloat(durationHours)
    if (!Number.isFinite(hours) || hours <= 0) { setValidationErr('Duration must be positive.'); return }
    setValidationErr(null)
    setErrMsg('')

    if (chainNow === 0) { setValidationErr('Still reading chain time — try again in a moment.'); return }
    const deadline = BigInt(chainNow + Math.round(hours * 3600))
    const tierArgs = tiers.map(t => ({
      minBuyers: parseInt(t.minBuyers),
      pricePerUnit: parsePriceToMicro(t.pricePerUnit)!,
    }))

    setBusy(true)
    writeContract(
      {
        address: CONTRACTS_ACTIVE.DealFactory,
        abi: DEAL_FACTORY_ABI,
        functionName: 'postDeal',
        args: [tierArgs, minNum, deadline, capNum],
        chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setTxHash(hash); setBusy(false) },
        onError: (e) => { setErrMsg(parseRevertReason(e)); setBusy(false) },
      }
    )
  }

  return (
    <div className="w-full max-w-md mx-auto px-4 pb-8 space-y-5">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>
        <h2 className="display text-2xl font-bold mt-6 mb-1" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>Post a deal</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Build your tier curve. Buyers escrow the live price; everyone settles at one clearing price.</p>
      </motion.div>

      {/* Tier builder */}
      <div className="rounded-3xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)' }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>Tiers</span>
          <button
            onClick={addTier}
            className="flex items-center gap-1 text-xs font-semibold rounded-lg px-2.5 py-1 transition-all hover:scale-[1.02] active:scale-[0.98]"
            style={{ background: 'var(--surface-muted)', color: 'var(--accent)' }}
          >
            <Plus className="size-3" /> Add tier
          </button>
        </div>

        {/* Header */}
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 px-1">
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>Min buyers</span>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>Price (USDC)</span>
          <span className="w-7" />
        </div>

        <div className="space-y-2">
          {tiers.map((tier, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <input
                type="number" min="1" max={MAX_CAP}
                value={tier.minBuyers}
                onChange={e => updateTier(i, 'minBuyers', e.target.value)}
                placeholder="10"
                className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none transition-colors"
                style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
              />
              <input
                type="number" min="0.000001" max="5" step="0.01"
                value={tier.pricePerUnit}
                onChange={e => updateTier(i, 'pricePerUnit', e.target.value)}
                placeholder="1.00"
                className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none transition-colors"
                style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
              />
              <button
                onClick={() => removeTier(i)}
                disabled={tiers.length <= 1}
                className="size-7 flex items-center justify-center rounded-lg disabled:opacity-20 transition-opacity hover:opacity-60"
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>

        {/* Curve chart */}
        {chartPoints.length >= 2 && (
          <div className="mt-3 rounded-xl overflow-hidden" style={{ background: 'var(--surface-muted)' }}>
            <div className="px-3 pt-2 pb-1 flex items-center gap-1.5">
              <TrendingDown className="size-3.5" style={{ color: 'var(--muted)' }} />
              <span className="text-xs" style={{ color: 'var(--muted)' }}>Price curve</span>
            </div>
            <svg viewBox="0 0 280 96" className="w-full" style={{ height: 96 }}>
              {/* Grid lines */}
              {[0.25, 0.5, 0.75].map(t => (
                <line key={t} x1={10} x2={270} y1={8 + t * 72} y2={8 + t * 72}
                  stroke="var(--border)" strokeWidth={0.5} />
              ))}
              {/* Step path */}
              <path
                d={chartPoints.map((pt, i) => {
                  const x = 10 + toSvgX(pt.x)
                  const y = 8 + toSvgY(pt.y)
                  if (i === 0) return `M ${x} ${y}`
                  const prev = chartPoints[i - 1]
                  return `L ${x} ${8 + toSvgY(prev.y)} L ${x} ${y}`
                }).join(' ')}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
                strokeLinecap="round"
              />
              {/* Price labels */}
              {parsedTiers.map((t, i) => (
                <text
                  key={i}
                  x={10 + toSvgX(t.minBuyers)}
                  y={8 + toSvgY(Number(t.pricePerUnit) / 1_000_000) - 4}
                  fontSize={7}
                  fill="var(--muted)"
                  textAnchor="middle"
                  fontFamily="JetBrains Mono, monospace"
                >
                  ${(Number(t.pricePerUnit) / 1_000_000).toFixed(2)}
                </text>
              ))}
            </svg>
          </div>
        )}
      </div>

      {/* Deal parameters */}
      <div className="rounded-3xl p-5 space-y-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>Parameters</span>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Min buyers</span>
            <input
              type="number" min="1" max={MAX_CAP}
              value={minBuyers}
              onChange={e => setMinBuyers(e.target.value)}
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Buyer cap (max {MAX_CAP})</span>
            <input
              type="number" min="1" max={MAX_CAP}
              value={cap}
              onChange={e => setCap(e.target.value)}
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Duration (hours)</span>
            <input
              type="number" min="1"
              value={durationHours}
              onChange={e => setDurationHours(e.target.value)}
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
            />
          </label>
        </div>

        {/* Supplier preview */}
        {parsedTiers.length > 0 && (
          <div className="rounded-xl p-3 space-y-1" style={{ background: 'var(--surface-muted)' }}>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>At full cap ({cap} buyers)</p>
            <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
              Clearing price: <span className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{formatUsdcPrice(currentClearingAtFull)}</span>
            </p>
            <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
              You receive: <span className="font-semibold tabular-nums" style={{ color: 'var(--success)' }}>{formatUsdcPrice(supplierRevAtFull)}</span>
            </p>
          </div>
        )}
      </div>

      {/* Validation error */}
      {validationErr && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5" style={{ background: 'rgba(186,43,76,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <p className="text-sm" style={{ color: 'var(--danger)' }}>{validationErr}</p>
        </div>
      )}
      {errMsg && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5" style={{ background: 'rgba(186,43,76,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <p className="text-sm" style={{ color: 'var(--danger)' }}>{errMsg}</p>
        </div>
      )}

      {/* CTA */}
      {!isConnected ? (
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button onClick={show} className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white" style={{ background: 'var(--accent)' }}>
              Connect wallet to post
            </button>
          )}
        </ConnectKitButton.Custom>
      ) : wrongChain ? (
        <button onClick={() => switchChain({ chainId: CHAIN_ID })} className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white" style={{ background: 'var(--accent)' }}>
          Switch to {ARC_NETWORK.name}
        </button>
      ) : (
        <button
          onClick={handlePost}
          disabled={busy || confirming || isSuccess}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
          style={{ background: 'var(--accent)' }}
        >
          {busy ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirm in wallet…</span>
            : confirming ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirming…</span>
            : isSuccess ? 'Posted!'
            : 'Post deal'}
        </button>
      )}

      {/* Success */}
      {isSuccess && txHash && (
        <motion.div
          className="rounded-2xl p-3 flex items-center gap-2.5"
          style={{ background: 'rgba(26,128,71,0.08)' }}
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--success)' }}>Deal posted</span>
          <a href={txUrl(txHash)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs ml-auto" style={{ color: 'var(--muted)' }}>
            View <ExternalLink className="size-3" />
          </a>
        </motion.div>
      )}
    </div>
  )
}
