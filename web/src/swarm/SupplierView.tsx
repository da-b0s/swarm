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
import { parseUnits, isAddress } from 'viem'
import { ConnectKitButton } from 'connectkit'
import { motion } from 'framer-motion'
import { Plus, Trash2, Loader2, ExternalLink, AlertCircle, CheckCircle2, Info, ChevronDown, Check } from 'lucide-react'
import { DEAL_FACTORY_ABI, ERC20_ABI } from './abis'
import { CONTRACTS_ACTIVE, ARC_NETWORK, MAX_CAP, MAX_TIERS, MAX_PRICE_USDC, ARC_TX_FEES, GOODS_TOKENS, POLL_MY_ORDER } from './config'
import type { GoodsToken } from './config'
import { useChainNow } from './hooks'
import { formatUsdcPrice, txUrl, parseRevertReason, computePriceAt, formatTokenAmount, pricePerToken, marketDeviation } from './utils'
import { useMarketRates } from './useMarketRates'

const CHAIN_ID = ARC_NETWORK.chainId
const USDC     = ARC_NETWORK.usdc.address

// ── Types ─────────────────────────────────────────────────────────────────────

/** A token the seller entered by address that is not in GOODS_TOKENS. */
interface CustomToken extends GoodsToken {
  unverified: true
}

type AnyToken = GoodsToken | CustomToken

function isCustomToken(t: AnyToken): t is CustomToken {
  return (t as CustomToken).unverified === true
}

interface TierInput { minUnits: string; pricePerUnit: string }

type PostStep = 'idle' | 'approving' | 'approved' | 'posting' | 'done'

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default tiers: unit thresholds pre-filled, prices left blank for the seller to choose. */
function defaultTiers(): TierInput[] {
  return [
    { minUnits: '1',  pricePerUnit: '' },
    { minUnits: '25', pricePerUnit: '' },
    { minUnits: '50', pricePerUnit: '' },
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

/**
 * Given a token's decimals and its current USD market rate, suggest the
 * largest "round amount" (from a fixed candidate list) whose value is at most $5.
 * Returns the suggestion as a human-readable string (e.g. "0.001").
 * Returns "1" when the market rate is unknown or the token value ≤ $5 already.
 */
const UNIT_CANDIDATES = [
  1, 0.5, 0.1, 0.05, 0.01, 0.005, 0.001, 0.0005, 0.0001,
  0.00005, 0.00001, 0.000005, 0.000001,
]

function suggestTokensPerUnit(decimals: number, usdPerToken: number | undefined): string {
  if (usdPerToken === undefined || usdPerToken <= 0) return '1'
  // If one whole token is already ≤ $5, use 1.
  if (usdPerToken <= 5) return '1'
  // Find the largest candidate that fits within $5 and respects decimals.
  for (const c of UNIT_CANDIDATES) {
    if (usdPerToken * c <= 5) {
      // Check it has no more decimal places than the token allows.
      const decimalPlaces = c.toString().split('.')[1]?.length ?? 0
      if (decimalPlaces <= decimals) return c.toString()
    }
  }
  return UNIT_CANDIDATES[UNIT_CANDIDATES.length - 1].toString()
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
    if (!Number.isFinite(pr) || pr <= 0) return tiers[i].pricePerUnit === ''
      ? 'Set a price for every tier.'
      : `Tier ${i + 1}: price must be greater than zero.`
    if (BigInt(Math.round(pr * 1_000_000)) > MAX_PRICE_USDC) return `Tier ${i + 1}: price exceeds the $5 cap. One unit would cost more than $5. Use a smaller unit, for example ${suggestTokensPerUnit(inp.tokenDecimals, pr)} tokens per unit.`
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
  selected:   AnyToken
  onSelect:   (t: AnyToken) => void
  /** balances keyed by token address (lower-cased), raw base units */
  balances:   Map<string, bigint>
  walletAddr: `0x${string}` | undefined
}

type CustomState = 'idle' | 'loading' | 'error' | 'ok'

function TokenPickerDropdown({ selected, onSelect, balances, walletAddr }: TokenPickerProps) {
  const [open,        setOpen]        = useState(false)
  const [showOther,   setShowOther]   = useState(() => isCustomToken(selected))
  const [addrInput,   setAddrInput]   = useState(() => isCustomToken(selected) ? selected.address : '')
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

  // Keyboard nav (listed tokens only; Other is separate)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = GOODS_TOKENS.findIndex(t => t.address.toLowerCase() === selected.address.toLowerCase())
    if (e.key === 'Escape') { setOpen(false); return }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); return }
    if (!open || showOther) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      onSelect(GOODS_TOKENS[(idx + 1) % GOODS_TOKENS.length])
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      onSelect(GOODS_TOKENS[(idx - 1 + GOODS_TOKENS.length) % GOODS_TOKENS.length])
    }
  }

  // Validate the entered address and read token metadata
  const normalAddr = isAddress(addrInput) ? addrInput : undefined
  const customCalls = useMemo(() => {
    if (!normalAddr) return []
    const zero = '0x0000000000000000000000000000000000000000' as `0x${string}`
    return [
      { address: normalAddr, abi: ERC20_ABI, functionName: 'symbol'   as const, chainId: CHAIN_ID },
      { address: normalAddr, abi: ERC20_ABI, functionName: 'name'     as const, chainId: CHAIN_ID },
      { address: normalAddr, abi: ERC20_ABI, functionName: 'decimals' as const, chainId: CHAIN_ID },
      { address: normalAddr, abi: ERC20_ABI, functionName: 'balanceOf' as const,
        args: [walletAddr ?? zero] as [`0x${string}`], chainId: CHAIN_ID },
    ]
  }, [normalAddr, walletAddr])

  const { data: customData, isLoading: customLoading } = useReadContracts({
    contracts: customCalls,
    query: { enabled: customCalls.length > 0 && showOther, staleTime: 30_000 },
  })

  // Derive custom token state
  const customState: CustomState = useMemo(() => {
    if (!showOther || !normalAddr) return 'idle'
    if (customLoading || !customData) return 'loading'
    const [sym, , dec] = customData
    if (sym?.status !== 'success' || dec?.status !== 'success') return 'error'
    const d = Number(dec.result)
    if (!Number.isFinite(d) || d > 36) return 'error'
    return 'ok'
  }, [showOther, normalAddr, customLoading, customData])

  // Build resolved custom token
  const resolvedCustom: AnyToken | null = useMemo(() => {
    if (customState !== 'ok' || !normalAddr || !customData) return null
    const [symR, nameR, decR, _balR] = customData
    const sym = symR?.status === 'success' ? String(symR.result) : '?'
    const name = nameR?.status === 'success' ? String(nameR.result) : sym
    const dec  = decR?.status  === 'success' ? Number(decR.result)  : 18
    // If address matches a listed token, return that instead
    const listed = GOODS_TOKENS.find(t => t.address.toLowerCase() === normalAddr.toLowerCase())
    if (listed) return listed
    // Custom unverified token
    const custom: CustomToken = {
      address: normalAddr, symbol: sym, name, decimals: dec, unverified: true,
    }
    return custom
  }, [customState, normalAddr, customData])

  // When the resolved token changes, propagate to parent
  useEffect(() => {
    if (resolvedCustom !== null) {
      onSelect(resolvedCustom)
      // If it turned out to be a listed token, exit "other" mode
      if (!isCustomToken(resolvedCustom)) setShowOther(false)
    }
  // onSelect is stable via useCallback in parent
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedCustom])

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
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
            {isCustomToken(selected) ? `${selected.symbol} (custom)` : selected.symbol}
          </span>
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
            const isSelected = !isCustomToken(selected) && tok.address.toLowerCase() === selected.address.toLowerCase()
            const bal = balances.get(tok.address.toLowerCase())
            const balDisplay = bal !== undefined ? formatTokenAmount(bal, tok.decimals) : undefined
            return (
              <li key={tok.address} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => { onSelect(tok); setShowOther(false); setOpen(false) }}
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

          {/* Other token option */}
          <li role="option" aria-selected={showOther}>
            <button
              type="button"
              onClick={() => { setShowOther(true); setOpen(false) }}
              className="w-full flex items-center gap-3 rounded-xl px-4 py-2.5 text-left transition-all hover:scale-[1.005]"
              style={{
                background: showOther ? 'color-mix(in srgb, var(--warn, #b45309) 8%, transparent)' : 'var(--surface-muted)',
                border: `1px solid ${showOther ? 'var(--warn, #b45309)' : 'var(--border)'}`,
              }}
            >
              <span className="size-3.5 shrink-0" />
              <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Other token…</span>
            </button>
          </li>
        </ul>
      )}

      {/* Address input for custom token */}
      {showOther && (
        <div className="space-y-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>Token contract address</span>
            <input
              type="text"
              value={addrInput}
              onChange={e => setAddrInput(e.target.value.trim())}
              placeholder="0x…"
              spellCheck={false}
              className="rounded-xl px-3 py-2 text-sm mono outline-none transition-colors"
              style={{
                background: 'var(--surface-muted)',
                border: `1px solid ${addrInput && !normalAddr ? 'var(--danger)' : 'var(--border)'}`,
                color: 'var(--ink)',
              }}
            />
          </label>
          {addrInput && !normalAddr && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>Enter a valid 0x address.</p>
          )}
          {customState === 'loading' && (
            <p className="text-xs flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
              <Loader2 className="size-3 animate-spin" /> Reading token…
            </p>
          )}
          {customState === 'error' && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              This address isn&apos;t a standard token on Arc.
            </p>
          )}
          {customState === 'ok' && resolvedCustom && isCustomToken(resolvedCustom) && (
            <p className="text-xs" style={{ color: 'var(--success)' }}>
              Resolved: {resolvedCustom.symbol} · {resolvedCustom.decimals} decimals
            </p>
          )}
        </div>
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
  const [selectedToken,    setSelectedToken]    = useState<AnyToken>(GOODS_TOKENS[0])
  const [tokensPerUnitStr, setTokensPerUnitStr] = useState('1')
  // Whether the seller manually edited the tokensPerUnit field.
  const tpuEditedRef = useRef(false)
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

  // Track whether the seller has manually edited any tier threshold yet.
  // While false, thresholds stay spread across the current stock automatically.
  const tiersEditedRef = useRef(false)

  // ── Two-step state ───────────────────────────────────────────────────────
  const [step,          setStep]          = useState<PostStep>('idle')
  const [validationErr, setValidationErr] = useState<string | null>(null)
  const [errMsg,        setErrMsg]        = useState('')
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>()
  const [postTxHash,    setPostTxHash]    = useState<`0x${string}` | undefined>()

  // ── Auto-suggest tokensPerUnit when token or market rate changes ─────────
  // Only updates if the seller has not manually edited the field.
  const mSymForEffect = (selectedToken).marketSymbol
  const mRateForEffect = mSymForEffect ? marketRates?.get(mSymForEffect) : undefined
  useEffect(() => {
    if (tpuEditedRef.current) return
    const suggestion = suggestTokensPerUnit(selectedToken.decimals, mRateForEffect)
    setTokensPerUnitStr(suggestion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedToken.address, mRateForEffect])

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

  // For a custom (unlisted) token, read its balance separately.
  const customTokenAddr = isCustomToken(selectedToken) ? selectedToken.address : undefined
  const { data: customBalRaw } = useReadContracts({
    contracts: customTokenAddr && address ? [{
      address: customTokenAddr,
      abi: ERC20_ABI,
      functionName: 'balanceOf' as const,
      args: [address] as [`0x${string}`],
      chainId: CHAIN_ID,
    }] : [],
    query: { enabled: !!(customTokenAddr && address), refetchInterval: POLL_MY_ORDER, refetchIntervalInBackground: false },
  })
  const customBalance: bigint | undefined = customBalRaw?.[0]?.status === 'success'
    ? BigInt(String(customBalRaw[0].result))
    : undefined

  // Merge custom balance into the map passed to the picker.
  const allBalancesWithCustom: Map<string, bigint> = useMemo(() => {
    const m = new Map(allBalances)
    if (customTokenAddr && customBalance !== undefined) {
      m.set(customTokenAddr.toLowerCase(), customBalance)
    }
    return m
  }, [allBalances, customTokenAddr, customBalance])

  const tokenBalance = customTokenAddr
    ? customBalance
    : allBalances.get(goodsAddr.toLowerCase())

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

  // ── Auto-adjust tier thresholds when stock changes ───────────────────────
  // Spreads thresholds evenly across the current stock.
  // Only runs while the seller has not manually edited any threshold field.
  useEffect(() => {
    if (tiersEditedRef.current) return
    const stock = effectiveMaxUnitsNum
    if (stock < 1) return
    setTiers(prev => {
      const count = prev.length
      if (count === 0) return prev
      const raw: number[] = count === 1
        ? [1]
        : Array.from({ length: count }, (_, i) =>
            i === 0 ? 1 : i === count - 1 ? stock : Math.ceil(stock * i / (count - 1))
          )
      // Deduplicate while preserving order; fewer unique values means a smaller tier set
      // (e.g. stock=1 yields only [1], stock=2 with 3 tiers yields [1, 2]).
      const unique = [...new Set(raw)]
      return unique.map((v, j) => ({
        ...prev[j] ?? { pricePerUnit: '' },
        minUnits: String(v),
      }))
    })
  // effectiveMaxUnitsNum is derived during render — it is safe in the dep array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveMaxUnitsNum])

  // ── Per-token price mode ─────────────────────────────────────────────────
  // When tokensPerUnit is not exactly 1 whole token, sellers enter prices per
  // whole token and we convert to per-unit for the contract.
  const oneWholeToken = decimals <= 77 ? 10n ** BigInt(decimals) : null
  const isMultiUnit   = tokensPerUnit !== null && oneWholeToken !== null && tokensPerUnit !== oneWholeToken

  /**
   * Convert a per-token price string to a per-unit price bigint (micro-USDC),
   * rounded down. Returns null if the input is invalid.
   */
  const perTokenToPerUnit = (perTokenStr: string): bigint | null => {
    if (!isMultiUnit || tokensPerUnit === null || oneWholeToken === null) {
      return parsePriceToMicro(perTokenStr)
    }
    const perToken = parseFloat(perTokenStr)
    if (!Number.isFinite(perToken) || perToken <= 0) return null
    // perUnit = perToken × (tokensPerUnit / 10^decimals)
    const scale = Number(oneWholeToken)
    const perUnit = perToken * (Number(tokensPerUnit) / scale)
    if (!Number.isFinite(perUnit) || perUnit <= 0) return null
    return BigInt(Math.floor(perUnit * 1_000_000))
  }

  // ── Tier chart ───────────────────────────────────────────────────────────
  const parsedTiers = tiers.map(t => ({
    minUnits:     parseInt(t.minUnits) || 0,
    pricePerUnit: (isMultiUnit ? perTokenToPerUnit(t.pricePerUnit) : parsePriceToMicro(t.pricePerUnit)) ?? 0n,
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
   * Compute the "market price to fill" string:
   * - In single-unit mode (1 unit = 1 token): price per unit = price per token.
   * - In multi-unit mode: price per whole token (what the seller enters).
   * Rounded to 2 dp (4 dp when < $1).
   */
  const marketPricePerUnit = useMemo((): string | null => {
    if (mUsdPerToken === undefined) return null
    if (isMultiUnit) {
      // Seller enters price per whole token; market price is simply mUsdPerToken.
      if (mUsdPerToken <= 0) return null
      const dp = mUsdPerToken < 1 ? 4 : 2
      return mUsdPerToken.toFixed(dp)
    }
    if (!tokensPerUnit || tokensPerUnit === 0n) return null
    const scale = 10 ** decimals
    const tokensWhole = Number(tokensPerUnit) / scale
    const usdPerUnit  = mUsdPerToken * tokensWhole
    if (usdPerUnit <= 0) return null
    const dp = usdPerUnit < 1 ? 4 : 2
    return usdPerUnit.toFixed(dp)
  }, [mUsdPerToken, tokensPerUnit, decimals, isMultiUnit])

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
  const addTier = () => {
    if (tiers.length >= MAX_TIERS) return
    tiersEditedRef.current = true
    setTiers(prev => {
      const lastMin = parseInt(prev[prev.length - 1]?.minUnits ?? '0') || 0
      const stock   = effectiveMaxUnitsNum
      // Propose midpoint between last threshold and stock; if no room, leave blank.
      const proposed = lastMin < stock ? Math.ceil((lastMin + stock) / 2) : null
      return [...prev, { minUnits: proposed !== null ? String(proposed) : '', pricePerUnit: '' }]
    })
  }
  const removeTier = (i: number) => {
    tiersEditedRef.current = true
    setTiers(t => t.filter((_, j) => j !== i))
  }
  const updateTier = (i: number, field: keyof TierInput, val: string) => {
    if (field === 'minUnits') tiersEditedRef.current = true
    setTiers(t => t.map((tier, j) => j === i ? { ...tier, [field]: val } : tier))
  }

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

  // Convert tier price strings to per-unit strings for validation (multi-unit mode).
  const tiersForValidation = useMemo((): TierInput[] => {
    if (!isMultiUnit) return tiers
    return tiers.map(t => {
      const pu = perTokenToPerUnit(t.pricePerUnit)
      return { ...t, pricePerUnit: pu !== null ? (Number(pu) / 1_000_000).toFixed(6) : t.pricePerUnit }
    })
  // perTokenToPerUnit is a stable closure derived from component state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiers, isMultiUnit, tokensPerUnit, decimals])

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
      tiers: tiersForValidation, minUnits, maxUnits: String(effectiveMaxUnitsNum), maxUnitsPerBuyer, maxBuyers,
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
    tiersForValidation, minUnits, effectiveMaxUnitsNum, maxUnitsPerBuyer, maxBuyers,
    durationHours, title, description, chainNow,
    overBudget, maxAffordable, symbol, writeContract,
  ])

  // ── Step 2: Post deal ────────────────────────────────────────────────────
  const handlePost = useCallback(() => {
    setErrMsg('')
    if (tokensPerUnit === null) { setValidationErr(tokensPerUnitErr ?? `Invalid ${symbol} per unit.`); return }
    const inp: PostInputs = {
      goodsToken: goodsAddr, tokensPerUnit, tokenDecimals: decimals,
      tiers: tiersForValidation, minUnits, maxUnits: String(effectiveMaxUnitsNum), maxUnitsPerBuyer, maxBuyers,
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
    tiersForValidation, minUnits, effectiveMaxUnitsNum, maxUnitsPerBuyer, maxBuyers,
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
        onSelect={t => { setSelectedToken(t); setStockEdited(false); tpuEditedRef.current = false; tiersEditedRef.current = false }}
        balances={allBalancesWithCustom}
        walletAddr={address}
      />

      {/* Unverified custom token warning */}
      {isCustomToken(selectedToken) && (
        <div className="rounded-2xl px-3 py-2.5 flex items-start gap-2.5"
          style={{ background: 'rgba(180,83,9,0.07)', border: '1px solid rgba(180,83,9,0.2)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--warn, #b45309)' }} />
          <p className="text-xs" style={{ color: 'var(--warn, #b45309)' }}>
            Unverified token. Check the address is the one you mean.
            Tokens that take a fee on transfer or change balances on their own will not work with Swarm.
          </p>
        </div>
      )}

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
            onChange={e => { tpuEditedRef.current = true; setTokensPerUnitStr(e.target.value) }}
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
            {(() => {
              const lastMin  = parseInt(tiers[tiers.length - 1]?.minUnits ?? '0') || 0
              const atCap    = tiers.length >= MAX_TIERS
              const lastAtStock = lastMin >= effectiveMaxUnitsNum && effectiveMaxUnitsNum > 0
              const disabledAdd = atCap || lastAtStock
              return (
                <button onClick={addTier} disabled={disabledAdd}
                  title={lastAtStock ? 'Raise the stock to add another tier.' : undefined}
                  className="flex items-center gap-1 text-xs font-semibold rounded-lg px-2.5 py-1 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed disabled:scale-100"
                  style={{ background: 'var(--surface-muted)', color: 'var(--accent)' }}>
                  <Plus className="size-3" />
                  {lastAtStock ? 'Raise stock to add tier' : 'Add tier'}
                </button>
              )
            })()}
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
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>
            {isMultiUnit ? `Price per ${symbol} (USDC)` : 'Price/unit (USDC)'}
          </span>
          <span className="w-7" />
        </div>
        <div className="space-y-2">
          {tiers.map((tier, i) => {
            // In multi-unit mode the input is per-token; compute per-unit for display.
            const tierPricePerUnit = isMultiUnit
              ? perTokenToPerUnit(tier.pricePerUnit)
              : parsePriceToMicro(tier.pricePerUnit)
            const tierPriceAsPerToken = isMultiUnit
              ? parsePriceToMicro(tier.pricePerUnit)  // raw per-token micro
              : tierPricePerUnit
            const tierPPT = tierPricePerUnit !== null && tokensPerUnit !== null && !isMultiUnit
              ? pricePerToken(tierPricePerUnit, tokensPerUnit, decimals)
              : null

            // Threshold-specific helpers
            const tierMinNum = parseInt(tier.minUnits) || 0
            const overStock  = tierMinNum > 0 && effectiveMaxUnitsNum > 0 && tierMinNum > effectiveMaxUnitsNum
            // Token amount this threshold represents (skip when 1 unit = 1 whole token)
            const thresholdTokenAmt = !overStock && tierMinNum > 0 && tokensPerUnit !== null && isMultiUnit
              ? formatTokenAmount(BigInt(tierMinNum) * tokensPerUnit, decimals)
              : null

            return (
            <div key={i} className="space-y-1">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-start">
                {/* Threshold column */}
                <div className="flex flex-col gap-0.5">
                  <input type="number" min="1"
                    value={tier.minUnits}
                    onChange={e => updateTier(i, 'minUnits', e.target.value)}
                    placeholder="10"
                    className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
                    style={{
                      background: 'var(--surface-muted)',
                      border: `1px solid ${overStock ? 'var(--danger)' : 'var(--border)'}`,
                      color: 'var(--ink)',
                    }}
                  />
                  {overStock ? (
                    <span className="text-xs leading-snug" style={{ color: 'var(--danger)' }}>
                      Starts at {tier.minUnits} units but stock is {effectiveMaxUnitsNum}. Lower it or raise the stock.
                    </span>
                  ) : thresholdTokenAmt !== null ? (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      = {thresholdTokenAmt} {symbol}
                    </span>
                  ) : null}
                </div>

                {/* Price column */}
                <div className="flex flex-col gap-0.5">
                  <input type="number" min="0.000001" step="0.0001"
                    value={tier.pricePerUnit}
                    onChange={e => updateTier(i, 'pricePerUnit', e.target.value)}
                    placeholder={isMultiUnit ? `e.g. ${mUsdPerToken ? mUsdPerToken.toFixed(2) : '2200'}` : 'e.g. 1.12'}
                    className="rounded-xl px-3 py-2 text-sm tabular-nums outline-none"
                    style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', color: 'var(--ink)' }}
                  />
                  {/* Helpers: per-unit equivalent, deviation badge, Set to market */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {isMultiUnit && tierPricePerUnit !== null && (
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>
                        = {formatUsdcPrice(tierPricePerUnit)}/unit
                      </span>
                    )}
                    {!isMultiUnit && tierPPT && (
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>{tierPPT} per {symbol}</span>
                    )}
                    {mUsdPerToken !== undefined && tierPriceAsPerToken !== null && tokensPerUnit !== null && (() => {
                      const refPrice = isMultiUnit ? tierPriceAsPerToken : tierPricePerUnit
                      if (refPrice === null) return null
                      const refTpu = isMultiUnit ? oneWholeToken ?? tokensPerUnit : tokensPerUnit
                      const dev = marketDeviation(refPrice, refTpu, decimals, mUsdPerToken)
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

                <button onClick={() => removeTier(i)} disabled={tiers.length <= 1}
                  className="size-7 flex items-center justify-center rounded-lg disabled:opacity-20 hover:opacity-60 mt-1"
                  style={{ color: 'var(--danger)' }}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
            )
          })}
        </div>

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
            disabled={busy || !!tokensPerUnitErr || overBudget || balanceIsZero ||
              tiers.some(t => { const n = parseInt(t.minUnits); return n > 0 && effectiveMaxUnitsNum > 0 && n > effectiveMaxUnitsNum })}
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
