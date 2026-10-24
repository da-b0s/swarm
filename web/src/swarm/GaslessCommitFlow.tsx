/**
 * GaslessCommitFlow v2 — buyer signs once for N units, relayer submits and pays gas.
 *
 * Signs ReceiveWithAuthorization for `priceAt(totalUnits + units) × units` USDC.
 * The nonce binds pool, dealId, buyer, units and salt — a relayer cannot change
 * the quantity a signature covers.
 *
 * On 409: price rose above authorization; show the new total and ask to sign again.
 * On excess: price fell after signing; the relayer returns the credited amount.
 */

import { useState, useCallback } from 'react'
import { useAccount, useSignTypedData, useSwitchChain, useReadContract } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, ExternalLink, CheckCircle, AlertCircle, Zap, Plus, Minus } from 'lucide-react'
import { formatUsdcPrice, txUrl, computeOrderTotal } from './utils'
import { ARC_NETWORK, CONTRACTS_ACTIVE, RELAYER_URL } from './config'
import { DEMAND_POOL_ABI } from './abis'
import { useChainNow } from './hooks'
import type { DealTier } from './hooks'

interface Props {
  dealId:           bigint
  clearingPrice:    bigint
  totalUnits:       number
  tiers:            DealTier[]
  maxUnits:         number
  maxUnitsPerBuyer: number
  deadline:         bigint
  state:            number
  goodsToken:       `0x${string}`
  goodsSymbol:      string
  tokensPerUnit:    bigint
  onCommitted:      () => void
  onFallback:       () => void
}

type GaslessStep = 'idle' | 'signing' | 'submitting' | 'done' | 'error'

const CHAIN_ID = ARC_NETWORK.chainId
const VALIDITY_WINDOW_SEC = 600

const RECEIVE_WITH_AUTH_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
} as const

function randomSalt(): `0x${string}` {
  const arr = crypto.getRandomValues(new Uint8Array(32))
  return ('0x' + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

export function GaslessCommitFlow({
  dealId, clearingPrice: _clearingPrice, totalUnits, tiers, maxUnits, maxUnitsPerBuyer,
  deadline, state, goodsToken: _goodsToken, goodsSymbol, tokensPerUnit,
  onCommitted, onFallback,
}: Props) {
  const { address, isConnected, chainId: walletChain } = useAccount()
  const { switchChain }   = useSwitchChain()
  const { signTypedData } = useSignTypedData()
  const nowSec = useChainNow()

  const isPastDeadline = nowSec > 0 && Number(deadline) <= nowSec
  const isOpen         = state === 0
  const wrongChain     = isConnected && walletChain !== CHAIN_ID

  // Quantity picker — clamp during render, never in an effect
  const remainingStock = maxUnits - totalUnits
  const perBuyerLimit  = maxUnitsPerBuyer > 0 ? maxUnitsPerBuyer : remainingStock
  const maxOrderable   = Math.min(remainingStock, perBuyerLimit)
  const [rawUnits, setUnits] = useState(1)
  const units = maxOrderable > 0 ? Math.min(rawUnits, maxOrderable) : 1

  const [salt, setSalt] = useState<`0x${string}`>(() => randomSalt())

  // What the buyer will pay (includes their own units)
  const { paidPerUnit: quotedPPU, total: quotedTotal, breaksTier } = computeOrderTotal(tiers, totalUnits, units)
  const tokensReceived = BigInt(units) * tokensPerUnit

  // On 409, show the updated total and ask to sign again
  const [signTotal, setSignTotal] = useState<bigint | null>(null)
  const totalToSign = signTotal ?? quotedTotal

  const [step,     setStep]     = useState<GaslessStep>('idle')
  const [errMsg,   setErrMsg]   = useState('')
  const [txHash,   setTxHash]   = useState<`0x${string}` | null>(null)
  const [pricePaid, setPricePaid] = useState<bigint | null>(null)
  const [excess,    setExcess]    = useState<bigint | null>(null)

  // Read authorizationNonce — v2 includes units in the nonce derivation
  const { data: nonce, refetch: refetchNonce } = useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'authorizationNonce',
    args: [
      dealId,
      address ?? '0x0000000000000000000000000000000000000000',
      units,        // bound in nonce
      salt,
    ],
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  })

  const handleSign = useCallback(async () => {
    if (!address || !isConnected || wrongChain || !nonce) return
    if (!RELAYER_URL) return

    setErrMsg('')
    setStep('signing')

    const validAfter  = 0n
    const baseNow     = nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000)
    const validBefore = BigInt(baseNow + VALIDITY_WINDOW_SEC)
    const authorizedAmount = totalToSign

    try {
      const sig = await new Promise<`0x${string}`>((resolve, reject) => {
        signTypedData(
          {
            domain: {
              name:              'USDC',
              version:           '2',
              chainId:           CHAIN_ID,
              verifyingContract: ARC_NETWORK.usdc.address,
            },
            types: RECEIVE_WITH_AUTH_TYPES,
            primaryType: 'ReceiveWithAuthorization',
            message: {
              from:        address,
              to:          CONTRACTS_ACTIVE.DemandPool,
              value:       authorizedAmount,
              validAfter,
              validBefore,
              nonce,
            },
          },
          { onSuccess: resolve, onError: reject }
        )
      })

      setStep('submitting')

      const res = await fetch(`${RELAYER_URL}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealId:           dealId.toString(),
          buyer:            address,
          units:            units,
          authorizedAmount: authorizedAmount.toString(),
          validAfter:       validAfter.toString(),
          validBefore:      validBefore.toString(),
          salt,
          signature:        sig,
        }),
      })

      const data = await res.json() as {
        txHash?:         string
        pricePaid?:      string
        excessCredited?: string
        error?:          string
        requiredPrice?:  string
      }

      if (res.status === 409 && data.requiredPrice) {
        const newTotal = BigInt(data.requiredPrice)
        setSignTotal(newTotal)
        setSalt(randomSalt())
        void refetchNonce()
        setErrMsg(
          `Price rose — order now costs ${formatUsdcPrice(newTotal)}. ` +
          `Sign again at the new total to continue.`
        )
        setStep('idle')
        return
      }

      if (!res.ok || !data.txHash) {
        setErrMsg(data.error ?? 'Relay failed — try the approve path below')
        setStep('error')
        return
      }

      setTxHash(data.txHash as `0x${string}`)
      setPricePaid(data.pricePaid      ? BigInt(data.pricePaid)      : null)
      setExcess(  data.excessCredited  ? BigInt(data.excessCredited) : null)
      setStep('done')
      onCommitted()
    } catch (e: unknown) {
      setErrMsg((e as Error).message ?? 'Signing failed')
      setStep('error')
    }
  }, [
    address, isConnected, wrongChain, nonce, nowSec,
    totalToSign, dealId, units, salt, signTypedData, refetchNonce, onCommitted,
  ])

  const reset = () => {
    setStep('idle')
    setErrMsg('')
    setSignTotal(null)
    setSalt(randomSalt())
    void refetchNonce()
  }

  if (!RELAYER_URL) return null
  if (!isOpen || isPastDeadline) return null

  if (!isConnected) {
    return (
      <div className="space-y-3">
        <GaslessPriceCard
          units={units} quotedPPU={quotedPPU} totalToSign={totalToSign}
          breaksTier={breaksTier} goodsSymbol={goodsSymbol} tokensReceived={tokensReceived}
          maxOrderable={maxOrderable} onUnits={setUnits}
        />
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button onClick={show}
              className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
              style={{ background: 'var(--accent)' }}>
              Connect wallet to order gaslessly
            </button>
          )}
        </ConnectKitButton.Custom>
      </div>
    )
  }

  if (wrongChain) {
    return (
      <button onClick={() => switchChain({ chainId: CHAIN_ID })}
        className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99]"
        style={{ background: 'var(--accent)', color: '#fff' }}>
        Switch to {ARC_NETWORK.name}
      </button>
    )
  }

  const busy = step === 'signing' || step === 'submitting'

  return (
    <div className="space-y-3">
      <AnimatePresence mode="wait">
        {step === 'done' ? (
          <motion.div key="done"
            className="rounded-2xl p-4 space-y-2"
            style={{ background: 'rgba(26,128,71,0.08)', border: '1px solid rgba(26,128,71,0.2)' }}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}>
            <div className="flex items-center gap-2">
              <CheckCircle className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--success)' }}>
                Ordered gaslessly{pricePaid !== null && ` for ${formatUsdcPrice(pricePaid)}`}
              </span>
            </div>
            {excess !== null && excess > 0n && (
              <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
                Price fell before your order landed.{' '}
                <span className="font-bold tabular-nums" style={{ color: 'var(--success)' }}>
                  {formatUsdcPrice(excess)}
                </span>{' '}
                is credited to your claimable balance — claim it after the deal settles.
              </p>
            )}
            {txHash && (
              <a href={txUrl(txHash)} target="_blank" rel="noreferrer"
                className="text-sm flex items-center gap-1" style={{ color: 'var(--success)' }}>
                View on explorer <ExternalLink className="size-3" />
              </a>
            )}
          </motion.div>
        ) : (
          <motion.div key="price"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}>
            <GaslessPriceCard
              units={units} quotedPPU={quotedPPU} totalToSign={totalToSign}
              breaksTier={breaksTier} goodsSymbol={goodsSymbol} tokensReceived={tokensReceived}
              maxOrderable={maxOrderable} onUnits={setUnits}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {busy && (
        <div className="rounded-2xl p-3 flex items-center gap-3" style={{ background: 'var(--surface-muted)' }}>
          <Loader2 className="size-4 animate-spin shrink-0" style={{ color: 'var(--accent)' }} />
          <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
            {step === 'signing' ? 'Sign in your wallet…' : 'Submitting via relayer…'}
          </span>
        </div>
      )}

      {step === 'error' && (
        <div className="rounded-2xl p-3 flex items-start gap-3" style={{ background: 'rgba(186,43,76,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm" style={{ color: 'var(--danger)' }}>{errMsg}</p>
            <button onClick={reset} className="text-xs mt-1 underline" style={{ color: 'var(--muted)' }}>
              Try again
            </button>
          </div>
        </div>
      )}

      {step === 'idle' && errMsg && (
        <div className="rounded-2xl p-3"
          style={{ background: 'rgba(255,160,0,0.08)', border: '1px solid rgba(255,160,0,0.2)' }}>
          <p className="text-sm" style={{ color: 'var(--warn, #b45309)' }}>{errMsg}</p>
        </div>
      )}

      {step !== 'done' && maxOrderable > 0 && (
        <button
          onClick={() => { void handleSign() }}
          disabled={busy || !nonce}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
          style={{ background: 'var(--accent)' }}>
          {busy
            ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Working…</span>
            : errMsg
              ? `Sign again for ${formatUsdcPrice(totalToSign)}`
              : <span className="flex items-center justify-center gap-2">
                  <Zap className="size-4" />
                  {`Order ${units} unit${units !== 1 ? 's' : ''} gaslessly for ${formatUsdcPrice(totalToSign)}`}
                </span>}
        </button>
      )}

      <button onClick={onFallback}
        className="w-full text-xs py-1 opacity-40 hover:opacity-70 transition-opacity"
        style={{ color: 'var(--muted)' }}>
        Use approve-then-commit instead
      </button>
    </div>
  )
}

// ── Gasless price card ────────────────────────────────────────────────────────

interface GaslessPriceCardProps {
  units:          number
  quotedPPU:      bigint
  totalToSign:    bigint
  breaksTier:     boolean
  goodsSymbol:    string
  tokensReceived: bigint
  maxOrderable:   number
  onUnits:        (n: number) => void
}

function GaslessPriceCard({
  units, quotedPPU, totalToSign, breaksTier,
  goodsSymbol, tokensReceived, maxOrderable, onUnits,
}: GaslessPriceCardProps) {
  return (
    <div className="rounded-2xl p-4 space-y-3"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <Zap className="size-3.5" style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>Gasless order</span>
      </div>

      {/* Quantity picker */}
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--muted)' }}>Quantity</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onUnits(Math.max(1, units - 1))}
            disabled={units <= 1}
            className="size-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-30"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
            <Minus className="size-3.5" />
          </button>
          <span className="display text-xl font-bold tabular-nums w-10 text-center"
            style={{ color: 'var(--ink)' }}>{units}</span>
          <button
            onClick={() => onUnits(Math.min(maxOrderable, units + 1))}
            disabled={units >= maxOrderable}
            className="size-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-30"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-baseline justify-between">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {formatUsdcPrice(quotedPPU)}/unit
          </span>
          <span className="display text-2xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
            {formatUsdcPrice(totalToSign)}
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--subtle)' }}>
          You'll receive {tokensReceived.toString()} {goodsSymbol} · Sign once, no gas prompt
        </p>
        {breaksTier && (
          <p className="text-xs mt-1 font-medium" style={{ color: 'var(--accent)' }}>
            Your order unlocks this price for everyone.
          </p>
        )}
      </div>
    </div>
  )
}
