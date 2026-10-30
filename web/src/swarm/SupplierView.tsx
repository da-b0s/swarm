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
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  useAccount, useWriteContract, useWaitForTransactionReceipt,
  useSwitchChain, useReadContracts,
} from 'wagmi'
import { parseUnits } from 'viem'
import { ConnectKitButton } from 'connectkit'
import { motion } from 'framer-motion'
import { Plus, Trash2, Loader2, ExternalLink, AlertCircle, TrendingDown, CheckCircle2, Info, ChevronDown, Check } from 'lucide-react'
import { DEAL_FACTORY_ABI, ERC20_ABI } from './abis'
import { CONTRACTS_ACTIVE, ARC_NETWORK, MAX_CAP, MAX_TIERS, MAX_PRICE_USDC, ARC_TX_FEES, GOODS_TOKENS, POLL_MY_ORDER } from './config'
import type { GoodsToken } from './config'
import { useChainNow } from './hooks'
import { formatUsdcPrice, txUrl, parseRevertReason, computePriceAt, formatTokenAmount, pricePerToken, marketDeviation } from './utils'
import { useMarketRates } from './useMarketRates'

const CHAIN_ID = ARC_NETWORK.chainId
const USDC     = ARC_NETWORK.usdc.address

// ── Types ─────────────────────────────────────────────────────────────────────

interface TierInput { minUnits: string; pricePerUnit: string }

type PostStep = 'idle' | 'approving' | 'approved' | 'posting' | 'done'

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default tiers suited to EURC: $1.20 → $1.17 → $1.15 */
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

/**
 * Parse a human-entered amount string to base units using the token's decimal count.
 * Returns null if the string is invalid, zero, negative, or uses more decimal places
 * than the token allows.
 */
function parseTokenAmount(str: string, decimals: number): bigint | null {
  if (!str || str.trim() === '') return null
  const trimmed = str.trim()
  // Reject if more decimal places than the token allows
  const dotIdx = trimmed.indexOf('.')
  if (dotIdx !== -1 && trimmed.length - dotIdx - 1 > decimals) return null
  try {
    const val = parseUnits(trimmed, decimals)
    if (val <= 0n) return null
    return val
  } catch {
    return null
  }
}

/** Format a closing-time duration in plain language, e.g. "30 minutes", "3 days 2 hours". */
function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return ''
  const totalMins = Math.round(hours * 60)
  if (totalMins < 60) return `${totalMins} minute${totalMins === 1 ? '' : 's'}`
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  const days = Math.floor(h / 24)
  const rem  = h % 24
  if (days > 0 && rem > 0) return `${days} day${days === 1 ? '' : 's'} ${rem} hour${rem === 1 ? '' : 's'}`
  if (days > 0)            return `${days} day${days === 1 ? '' : 's'}`
  if (m > 0) return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`
  return `${h} hour${h === 1 ? '' : 's'}`
}

// ── Validation ────────────────────────────────────────────────────────────────

interface PostInputs {
  goodsToken:       `0x${string}`
  tokensPerUnit:    bigint        // already parsed, validated non-null before calling validate()
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
  goodsToken:          `0x${string}`
  tokensPerUnit:       bigint
  tierArgs:            { minUnits: number; pricePerUnit: bigint }[]
  minUnitsNum:         number
  maxUnitsNum:         number
  maxUnitsPerBuyerNum: number
  maxBuyersNum:        number
  deadline:            bigint
  title:               string
  description:         string
  stockAmount:         bigint
}

function validate(inp: PostInputs, chainNow: number): ValidatedInputs | string {
  if (!inp.goodsToken || inp.goodsToken === '0x0000000000000000000000000000000000000000')
    return 'Select a goods token.'
  if (inp.goodsToken.toLowerCase() === USDC.toLowerCase())
    return 'USDC cannot be the goods token.'

  const titleBytes = byteLengthOf(inp.title)
  if (titleBytes === 0) return 'Title is required.'
  if (titleBytes > 80)  return `Title is ${titleBytes} bytes; maximum is 80.`
  const descBytes = byteLengthOf(inp.description)
  if (descBytes > 500)  return `Description is ${descBytes} bytes; maximum is 500.`

  if (inp.tokensPerUnit <= 0n) return 'Tokens per unit must be greater than zero.'

  const minNum = parseInt(inp.minUnits)
  const maxNum = parseInt(inp.maxUnits)
  const ppbNum = parseInt(inp.maxUnitsPerBuyer) || 0
  const mbNum  = parseInt(inp.maxBuyers)

  if (!Number.isFinite(maxNum) || maxNum < 1)              return 'Max units (stock) must be at least 1.'
  if (!Number.isFinite(minNum) || minNum < 1)              return 'Deal minimum must be at least 1 unit.'
  if (minNum > maxNum)                                     return 'Deal minimum cannot exceed max units.'
  if (!Number.isFinite(mbNum) || mbNum < 1 || mbNum > MAX_CAP)
    return `Max buyers must be 1–${MAX_CAP}.`
  if (ppbNum > 0 && ppbNum > maxNum)                       return 'Per-buyer limit cannot exceed max units.'

  const hours = parseFloat(inp.durationHours)
  if (!Number.isFinite(hours) || hours <= 0) return 'Duration must be positive.'
  if (chainNow === 0) return 'Still reading chain time — try again in a moment.'
  const deadline = BigInt(chainNow + Math.round(hours * 3600))

  const tiers = inp.tiers
  if (tiers.length === 0)        return 'Add at least one tier.'
  if (tiers.length > MAX_TIERS)  return `Maximum ${MAX_TIERS} tiers.`
  let prevMin = 0, prevPrice = Infinity
  for (let i = 0; i < tiers.length; i++) {
    const mu = parseInt(tiers[i].minUnits)
    const pr = parseFloat(tiers[i].pricePerUnit)
    if (!Number.isFinite(mu) || mu < 1) return `Tier ${i + 1}: min units must be at least 1.`
    if (!Number.isFinite(pr) || pr <= 0) return `Tier ${i + 1}: price must be greater than zero.`
    if (BigInt(Math.round(pr * 1_000_000)) > MAX_PRICE_USDC) return `Tier ${i + 1}: price exceeds the $5 cap.`
    if (i > 0 && mu <= prevMin)  return `Tier ${i + 1}: min units must be strictly ascending.`
    if (i > 0 && pr >= prevPrice) return `Tier ${i + 1}: price must be strictly descending.`
    prevMin = mu; prevPrice = pr
  }
  const firstMin = parseInt(tiers[0].minUnits)
  if (firstMin > minNum) return `First tier threshold (${firstMin}) exceeds deal minimum (${minNum}).`
  const lastMin  = parseInt(tiers[tiers.length - 1].minUnits)
  if (lastMin > maxNum)  return `Last tier threshold (${lastMin}) exceeds max units (${maxNum}).`

  const tierArgs = tiers.map(t => ({
    minUnits:     parseInt(t.minUnits),
    pricePerUnit: parsePriceToMicro(t.pricePerUnit)!,
  }))

  const stockAmount = BigInt(maxNum) * inp.tokensPerUnit

  return {
    goodsToken:          inp.goodsToken,
    tokensPerUnit:       inp.tokensPerUnit,
    tierArgs,
    minUnitsNum:         minNum,
    maxUnitsNum:         maxNum,
    maxUnitsPerBuyerNum: ppbNum,
    maxBuyersNum:        mbNum,
    deadline,
    title:               inp.title,
    description:         inp.description,
    stockAmount,
  }
}

// ── Token picker dropdown ─────────────────────────────────────────────────────

interface TokenPickerProps {
  selected:  GoodsToken
  onSelect:  (t: GoodsToken) => void
  /** balances keyed by token address (lower-cased), raw base units */
  balances:  Map<string, bigint>
}

function TokenPickerDropdown({ selected, onSelect, balances }: TokenPickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Keyboard nav
  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = GOODS_TOKENS.findIndex(t => t.address === selected.address)
    if (e.key === 'Escape') { setOpen(false); return }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); return }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      onSelect(GOODS_TOKENS[(idx + 1) % GOODS_TOKENS.length])
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      onSelect(GOODS_TOKENS[(idx - 1 + GOODS_TOKENS.length) % GOODS_TOKENS.length])
    }
  }

  const selBal = balances.get(selected.address.toLowerCase())
  const selBalDisplay = selBal !== undefined ? formatTokenAmount(selBal, selected.decimals) : undefined

  return (
    <div ref={ref} className="rounded-3xl p-5 space-y-3"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <span className="text-xs font-semibold tracking-wide uppercase"
        style={{ color: 'var(--muted)' }}>Token</span>

      {/* Trigger */}
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onKeyDown}
        className="w-full flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition-all hover:scale-[1.005]"
        style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{selected.symbol}</span>
          <span className="text-xs truncate" style={{ color: 'var(--muted)' }}>{selected.name}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {selBalDisplay !== undefined && (
            <span className="text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
              {selBalDisplay} {selected.symbol}
            </span>
          )}
          <ChevronDown className="size-4 transition-transform"
            style={{ color: 'var(--muted)', transform: open ? 'rotate(180deg)' : undefined }} />
        </div>
      </button>

      {/* Dropdown list */}
      {open && (
        <ul role="listbox" aria-label="Select token" className="space-y-1">
          {GOODS_TOKENS.map(tok => {
            const isSelected = tok.address.toLowerCase() === selected.address.toLowerCase()
            const bal = balances.get(tok.address.toLowerCase())
            const balDisplay = bal !== undefined ? formatTokenAmount(bal, tok.decimals) : undefined
            return (
              <li key={tok.address} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => { onSelect(tok); setOpen(false) }}
                  className="w-full flex items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-left transition-all hover:scale-[1.005]"
                  style={{
                    background: isSelected ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'var(--surface-muted)',
                    border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {isSelected
                      ? <Check className="size-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
                      : <span className="size-3.5 shrink-0" />}
                    <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{tok.symbol}</span>
                    <span className="text-xs truncate" style={{ color: 'var(--muted)' }}>{tok.name}</span>
                  </div>
                  {balDisplay !== undefined && (
                    <span className="text-xs tabular-nums shrink-0" style={{ color: 'var(--subtle)' }}>
                      {balDisplay} {tok.symbol}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-xs" style={{ color: 'var(--subtle)' }}>More tokens are coming soon.</p>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function SupplierView({ onDealPosted }: { onDealPosted: (id: bigint) => void }) {
  const { address, isConnected, chainId: walletChain } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain  = isConnected && walletChain !== CHAIN_ID
  const chainNow    = useChainNow()
  const marketRates = useMarketRates()

  // Track when market rates were last populated so we can show "updated N min ago".
  // Store the timestamp in a ref; derive the display string in a 30s interval tick
  // so we never call setState synchronously inside an effect.
  const ratesTimestampRef = useRef<number | null>(null)
  if (marketRates !== undefined && ratesTimestampRef.current === null) {
    ratesTimestampRef.current = Date.now()
  }
  const ageFromRef = (): string | null => {
    const ts = ratesTimestampRef.current
    if (ts === null) return null
    const mins = Math.round((Date.now() - ts) / 60_000)
    return mins < 1 ? 'updated just now' : `updated ${mins} min ago`
  }
  const [ratesAgeLabel, setRatesAgeLabel] = useState<string | null>(ageFromRef)
  useEffect(() => {
    const id = setInterval(() => setRatesAgeLabel(ageFromRef()), 30_000)
    return () => clearInterval(id)
  // ageFromRef reads the ref, not a prop/state — no deps needed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Form state ───────────────────────────────────────────────────────────
  const [selectedToken,    setSelectedToken]    = useState<GoodsToken>(GOODS_TOKENS[0])
  const [tokensPerUnitStr, setTokensPerUnitStr] = useState('1')
  const [tiers,            setTiers]            = useState<TierInput[]>(defaultTiers)
  const [minUnits,         setMinUnits]         = useState('1')
  const [maxUnits,         setMaxUnits]         = useState('50')
  const [maxUnitsPerBuyer, setMaxUnitsPerBuyer] = useState('')
  const [maxBuyers,        setMaxBuyers]        = useState('50')
  const [durationHours,    setDurationHours]    = useState('72')
  const [title,            setTitle]            = useState('')
  const [description,      setDescription]      = useState('')

  // Track whether the seller has manually edited the stock field yet
  const [stockEdited, setStockEdited] = useState(false)

  // ── Two-step state ───────────────────────────────────────────────────────
  const [step,          setStep]          = useState<PostStep>('idle')
  const [validationErr, setValidationErr] = useState<string | null>(null)
  const [errMsg,        setErrMsg]        = useState('')
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>()
  const [postTxHash,    setPostTxHash]    = useState<`0x${string}` | undefined>()

  // ── Token reads ──────────────────────────────────────────────────────────
  const goodsAddr = selectedToken.address
  const decimals  = selectedToken.decimals
  const symbol    = selectedToken.symbol

  // Batch-read balances for all GOODS_TOKENS so the picker shows them all.
  const balanceCalls = useMemo(() =>
    GOODS_TOKENS.map(tok => ({
      address:      tok.address,
      abi:          ERC20_ABI,
      functionName: 'balanceOf' as const,
      args:         [address ?? '0x0000000000000000000000000000000000000000'] as [`0x${string}`],
      chainId:      CHAIN_ID,
    })),
    [address]
  )
  const { data: allBalancesRaw } = useReadContracts({
    contracts: balanceCalls,
    query: { enabled: !!address, refetchInterval: POLL_MY_ORDER, refetchIntervalInBackground: false },
  })

  const allBalances: Map<string, bigint> = useMemo(() => {
    const m = new Map<string, bigint>()
    GOODS_TOKENS.forEach((tok, i) => {
      const r = allBalancesRaw?.[i]
      if (r?.status === 'success' && r.result !== undefined) {
        m.set(tok.address.toLowerCase(), BigInt(String(r.result)))
      }
    })
    return m
  }, [allBalancesRaw])

  const tokenBalance = allBalances.get(goodsAddr.toLowerCase())

  // ── Parse tokensPerUnit ──────────────────────────────────────────────────
  // Uses parseUnits so any precision the token allows works correctly.
  const tokensPerUnit: bigint | null = useMemo(
    () => parseTokenAmount(tokensPerUnitStr, decimals),
    [tokensPerUnitStr, decimals]
  )

  const tokensPerUnitErr: string | null = useMemo(() => {
    if (!tokensPerUnitStr || tokensPerUnitStr.trim() === '') return `${symbol} per unit is required.`
    const dotIdx = tokensPerUnitStr.indexOf('.')
    if (dotIdx !== -1 && tokensPerUnitStr.length - dotIdx - 1 > decimals)
      return `${symbol} has ${decimals} decimal places; you entered more.`
    const n = parseFloat(tokensPerUnitStr)
    if (isNaN(n) || n <= 0) return `${symbol} per unit must be greater than zero.`
    return null
  }, [tokensPerUnitStr, decimals, symbol])

  // ── Computed deposit ─────────────────────────────────────────────────────
  // stockAmount and effectiveMaxUnitsNum are derived below after balance check.
  // stockDisplay is also derived below.


  // ── Balance checks ───────────────────────────────────────────────────────
  const balanceIsZero = tokenBalance !== undefined && tokenBalance === 0n
  const maxAffordable = tokenBalance !== undefined && tokensPerUnit !== null && tokensPerUnit > 0n
    ? Number(tokenBalance / tokensPerUnit)
    : 0

  // Default stock = min(50, floor(balance/tokensPerUnit)) until the seller edits the field.
  // Derived during render — no setState in an effect.
  const effectiveMaxUnitsNum: number = (() => {
    if (stockEdited) return parseInt(maxUnits) || 0
    if (tokenBalance !== undefined && tokensPerUnit !== null && tokensPerUnit > 0n) {
      const affordable = Number(tokenBalance / tokensPerUnit)
      if (affordable > 0) return Math.min(50, affordable)
    }
    return parseInt(maxUnits) || 0
  })()

  const stockAmount  = tokensPerUnit !== null && effectiveMaxUnitsNum > 0
    ? BigInt(effectiveMaxUnitsNum) * tokensPerUnit
    : 0n
  const overBudget   = tokenBalance !== undefined && stockAmount > 0n && tokenBalance < stockAmount
  // Display the deposit in whole tokens — same computation as what is posted
  const stockDisplay = tokensPerUnit !== null && effectiveMaxUnitsNum > 0
    ? formatTokenAmount(stockAmount, decimals)
    : null

  // ── Tier chart ───────────────────────────────────────────────────────────
  const parsedTiers = tiers.map(t => ({
    minUnits:     parseInt(t.minUnits) || 0,
    pricePerUnit: parsePriceToMicro(t.pricePerUnit) ?? 0n,
  })).filter(t => t.minUnits > 0 && t.pricePerUnit > 0n)

  const chartMax    = Math.max(...parsedTiers.map(t => t.minUnits), effectiveMaxUnitsNum, 1)
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

  const clearingAtFull = parsedTiers.length ? computePriceAt(parsedTiers, effectiveMaxUnitsNum) : 0n
  const revenueAtFull  = clearingAtFull * BigInt(effectiveMaxUnitsNum)

  // ── Market-price helpers ─────────────────────────────────────────────────
  const mSym = selectedToken.marketSymbol
  const mUsdPerToken = mSym ? marketRates?.get(mSym) : undefined

  /**
   * Compute the USDC price per unit corresponding to a given USD/token market
   * rate, rounded to 2 dp (or 4 dp when the value is < $1 to keep tiers distinct).
   */
  const marketPricePerUnit = useMemo((): string | null => {
    if (mUsdPerToken === undefined || !tokensPerUnit || tokensPerUnit === 0n) return null
    // USD per token × tokens per unit (in whole-token units) = USD per unit
    const scale = 10 ** decimals
    const tokensWhole = Number(tokensPerUnit) / scale
    const usdPerUnit  = mUsdPerToken * tokensWhole
    if (usdPerUnit <= 0) return null
    const dp = usdPerUnit < 1 ? 4 : 2
    return usdPerUnit.toFixed(dp)
  }, [mUsdPerToken, tokensPerUnit, decimals])

  /**
   * Fill all tier prices from the market rate.
   * First tier = market +2%, last tier = market (at-market), tiers in between
   * linearly spaced.  Prices strictly descend by rounding each to dp.
   */
  const applyMarketPrices = useCallback(() => {
    if (!marketPricePerUnit) return
    const base = parseFloat(marketPricePerUnit)
    if (!Number.isFinite(base) || base <= 0) return
    const top  = base * 1.02
    const dp   = base < 1 ? 4 : 2
    setTiers(prev => {
      const count = prev.length
      return prev.map((tier, i) => {
        const t = count === 1 ? 1 : i / (count - 1)   // 0 … 1
        const price = top - (top - base) * t
        return { ...tier, pricePerUnit: price.toFixed(dp) }
      })
    })
  }, [marketPricePerUnit])

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

  // Balance polling is handled automatically by the refetchInterval on the batch read.

  // ── Duration display ─────────────────────────────────────────────────────
  const hoursNum      = parseFloat(durationHours)
  const durationLabel = Number.isFinite(hoursNum) && hoursNum > 0
    ? `Closes in ${formatDuration(hoursNum)}`
    : ''

  // ── Step 1: Approve ──────────────────────────────────────────────────────
  const handleApprove = useCallback(() => {
    setValidationErr(null)
    setErrMsg('')
    if (tokensPerUnit === null) {
      setValidationErr(tokensPerUnitErr ?? `Invalid ${symbol} per unit.`)
      return
    }
    const inp: PostInputs = {
      goodsToken: goodsAddr, tokensPerUnit, tokenDecimals: decimals,
      tiers, minUnits, maxUnits: String(effectiveMaxUnitsNum), maxUnitsPerBuyer, maxBuyers,
      durationHours, title, description,
    }
    const result = validate(inp, chainNow)
    if (typeof result === 'string') { setValidationErr(result); return }

    if (overBudget) {
      setValidationErr(
        `Your balance covers up to ${maxAffordable} unit${maxAffordable === 1 ? '' : 's'} at ` +
        `${tokensPerUnitStr} ${symbol} each. Lower your stock or add more ${symbol}.`
      )
      return
    }

    setStep('approving')
    writeContract(
      {
        address: result.goodsToken, abi: ERC20_ABI, functionName: 'approve',
        args: [CONTRACTS_ACTIVE.DealFactory, result.stockAmount],
        ...ARC_TX_FEES, chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setApproveTxHash(hash) },
        onError:   (e)    => { setErrMsg(parseRevertReason(e)); setStep('idle') },
      }
    )
  }, [
    goodsAddr, tokensPerUnit, tokensPerUnitErr, tokensPerUnitStr, decimals,
    tiers, minUnits, effectiveMaxUnitsNum, maxUnitsPerBuyer, maxBuyers,
    durationHours, title, description, chainNow,
    overBudget, maxAffordable, symbol, writeContract,
  ])

  // ── Step 2: Post deal ────────────────────────────────────────────────────
  const handlePost = useCallback(() => {
    setErrMsg('')
    if (tokensPerUnit === null) { setValidationErr(tokensPerUnitErr ?? `Invalid ${symbol} per unit.`); return }
    const inp: PostInputs = {
      goodsToken: goodsAddr, tokensPerUnit, tokenDecimals: decimals,
      tiers, minUnits, maxUnits: String(effectiveMaxUnitsNum), maxUnitsPerBuyer, maxBuyers,
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
        address: CONTRACTS_ACTIVE.DealFactory, abi: DEAL_FACTORY_ABI,
        functionName: 'postDeal', args: [postParams, result.tierArgs],
        ...ARC_TX_FEES, chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setPostTxHash(hash) },
        onError:   (e)    => { setErrMsg(parseRevertReason(e)); setStep('approved') },
      }
    )
  }, [
    goodsAddr, tokensPerUnit, tokensPerUnitErr, decimals, symbol,
    tiers, minUnits, effectiveMaxUnitsNum, maxUnitsPerBuyer, maxBuyers,
    durationHours, title, description, chainNow, writeContract,
  ])

  // ── Render ───────────────────────────────────────────────────────────────
  const busy     = step === 'approving' || approveConfirming || step === 'posting' || postConfirming
  const postBusy = step === 'posting' || postConfirming

  const titleBytes      = byteLengthOf(title)
  const descBytes       = byteLengthOf(description)
  const titleCharsLeft  = 80 - titleBytes
  const descCharsLeft   = 500 - descBytes

  // "1 unit = X SYMBOL" — same parsed value that is posted
  const unitDisplayStr = tokensPerUnit !== null
    ? formatTokenAmount(tokensPerUnit, decimals)
    : null

  // ── Right-column live preview ──────────────────────────────────────────────
  const previewPanel = (
    <div className="rounded-3xl p-5 space-y-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <span className="text-xs font-semibold tracking-wide uppercase"
        style={{ color: 'var(--muted)' }}>Live preview</span>

      {/* Price curve */}
      {chartPoints.length >= 2 ? (
        <div className="rounded-xl overflow-hidden" style={{ background: 'var(--surface-muted)' }}>
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
      ) : (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>Add tiers to see the curve.</p>
      )}

      {/* Per-tier USDC per token */}
      {parsedTiers.length > 0 && tokensPerUnit !== null && (
        <div className="space-y-1">
          {parsedTiers.map((t, i) => {
            const ppt = pricePerToken(t.pricePerUnit, tokensPerUnit, decimals)
            return ppt ? (
              <div key={i} className="flex justify-between text-xs">
                <span style={{ color: 'var(--muted)' }}>
                  ≥ {t.minUnits} units · {formatUsdcPrice(t.pricePerUnit)}/unit
                </span>
                <span className="tabular-nums font-medium" style={{ color: 'var(--ink-2)' }}>
                  {ppt} per {symbol}
                </span>
              </div>
            ) : null
          })}
        </div>
      )}

      {/* Deposit & revenue summary */}
      {parsedTiers.length > 0 && (
        <div className="rounded-xl p-3 space-y-2" style={{ background: 'var(--surface-muted)' }}>
          {stockDisplay !== null && (
            <div className="flex justify-between text-xs">
              <span style={{ color: 'var(--muted)' }}>Token deposit</span>
              <span className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
                {stockDisplay} {symbol}
              </span>
            </div>
          )}
          <div className="flex justify-between text-xs">
            <span style={{ color: 'var(--muted)' }}>At {effectiveMaxUnitsNum} units sold</span>
            <span className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
              {formatUsdcPrice(clearingAtFull)}/unit
            </span>
          </div>
          <div className="flex justify-between text-xs border-t pt-2" style={{ borderColor: 'var(--border)' }}>
            <span style={{ color: 'var(--muted)' }}>You receive</span>
            <span className="font-bold tabular-nums" style={{ color: 'var(--success)' }}>
              {formatUsdcPrice(revenueAtFull)}
            </span>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="px-4 pt-5 pb-10">
      <div className="lg:grid lg:grid-cols-[1fr_340px] lg:gap-8 lg:items-start">
        {/* Left: form */}
        <div className="space-y-5">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>
        <h2 className="display text-2xl font-bold mt-6 mb-1"
          style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>Post a deal</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Buyers pay the current price. When the deal closes, everyone pays the same final price and gets the difference back.
        </p>
      </motion.div>

      {/* ── Token picker ──────────────────────────────────────────────────── */}
      <TokenPickerDropdown
        selected={selectedToken}
        onSelect={t => { setSelectedToken(t); setStockEdited(false) }}
        balances={allBalances}
      />

      {/* Zero-balance notice — only when balance is exactly zero */}
      {balanceIsZero && (
        <div className="rounded-2xl px-3 py-2.5 flex items-start gap-2.5"
          style={{ background: 'rgba(186,43,76,0.06)', border: '1px solid rgba(186,43,76,0.15)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            You need {symbol} to sell. Units you do not sell are returned to you when the deal closes.
          </p>
        </div>
      )}

      {/* ── EURC per unit ─────────────────────────────────────────────────── */}
      <div className="rounded-3xl p-5 space-y-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold tracking-wide uppercase"
          style={{ color: 'var(--muted)' }}>Units</span>
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>{symbol} per unit</span>
          <input
            type="number" min="0.000001" step="any"
            value={tokensPerUnitStr}
            onChange={e => setTokensPerUnitStr(e.target.value)}
            placeholder="1"
            className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none transition-colors"
            style={{ background: 'var(--surface-muted)', border: `1px solid ${tokensPerUnitErr ? 'var(--danger)' : 'var(--border)'}`, color: 'var(--ink)' }}
          />
          {tokensPerUnitErr ? (
            <span className="text-xs mt-0.5" style={{ color: 'var(--danger)' }}>{tokensPerUnitErr}</span>
          ) : unitDisplayStr !== null ? (
            <span className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
              1 unit = {unitDisplayStr} {symbol}
            </span>
          ) : null}
        </label>
      </div>

      {/* ── Title & description ──────────────────────────────────────────── */}
      <div className="rounded-3xl p-5 space-y-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold tracking-wide uppercase"
          style={{ color: 'var(--muted)' }}>Listing</span>
        <label className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Title (required)</span>
            <span className="text-xs tabular-nums"
              style={{ color: titleBytes > 80 ? 'var(--danger)' : 'var(--subtle)' }}>
              {titleCharsLeft >= 0 ? `${titleCharsLeft} left` : `${-titleCharsLeft} over`}
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
            <span className="text-xs tabular-nums"
              style={{ color: descBytes > 500 ? 'var(--danger)' : 'var(--subtle)' }}>
              {descCharsLeft >= 0 ? `${descCharsLeft} left` : `${-descCharsLeft} over`}
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
      <div className="rounded-3xl p-5 space-y-3"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)' }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold tracking-wide uppercase"
            style={{ color: 'var(--muted)' }}>Tiers</span>
          <div className="flex items-center gap-2">
            {marketPricePerUnit && (
              <button onClick={applyMarketPrices}
                className="text-xs font-semibold rounded-lg px-2.5 py-1 transition-all hover:scale-[1.02] active:scale-[0.98]"
                style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)' }}>
                Use market price
              </button>
            )}
            <button onClick={addTier} disabled={tiers.length >= MAX_TIERS}
              className="flex items-center gap-1 text-xs font-semibold rounded-lg px-2.5 py-1 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-30"
              style={{ background: 'var(--surface-muted)', color: 'var(--accent)' }}>
              <Plus className="size-3" /> Add tier
            </button>
          </div>
        </div>

        {/* Market rate label */}
        {mUsdPerToken !== undefined && ratesAgeLabel && (
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>
            Market: 1 {symbol} = {mUsdPerToken < 1 ? mUsdPerToken.toFixed(6) : mUsdPerToken.toFixed(4)} USDC (CoinGecko, {ratesAgeLabel})
          </p>
        )}
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 px-1">
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>From N units</span>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>Price/unit (USDC)</span>
          <span className="w-7" />
        </div>
        <div className="space-y-2">
          {tiers.map((tier, i) => {
            const tierPrice = parsePriceToMicro(tier.pricePerUnit)
            const tierPPT   = tierPrice !== null && tokensPerUnit !== null
              ? pricePerToken(tierPrice, tokensPerUnit, decimals)
              : null
            return (
            <div key={i} className="space-y-1">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                <input type="number" min="1"
                  value={tier.minUnits}
                  onChange={e => updateTier(i, 'minUnits', e.target.value)}
                  placeholder="10"
                  className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
                  style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
                />
                <input type="number" min="0.000001" max="5" step="0.01"
                  value={tier.pricePerUnit}
                  onChange={e => updateTier(i, 'pricePerUnit', e.target.value)}
                  placeholder="1.00"
                  className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
                  style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
                />
                <button onClick={() => removeTier(i)} disabled={tiers.length <= 1}
                  className="size-7 flex items-center justify-center rounded-lg disabled:opacity-20 hover:opacity-60"
                  style={{ color: 'var(--danger)' }}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              {/* Per-token rate + market deviation + "Set to market" */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1">
                {tierPPT && (
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>{tierPPT} per {symbol}</span>
                )}
                {tierPPT && mUsdPerToken !== undefined && tierPrice !== null && tokensPerUnit !== null && (() => {
                  const dev = marketDeviation(tierPrice, tokensPerUnit, decimals, mUsdPerToken)
                  if (!dev) return null
                  const c = dev.severity === 'red' ? 'var(--danger)' : 'var(--warn, #b45309)'
                  return <span className="text-xs" style={{ color: c }}>({dev.label})</span>
                })()}
                {marketPricePerUnit && (
                  <button
                    onClick={() => updateTier(i, 'pricePerUnit', marketPricePerUnit)}
                    className="text-xs underline-offset-2 underline transition-opacity hover:opacity-60"
                    style={{ color: 'var(--accent)' }}>
                    Set to market
                  </button>
                )}
              </div>
            </div>
            )
          })}
        </div>

        {/* Curve chart */}
        {chartPoints.length >= 2 && (
          <div className="mt-3 rounded-xl overflow-hidden"
            style={{ background: 'var(--surface-muted)' }}>
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
          <div className="rounded-xl p-3 space-y-1"
            style={{ background: 'var(--surface-muted)' }}>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>At {effectiveMaxUnitsNum || '?'} units sold</p>
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
      <div className="rounded-3xl p-5 space-y-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold tracking-wide uppercase"
          style={{ color: 'var(--muted)' }}>Parameters</span>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Stock (max units)</span>
            <input type="number" min="1"
              value={stockEdited ? maxUnits : String(effectiveMaxUnitsNum)}
              onChange={e => { setStockEdited(true); setMaxUnits(e.target.value) }}
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }} />
            {/* Deposit line — computed from same tokensPerUnit sent on chain */}
            {stockDisplay !== null && symbol && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                = {stockDisplay} {symbol} deposited
              </span>
            )}
            {/* Over-budget note — calm, next to the field, not a red banner at the top */}
            {overBudget && !balanceIsZero && tokensPerUnit !== null && (
              <span className="flex items-start gap-1 text-xs mt-0.5"
                style={{ color: 'var(--warn, #b45309)' }}>
                <Info className="size-3 shrink-0 mt-0.5" />
                Your balance covers up to {maxAffordable} unit{maxAffordable === 1 ? '' : 's'} at{' '}
                {formatTokenAmount(tokensPerUnit, decimals)} {symbol} each.
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
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Duration</span>
            <input type="number" min="0.0001" step="any"
              value={durationHours}
              onChange={e => setDurationHours(e.target.value)}
              placeholder="72"
              className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }} />
            {durationLabel && (
              <span className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{durationLabel}</span>
            )}
          </label>
        </div>
      </div>

      {/* ── Errors ─────────────────────────────────────────────────────── */}
      {validationErr && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5"
          style={{ background: 'rgba(186,43,76,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <p className="text-sm" style={{ color: 'var(--danger)' }}>{validationErr}</p>
        </div>
      )}
      {postReverted && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5"
          style={{ background: 'rgba(186,43,76,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            The post transaction was mined but failed, so no deal was created and your tokens did not move.{' '}
            {postTxHash && <a href={txUrl(postTxHash)} target="_blank" rel="noreferrer" className="underline">See it on the explorer</a>}
          </p>
        </div>
      )}
      {postSlow && !postReceiptArrived && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5"
          style={{ background: 'rgba(255,160,0,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--warn, #b45309)' }} />
          <p className="text-sm" style={{ color: 'var(--warn, #b45309)' }}>
            Still not confirmed after a minute. Check the transaction in your wallet — if it shows as dropped or failed, press Post deal again.
          </p>
        </div>
      )}
      {errMsg && (
        <div className="rounded-2xl p-3 flex items-start gap-2.5"
          style={{ background: 'rgba(186,43,76,0.08)' }}>
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
              <button onClick={() => onDealPosted(parsedDealId)}
                className="text-xs font-semibold ml-auto" style={{ color: 'var(--accent)' }}>
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
          <button onClick={handlePost} disabled={postBusy}
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
          <button onClick={handleApprove}
            disabled={busy || !!tokensPerUnitErr || overBudget || balanceIsZero}
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
        </div>{/* end left col */}

        {/* Right: sticky preview */}
        <div className="hidden lg:block lg:sticky lg:top-20">
          {previewPanel}
        </div>
      </div>{/* end grid */}
    </div>
  )
}
