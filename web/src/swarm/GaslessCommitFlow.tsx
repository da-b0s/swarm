/**
 * GaslessCommitFlow — buyer signs once, relayer submits and pays gas.
 *
 * The buyer signs a ReceiveWithAuthorization EIP-712 message for
 * `authorizedAmount` USDC to the DemandPool. The relayer simulates,
 * screens, and relays the commitWithAuthorization call.
 *
 * Domain: { name: "USDC", version: "2", chainId, verifyingContract: 0x3600… }
 * chainId comes from the active network config — never a constant.
 *
 * Price-rose (409): the relayer returns the required price; we show it and
 * let the buyer sign again at the new price. Never an unexplained failure.
 *
 * Excess credited: if the price fell between signing and landing, the
 * relayer returns excessCredited from the receipt, which we show as a
 * claim note.
 */

import { useState, useCallback } from 'react'
import { useAccount, useSignTypedData, useSwitchChain, useReadContract } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, ExternalLink, CheckCircle, AlertCircle, Zap } from 'lucide-react'
import { formatUsdcPrice, txUrl } from './utils'
import { ARC_NETWORK, CONTRACTS_ACTIVE, RELAYER_URL } from './config'
import { DEMAND_POOL_ABI } from './abis'
import { useChainNow } from './hooks'

interface Props {
  dealId: bigint
  clearingPrice: bigint
  deadline: bigint
  state: number
  onCommitted: () => void
  onFallback: () => void   // user chose the approve-then-commit path
}

type GaslessStep =
  | 'idle'
  | 'signing'
  | 'submitting'
  | 'done'
  | 'error'

const CHAIN_ID = ARC_NETWORK.chainId

// Validity window for the authorization: 10 minutes from now.
const VALIDITY_WINDOW_SEC = 600

// ReceiveWithAuthorization EIP-712 types (from the USDC FiatTokenV2.2 spec).
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
  dealId, clearingPrice, deadline, state, onCommitted, onFallback,
}: Props) {
  const { address, isConnected, chainId: walletChain } = useAccount()
  const { switchChain } = useSwitchChain()
  const { signTypedData } = useSignTypedData()
  const nowSec = useChainNow()

  const isPastDeadline = nowSec > 0 && Number(deadline) <= nowSec
  const isOpen = state === 0
  const wrongChain = isConnected && walletChain !== CHAIN_ID

  // The price we'll sign for. Can be updated if a 409 raises it.
  const [signPrice, setSignPrice] = useState<bigint | null>(null)
  const priceToSign = signPrice ?? clearingPrice

  const [step, setStep]   = useState<GaslessStep>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null)
  const [pricePaid, setPricePaid] = useState<bigint | null>(null)
  const [excess, setExcess]       = useState<bigint | null>(null)
  const [salt, setSalt] = useState<`0x${string}`>(() => randomSalt())

  // Read authorizationNonce from the pool (view call, no wallet needed).
  const { data: nonce, refetch: refetchNonce } = useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'authorizationNonce',
    args: [dealId, address ?? '0x0000000000000000000000000000000000000000', salt],
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  })

  const handleSign = useCallback(async () => {
    if (!address || !isConnected || wrongChain || !nonce) return
    if (!RELAYER_URL) return

    setErrMsg('')
    setStep('signing')

    const validAfter  = 0n
    // validBefore: chain time + 10 min. useChainNow() may return 0 until the
    // first block arrives; fall back to local time for the initial render.
    const baseNow = nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000)
    const validBefore = BigInt(baseNow + VALIDITY_WINDOW_SEC)

    // Sign for the live price the buyer will actually pay: clearingPrice at
    // count+1. The contract charges at most this amount; if another commit
    // breaks a tier first the difference is credited back. If a withdrawal
    // pushed the price up, the relayer returns 409 and we re-sign at the
    // new price via the errMsg path already in place.
    const authorizedAmount = priceToSign

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
          authorizedAmount: authorizedAmount.toString(),
          validAfter:       validAfter.toString(),
          validBefore:      validBefore.toString(),
          salt,
          signature:        sig,
        }),
      })

      const data = await res.json() as {
        txHash?: string
        pricePaid?: string
        excessCredited?: string
        error?: string
        requiredPrice?: string
      }

      if (res.status === 409 && data.requiredPrice) {
        // Price rose above what we authorised. Show the new price and ask
        // the buyer to sign again with a fresh salt and the new price.
        const newPrice = BigInt(data.requiredPrice)
        setSignPrice(newPrice)
        setSalt(randomSalt())
        void refetchNonce()
        setErrMsg(
          `Price rose to ${formatUsdcPrice(newPrice)} before your commit landed. ` +
          `Sign again at the new price to continue.`
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
      setPricePaid(data.pricePaid ? BigInt(data.pricePaid) : null)
      setExcess(data.excessCredited ? BigInt(data.excessCredited) : null)
      setStep('done')
      onCommitted()
    } catch (e: unknown) {
      setErrMsg((e as Error).message ?? 'Signing failed')
      setStep('error')
    }
  }, [address, isConnected, wrongChain, nonce, nowSec, priceToSign, dealId, salt, signTypedData, refetchNonce, onCommitted])

  const reset = () => {
    setStep('idle')
    setErrMsg('')
    setSignPrice(null)
    setSalt(randomSalt())
    void refetchNonce()
  }

  // ── Guards ───────────────────────────────────────────────────────────────────

  if (!RELAYER_URL) return null

  if (!isOpen || isPastDeadline) return null

  if (!isConnected) {
    return (
      <div className="space-y-3">
        <div className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 mb-1">
            <Zap className="size-3.5" style={{ color: 'var(--accent)' }} />
            <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>Gasless commit</span>
          </div>
          <p className="display text-2xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
            {formatUsdcPrice(priceToSign)} USDC
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
            Sign once — no gas prompt, commit your full balance
          </p>
        </div>
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button onClick={show}
              className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
              style={{ background: 'var(--accent)' }}>
              Connect wallet to commit gaslessly
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
                Committed gaslessly
                {pricePaid !== null && ` for ${formatUsdcPrice(pricePaid)}`}
              </span>
            </div>
            {excess !== null && excess > 0n && (
              <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
                Price fell before your commit landed.{' '}
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
            className="rounded-2xl p-4"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}>
            <div className="flex items-center gap-2 mb-1">
              <Zap className="size-3.5" style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>Gasless commit</span>
            </div>
            <p className="display text-2xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
              {formatUsdcPrice(priceToSign)} USDC
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
              Sign once — no gas prompt
            </p>
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
        <div className="rounded-2xl p-3" style={{ background: 'rgba(255,160,0,0.08)', border: '1px solid rgba(255,160,0,0.2)' }}>
          <p className="text-sm" style={{ color: 'var(--warn, #b45309)' }}>{errMsg}</p>
        </div>
      )}

      {step !== 'done' && (
        <button
          onClick={() => { void handleSign() }}
          disabled={busy || !nonce}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
          style={{ background: 'var(--accent)' }}
        >
          {busy
            ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Working…</span>
            : errMsg
              ? `Sign again for ${formatUsdcPrice(priceToSign)}`
              : `Join gaslessly for ${formatUsdcPrice(priceToSign)}`}
        </button>
      )}

      <button
        onClick={onFallback}
        className="w-full text-xs py-1 opacity-40 hover:opacity-70 transition-opacity"
        style={{ color: 'var(--muted)' }}
      >
        Use approve-then-commit instead
      </button>
    </div>
  )
}
