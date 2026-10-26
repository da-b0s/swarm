/**
 * SupplierView v2 — post a Swarm deal with an ERC-20 goods token.
 *
 * Two-step flow:
 *   1. Approve the factory to spend exactly (maxUnits × tokensPerUnit) of the
 *      goods token.
 *   2. Call postDeal(PostParams, Tier[]) — the factory pulls the stock in the
 *      same transaction.
 *
 * Token picker shows GOODS_TOKENS from config; today that is EURC only.
 * Free-text address entry has been removed — adding a token is one line in config.
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  useAccount, useWriteContract, useWaitForTransactionReceipt,
  useSwitchChain, useReadContract,
} from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { motion } from 'framer-motion'
import { Plus, Trash2, Loader2, ExternalLink, AlertCircle, TrendingDown, CheckCircle2 } from 'lucide-react'
import { DEAL_FACTORY_ABI, ERC20_ABI } from './abis'
import { CONTRACTS_ACTIVE, ARC_NETWORK, MAX_CAP, MAX_TIERS, MAX_PRICE_USDC, ARC_TX_FEES, GOODS_TOKENS } from './config'
import type { GoodsToken } from './config'
import { useChainNow } from './hooks'
import { formatUsdcPrice, txUrl, parseRevertReason, computePriceAt } from './utils'

const CHAIN_ID = ARC_NETWORK.chainId
const USDC     = ARC_NETWORK.usdc.address

// ── Types ─────────────────────────────────────────────────────────────────────

interface TierInput { minUnits: string; pricePerUnit: string }

type PostStep = 'idle' | 'approving' | 'approved' | 'posting' | 'done'

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default tiers suited to EURC: $1.20 → $1.17 → $1.15, 1 EURC per unit */
function defaultTiers(): TierInput[] {
  return [
    { minUnits: '1',  pricePerUnit: '1.20' },
    { minUnits: '25', pricePerUnit: '1.17' },
    { minUnits: '50', pricePerUnit: '1.15' },
  ]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePriceToMicro(str: string): bigint | null {
  const n = parseFloat(str)
  if (isNaN(n) || n <= 0) return null
  return BigInt(Math.round(n * 1_000_000))
}

function byteLengthOf(s: string): number {
  return new TextEncoder().encode(s).length
}

// ── Validation ────────────────────────────────────────────────────────────────

interface PostInputs {
  goodsToken:       `0x${string}`
  tokensPerUnit:    bigint
  tokenDecimals:    number
  tiers:            TierInput[]
  minUnits:         string
  maxUnits:         string
  maxUnitsPerBuyer: string
  maxBuyers:        string
  durationHours:    string
  title:            string
  description:      string
}

interface ValidatedInputs {
  goodsToken:       `0x${string}`
  tokensPerUnit:    bigint
  tierArgs:         { minUnits: number; pricePerUnit: bigint }[]
  minUnitsNum:      number
  maxUnitsNum:      number
  maxUnitsPerBuyerNum: number
  maxBuyersNum:     number
  deadline:         bigint
  title:            string
  description:      string
  stockAmount:      bigint
}

function validate(
  inp: PostInputs,
  chainNow: number,
): ValidatedInputs | string {
  if (!inp.goodsToken || inp.goodsToken === '0x0000000000000000000000000000000000000000')
    return 'Select a goods token.'
  if (inp.goodsToken.toLowerCase() === USDC.toLowerCase())
    return 'USDC cannot be the goods token.'

  const titleBytes = byteLengthOf(inp.title)
  if (titleBytes === 0) return 'Title is required.'
  if (titleBytes > 80) return `Title is ${titleBytes} bytes; maximum is 80.`
  const descBytes = byteLengthOf(inp.description)
  if (descBytes > 500) return `Description is ${descBytes} bytes; maximum is 500.`

  if (inp.tokensPerUnit <= 0n) return 'Tokens per unit must be at least 1.'

  const minNum = parseInt(inp.minUnits)
  const maxNum = parseInt(inp.maxUnits)
  const ppbNum = parseInt(inp.maxUnitsPerBuyer) || 0
  const mbNum  = parseInt(inp.maxBuyers)

  if (!Number.isFinite(maxNum) || maxNum < 1) return 'Max units (stock) must be at least 1.'
  if (!Number.isFinite(minNum) || minNum < 1) return 'Deal minimum must be at least 1 unit.'
  if (minNum > maxNum) return 'Deal minimum cannot exceed max units.'
  if (!Number.isFinite(mbNum) || mbNum < 1 || mbNum > MAX_CAP)
    return `Max buyers must be 1–${MAX_CAP}.`
  if (ppbNum > 0 && ppbNum > maxNum) return 'Per-buyer limit cannot exceed max units.'

  const hours = parseFloat(inp.durationHours)
  if (!Number.isFinite(hours) || hours <= 0) return 'Duration must be positive.'
  if (chainNow === 0) return 'Still reading chain time — try again in a moment.'
  const deadline = BigInt(chainNow + Math.round(hours * 3600))

  // Tiers
  const tiers = inp.tiers
  if (tiers.length === 0) return 'Add at least one tier.'
  if (tiers.length > MAX_TIERS) return `Maximum ${MAX_TIERS} tiers.`
  let prevMin = 0, prevPrice = Infinity
  for (let i = 0; i < tiers.length; i++) {
    const mu = parseInt(tiers[i].minUnits)
    const pr = parseFloat(tiers[i].pricePerUnit)
    if (!Number.isFinite(mu) || mu < 1) return `Tier ${i + 1}: min units must be at least 1.`
    if (!Number.isFinite(pr) || pr <= 0) return `Tier ${i + 1}: price must be greater than zero.`
    if (BigInt(Math.round(pr * 1_000_000)) > MAX_PRICE_USDC) return `Tier ${i + 1}: price exceeds the $5 cap.`
    if (i > 0 && mu <= prevMin) return `Tier ${i + 1}: min units must be strictly ascending.`
    if (i > 0 && pr >= prevPrice) return `Tier ${i + 1}: price must be strictly descending.`
    prevMin = mu; prevPrice = pr
  }
  const firstMin = parseInt(tiers[0].minUnits)
  if (firstMin > minNum) return `First tier threshold (${firstMin}) exceeds deal minimum (${minNum}).`
  const lastMin = parseInt(tiers[tiers.length - 1].minUnits)
  if (lastMin > maxNum) return `Last tier threshold (${lastMin}) exceeds max units (${maxNum}).`

  const tierArgs = tiers.map(t => ({
    minUnits:     parseInt(t.minUnits),
    pricePerUnit: parsePriceToMicro(t.pricePerUnit)!,
  }))

  const stockAmount = BigInt(maxNum) * inp.tokensPerUnit

  return {
    goodsToken:       inp.goodsToken,
    tokensPerUnit:    inp.tokensPerUnit,
    tierArgs,
    minUnitsNum:      minNum,
    maxUnitsNum:      maxNum,
    maxUnitsPerBuyerNum: ppbNum,
    maxBuyersNum:     mbNum,
    deadline,
    title:            inp.title,
    description:      inp.description,
    stockAmount,
  }
}

// ── Token picker card ─────────────────────────────────────────────────────────

interface TokenPickerProps {
  selected:    GoodsToken
  onSelect:    (t: GoodsToken) => void
  balance:     number | undefined
  hasEnough:   boolean
  stockTokens: number
  symbol:      string
}

function TokenPickerCard({ selected, onSelect, balance, hasEnough, stockTokens, symbol }: TokenPickerProps) {
  return (
    <div className="rounded-3xl p-5 space-y-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>Token</span>

      {/* Token list */}
      <div className="space-y-2">
        {GOODS_TOKENS.map(tok => {
          const active = tok.address.toLowerCase() === selected.address.toLowerCase()
          return (
            <button
              key={tok.address}
              onClick={() => onSelect(tok)}
              className="w-full flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition-all hover:scale-[1.01]"
              style={{
                background: active ? 'var(--surface-muted)' : 'var(--surface)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{tok.symbol}</span>
                <span className="text-xs" style={{ color: 'var(--muted)' }}>{tok.name}</span>
              </div>
              {active && balance !== undefined && (
                <span className="text-xs tabular-nums" style={{ color: hasEnough ? 'var(--muted)' : 'var(--danger)' }}>
                  Balance: {balance.toLocaleString(undefined, { maximumFractionDigits: tok.decimals })}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <p className="text-xs" style={{ color: 'var(--subtle)' }}>More tokens are coming soon.</p>

      {/* No-balance notice */}
      {balance !== undefined && stockTokens > 0 && !hasEnough && (
        <div className="rounded-xl px-3 py-2.5 flex items-start gap-2.5"
          style={{ background: 'rgba(186,43,76,0.06)', border: '1px solid rgba(186,43,76,0.15)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            You need {symbol} to sell. Units you do not sell are returned to you when the deal closes.
          </p>
        </div>
      )}

      {/* Stock summary */}
      {stockTokens > 0 && symbol && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Deposit required: {stockTokens.toLocaleString()} {symbol}
        </p>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function SupplierView({ onDealPosted }: { onDealPosted: (id: bigint) => void }) {
  const { address, isConnected, chainId: walletChain } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain = isConnected && walletChain !== CHAIN_ID
  const chainNow = useChainNow()

  // ── Form state ───────────────────────────────────────────────────────────
  const [selectedToken, setSelectedToken] = useState<GoodsToken>(GOODS_TOKENS[0])
  const [unitsPerToken, setUnitsPerToken] = useState('1')
  const [tiers, setTiers] = useState<TierInput[]>(defaultTiers)
  const [minUnits, setMinUnits] = useState('1')
  const [maxUnits, setMaxUnits] = useState('50')
  const [maxUnitsPerBuyer, setMaxUnitsPerBuyer] = useState('')
  const [maxBuyers, setMaxBuyers] = useState('50')
  const [durationHours, setDurationHours] = useState('72')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  // ── Two-step state ───────────────────────────────────────────────────────
  const [step, setStep] = useState<PostStep>('idle')
  const [validationErr, setValidationErr] = useState<string | null>(null)
  const [errMsg, setErrMsg] = useState('')
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>()
  const [postTxHash, setPostTxHash] = useState<`0x${string}` | undefined>()

  // ── Token reads ──────────────────────────────────────────────────────────
  const goodsAddr   = selectedToken.address
  const decimals    = selectedToken.decimals
  const symbol      = selectedToken.symbol

  const { data: tokenBalance, refetch: refetchBalance } = useReadContract({
    address: goodsAddr, abi: ERC20_ABI, functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: CHAIN_ID, query: { enabled: !!address, refetchInterval: 6000 },
  })

  // ── Computed values ──────────────────────────────────────────────────────
  const unitsPerTokenNum = parseInt(unitsPerToken) || 1
  const tokensPerUnit    = BigInt(unitsPerTokenNum) * (10n ** BigInt(decimals))
  const maxUnitsNum      = parseInt(maxUnits) || 0
  const stockTokens      = maxUnitsNum > 0 && tokensPerUnit > 0n
    ? Number(BigInt(maxUnitsNum) * tokensPerUnit) / (10 ** decimals)
    : 0

  const walletDisplayBalance = tokenBalance !== undefined
    ? Number(tokenBalance) / (10 ** decimals)
    : undefined

  const hasEnoughBalance = walletDisplayBalance !== undefined && stockTokens > 0
    ? walletDisplayBalance >= stockTokens
    : true

  // ── Tier chart ───────────────────────────────────────────────────────────
  const parsedTiers = tiers.map(t => ({
    minUnits:     parseInt(t.minUnits) || 0,
    pricePerUnit: parsePriceToMicro(t.pricePerUnit) ?? 0n,
  })).filter(t => t.minUnits > 0 && t.pricePerUnit > 0n)

  const chartMax = Math.max(...parsedTiers.map(t => t.minUnits), parseInt(maxUnits) || 0, 1)
  const chartPoints = (() => {
    if (parsedTiers.length === 0) return []
    const pts: { x: number; y: number }[] = []
    for (const t of parsedTiers) pts.push({ x: t.minUnits, y: Number(t.pricePerUnit) / 1_000_000 })
    pts.push({ x: chartMax, y: Number(parsedTiers[parsedTiers.length - 1].pricePerUnit) / 1_000_000 })
    return pts
  })()
  const chartMinPrice = chartPoints.length ? Math.min(...chartPoints.map(p => p.y)) : 0
  const chartMaxPrice = chartPoints.length ? Math.max(...chartPoints.map(p => p.y)) : 1
  const toSvgX = (x: number) => (x / chartMax) * 260
  const toSvgY = (y: number) => 80 - ((y - chartMinPrice) / (chartMaxPrice - chartMinPrice || 1)) * 70

  const clearingAtFull = parsedTiers.length ? computePriceAt(parsedTiers, maxUnitsNum) : 0n
  const revenueAtFull  = clearingAtFull * BigInt(maxUnitsNum)

  // ── Tier mutations ───────────────────────────────────────────────────────
  const addTier    = () => setTiers(t => [...t, { minUnits: '', pricePerUnit: '' }])
  const removeTier = (i: number) => setTiers(t => t.filter((_, j) => j !== i))
  const updateTier = (i: number, field: keyof TierInput, val: string) =>
    setTiers(t => t.map((tier, j) => j === i ? { ...tier, [field]: val } : tier))

  // ── Contract writes ──────────────────────────────────────────────────────
  const { writeContract } = useWriteContract()

  const { isLoading: approveConfirming, isSuccess: approveSuccess } =
    useWaitForTransactionReceipt({ hash: approveTxHash, chainId: CHAIN_ID })
  const { isLoading: postConfirming, isSuccess: postReceiptArrived, data: postReceipt } =
    useWaitForTransactionReceipt({ hash: postTxHash, chainId: CHAIN_ID })
  const postSuccess  = postReceiptArrived && postReceipt?.status === 'success'
  const postReverted = postReceiptArrived && postReceipt?.status === 'reverted'

  const [postSlow, setPostSlow] = useState(false)
  useEffect(() => {
    if (!postTxHash || postReceiptArrived) return
    const t = setTimeout(() => setPostSlow(true), 60_000)
    return () => { clearTimeout(t); setPostSlow(false) }
  }, [postTxHash, postReceiptArrived])

  // Parse DealPosted from receipt to get the new deal id
  const parsedDealId = useMemo<bigint | null>(() => {
    if (!postSuccess || !postReceipt) return null
    try {
      const factoryLower = CONTRACTS_ACTIVE.DealFactory.toLowerCase()
      for (const log of postReceipt.logs) {
        if (log.address.toLowerCase() === factoryLower && log.topics[1]) {
          return BigInt(log.topics[1])
        }
      }
    } catch { /* ignore */ }
    return null
  }, [postSuccess, postReceipt])

  // Reset balance when token changes
  useEffect(() => { void refetchBalance() }, [selectedToken, refetchBalance])

  // ── Step 1: Approve ──────────────────────────────────────────────────────
  const handleApprove = useCallback(() => {
    setValidationErr(null)
    setErrMsg('')
    const inp: PostInputs = {
      goodsToken: goodsAddr,
      tokensPerUnit, tokenDecimals: decimals,
      tiers, minUnits, maxUnits, maxUnitsPerBuyer, maxBuyers,
      durationHours, title, description,
    }
    const result = validate(inp, chainNow)
    if (typeof result === 'string') { setValidationErr(result); return }

    if (!hasEnoughBalance) {
      setValidationErr(
        `Wallet holds ${walletDisplayBalance?.toFixed(2) ?? '?'} ${symbol}, ` +
        `but the stock requires ${stockTokens.toFixed(2)} ${symbol}.`
      )
      return
    }

    setStep('approving')
    writeContract(
      {
        address: result.goodsToken,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [CONTRACTS_ACTIVE.DealFactory, result.stockAmount],
        ...ARC_TX_FEES, chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setApproveTxHash(hash) },
        onError: (e) => { setErrMsg(parseRevertReason(e)); setStep('idle') },
      }
    )
  }, [
    goodsAddr, tokensPerUnit, decimals, tiers, minUnits, maxUnits, maxUnitsPerBuyer, maxBuyers,
    durationHours, title, description, chainNow, hasEnoughBalance,
    walletDisplayBalance, symbol, stockTokens, writeContract,
  ])

  // ── Step 2: Post deal ────────────────────────────────────────────────────
  const handlePost = useCallback(() => {
    setErrMsg('')
    const inp: PostInputs = {
      goodsToken: goodsAddr,
      tokensPerUnit, tokenDecimals: decimals,
      tiers, minUnits, maxUnits, maxUnitsPerBuyer, maxBuyers,
      durationHours, title, description,
    }
    const result = validate(inp, chainNow)
    if (typeof result === 'string') { setValidationErr(result); return }

    const postParams = {
      goodsToken:       result.goodsToken,
      tokensPerUnit:    result.tokensPerUnit,
      minUnits:         result.minUnitsNum,
      maxUnits:         result.maxUnitsNum,
      maxUnitsPerBuyer: result.maxUnitsPerBuyerNum,
      maxBuyers:        result.maxBuyersNum,
      deadline:         result.deadline,
      title:            result.title,
      description:      result.description,
    }

    setStep('posting')
    writeContract(
      {
        address: CONTRACTS_ACTIVE.DealFactory,
        abi: DEAL_FACTORY_ABI,
        functionName: 'postDeal',
        args: [postParams, result.tierArgs],
        ...ARC_TX_FEES, chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setPostTxHash(hash) },
        onError: (e) => { setErrMsg(parseRevertReason(e)); setStep('approved') },
      }
    )
  }, [
    goodsAddr, tokensPerUnit, decimals, tiers, minUnits, maxUnits, maxUnitsPerBuyer, maxBuyers,
    durationHours, title, description, chainNow, writeContract,
  ])

  // ── Render ───────────────────────────────────────────────────────────────
  const busy     = step === 'approving' || approveConfirming || step === 'posting' || postConfirming
  const postBusy = step === 'posting' || postConfirming

  const titleBytes = byteLengthOf(title)
  const descBytes  = byteLengthOf(description)

  return (
    <div className="w-full max-w-md mx-auto px-4 pb-8 space-y-5">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>
        <h2 className="display text-2xl font-bold mt-6 mb-1" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>Post a deal</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Sell a token. Buyers escrow the live unit price; everyone settles at one clearing price.
        </p>
      </motion.div>

      {/* ── Token picker ──────────────────────────────────────────────── */}
      <TokenPickerCard
        selected={selectedToken}
        onSelect={t => { setSelectedToken(t) }}
        balance={walletDisplayBalance}
        hasEnough={hasEnoughBalance}
        stockTokens={stockTokens}
        symbol={symbol}
      />

      {/* ── Tokens per unit ───────────────────────────────────────────── */}
      <div className="rounded-3xl p-5 space-y-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>Units</span>
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>{symbol} per unit (whole tokens)</span>
          <input
            type="number" min="1" step="1"
            value={unitsPerToken}
            onChange={e => setUnitsPerToken(e.target.value)}
            placeholder="1"
            className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none transition-colors"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
          />
          <span className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            1 unit = {unitsPerToken || '1'} {symbol}
          </span>
        </label>
      </div>

      {/* ── Title & description ──────────────────────────────────────────── */}
      <div className="rounded-3xl p-5 space-y-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>Listing</span>
        <label className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Title (required)</span>
            <span className="text-xs tabular-nums" style={{ color: titleBytes > 80 ? 'var(--danger)' : 'var(--subtle)' }}>
              {titleBytes}/80 bytes
            </span>
          </div>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Group buy: EURC at a discount"
            maxLength={200}
            className="rounded-xl px-3 py-2 text-sm outline-none transition-colors"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Description (optional)</span>
            <span className="text-xs tabular-nums" style={{ color: descBytes > 500 ? 'var(--danger)' : 'var(--subtle)' }}>
              {descBytes}/500 bytes
            </span>
          </div>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What are buyers getting?"
            rows={3}
            className="rounded-xl px-3 py-2 text-sm outline-none transition-colors resize-none"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
          />
        </label>
      </div>

      {/* ── Tier builder ─────────────────────────────────────────────────── */}
      <div className="rounded-3xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)' }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>Tiers</span>
          <button
            onClick={addTier}
            disabled={tiers.length >= MAX_TIERS}
            className="flex items-center gap-1 text-xs font-semibold rounded-lg px-2.5 py-1 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-30"
            style={{ background: 'var(--surface-muted)', color: 'var(--accent)' }}
          >
            <Plus className="size-3" /> Add tier
          </button>
        </div>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 px-1">
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>From N units</span>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>Price/unit (USDC)</span>
          <span className="w-7" />
        </div>
        <div className="space-y-2">
          {tiers.map((tier, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <input
                type="number" min="1"
                value={tier.minUnits}
                onChange={e => updateTier(i, 'minUnits', e.target.value)}
                placeholder="10"
                className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
                style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
              />
              <input
                type="number" min="0.000001" max="5" step="0.01"
                value={tier.pricePerUnit}
                onChange={e => updateTier(i, 'pricePerUnit', e.target.value)}
                placeholder="1.00"
                className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
                style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
              />
              <button
                onClick={() => removeTier(i)}
                disabled={tiers.length <= 1}
                className="size-7 flex items-center justify-center rounded-lg disabled:opacity-20 hover:opacity-60"
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
              <span className="text-xs" style={{ color: 'var(--muted)' }}>Price curve (units → $/unit)</span>
            </div>
            <svg viewBox="0 0 280 96" className="w-full" style={{ height: 96 }}>
              {[0.25, 0.5, 0.75].map(t => (
                <line key={t} x1={10} x2={270} y1={8 + t * 72} y2={8 + t * 72}
                  stroke="var(--border)" strokeWidth={0.5} />
              ))}
              <path
                d={chartPoints.map((pt, i) => {
                  const x = 10 + toSvgX(pt.x)
                  const y = 8 + toSvgY(pt.y)
                  if (i === 0) return `M ${x} ${y}`
                  const prev = chartPoints[i - 1]
                  return `L ${x} ${8 + toSvgY(prev.y)} L ${x} ${y}`
                }).join(' ')}
                fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round"
              />
              {parsedTiers.map((t, i) => (
                <text key={i} x={10 + toSvgX(t.minUnits)}
                  y={8 + toSvgY(Number(t.pricePerUnit) / 1_000_000) - 4}
                  fontSize={7} fill="var(--muted)" textAnchor="middle"
                  fontFamily="JetBrains Mono, monospace">
                  ${(Number(t.pricePerUnit) / 1_000_000).toFixed(2)}
                </text>
              ))}
            </svg>
          </div>
        )}

        {/* Revenue preview */}
        {parsedTiers.length > 0 && (
          <div className="rounded-xl p-3 space-y-1" style={{ background: 'var(--surface-muted)' }}>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>At {maxUnits || '?'} units sold</p>
            <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
              Clearing price:{' '}
              <span className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
                {formatUsdcPrice(clearingAtFull)}/unit
              </span>
            </p>
            <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
              You receive:{' '}
              <span className="font-semibold tabular-nums" style={{ color: 'var(--success)' }}>
                {formatUsdcPrice(revenueAtFull)}
              </span>
            </p>
          </div>
        )}
      </div>

      {/* ── Parameters ──────────────────────────────────────────────────── */}
      <div className="rounded-3xl p-5 space-y-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>Parameters</span>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Stock (max units)</span>
            <input type="number" min="1" value={maxUnits} onChange={e => setMaxUnits(e.target.value)}
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }} />
            {symbol && stockTokens > 0 && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                = {stockTokens.toLocaleString()} {symbol} deposited
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Deal minimum (units)</span>
            <input type="number" min="1" value={minUnits} onChange={e => setMinUnits(e.target.value)}
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Max buyers (1–{MAX_CAP})</span>
            <input type="number" min="1" max={MAX_CAP} value={maxBuyers} onChange={e => setMaxBuyers(e.target.value)}
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Per-buyer limit (0 = none)</span>
            <input type="number" min="0" value={maxUnitsPerBuyer} onChange={e => setMaxUnitsPerBuyer(e.target.value)}
              placeholder="0"
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }} />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Duration (hours)</span>
            <input type="number" min="1" value={durationHours} onChange={e => setDurationHours(e.target.value)}
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }} />
          </label>
        </div>
      </div>

      {/* ── Errors ─────────────────────────────────────────────────────── */}
      {validationErr && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5" style={{ background: 'rgba(186,43,76,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <p className="text-sm" style={{ color: 'var(--danger)' }}>{validationErr}</p>
        </div>
      )}
      {postReverted && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5" style={{ background: 'rgba(186,43,76,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            The post transaction was mined but failed, so no deal was created and your tokens did not move.{' '}
            {postTxHash && <a href={txUrl(postTxHash)} target="_blank" rel="noreferrer" className="underline">See it on the explorer</a>}
          </p>
        </div>
      )}
      {postSlow && !postReceiptArrived && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5" style={{ background: 'rgba(255,160,0,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--warn, #b45309)' }} />
          <p className="text-sm" style={{ color: 'var(--warn, #b45309)' }}>
            Still not confirmed after a minute. Check the transaction in your wallet — if it shows as dropped or failed, press Post deal again.
          </p>
        </div>
      )}
      {errMsg && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5" style={{ background: 'rgba(186,43,76,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <p className="text-sm" style={{ color: 'var(--danger)' }}>{errMsg}</p>
        </div>
      )}

      {/* ── CTA ────────────────────────────────────────────────────────── */}
      {!isConnected ? (
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button onClick={show}
              className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white"
              style={{ background: 'var(--accent)' }}>
              Connect wallet to post
            </button>
          )}
        </ConnectKitButton.Custom>
      ) : wrongChain ? (
        <button onClick={() => switchChain({ chainId: CHAIN_ID })}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white"
          style={{ background: 'var(--accent)' }}>
          Switch to {ARC_NETWORK.name}
        </button>
      ) : postSuccess ? (
        <div className="rounded-2xl p-4 space-y-2"
          style={{ background: 'rgba(26,128,71,0.08)', border: '1px solid rgba(26,128,71,0.2)' }}>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-4" style={{ color: 'var(--success)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--success)' }}>
              Deal #{parsedDealId?.toString() ?? '...'} posted
            </span>
          </div>
          <div className="flex items-center gap-3">
            {postTxHash && (
              <a href={txUrl(postTxHash)} target="_blank" rel="noreferrer"
                className="flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }}>
                View transaction <ExternalLink className="size-3" />
              </a>
            )}
            {parsedDealId !== null && (
              <button
                onClick={() => onDealPosted(parsedDealId)}
                className="text-xs font-semibold ml-auto"
                style={{ color: 'var(--accent)' }}>
                Open deal room →
              </button>
            )}
          </div>
        </div>
      ) : approveSuccess || step === 'approved' || step === 'posting' ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <CheckCircle2 className="size-3.5" style={{ color: 'var(--success)' }} />
            <span>Approval confirmed</span>
            <span className="mx-1">·</span>
            <span style={{ color: 'var(--ink)' }}>Step 2: post deal</span>
          </div>
          <button
            onClick={handlePost}
            disabled={postBusy}
            className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
            style={{ background: 'var(--accent)' }}>
            {postConfirming
              ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirming...</span>
              : step === 'posting'
              ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirm in wallet...</span>
              : 'Post deal'}
          </button>
          {approveTxHash && (
            <a href={txUrl(approveTxHash)} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-xs justify-center" style={{ color: 'var(--subtle)' }}>
              Approval tx <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <span className="size-4 rounded-full border flex items-center justify-center text-xs font-bold"
              style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>1</span>
            <span style={{ color: 'var(--ink)' }}>Approve token spend</span>
            <span className="mx-1">→</span>
            <span className="size-4 rounded-full border flex items-center justify-center text-xs font-bold"
              style={{ borderColor: 'var(--muted)', color: 'var(--muted)' }}>2</span>
            <span>Post deal</span>
          </div>
          <button
            onClick={handleApprove}
            disabled={busy}
            className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
            style={{ background: 'var(--accent)' }}>
            {approveConfirming
              ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirming approval...</span>
              : step === 'approving'
              ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Confirm in wallet...</span>
              : 'Approve token'}
          </button>
        </div>
      )}
    </div>
  )
}
