import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, ExternalLink, CheckCircle, AlertCircle, Lock } from 'lucide-react'
import { formatUsdcPrice, txUrl, parseRevertReason, checkWouldStrandBuyer } from './utils'
import { useEscrowed, useTierCounts, useChainNow } from './hooks'
import { ARC_NETWORK, CONTRACTS_ACTIVE, RELAYER_URL } from './config'
import { DEMAND_POOL_ABI, ERC20_ABI } from './abis'
import type { DealTier } from './hooks'
import { GaslessCommitFlow } from './GaslessCommitFlow'

interface Props {
  dealId: bigint
  clearingPrice: bigint
  buyerCount: number
  tiers: DealTier[]
  deadline: bigint
  state: number
  onCommitted: () => void
}

type Step = 'idle' | 'approving' | 'approve-confirming' | 'committing' | 'commit-confirming' | 'done' | 'error'

const CHAIN_ID = ARC_NETWORK.chainId

export function CommitFlow({ dealId, clearingPrice, buyerCount, tiers, deadline, state, onCommitted }: Props) {
  // When the relayer is configured, show the gasless path first.
  // The user can switch to approve-then-commit via the fallback link.
  // NOTE: showFallback must be declared before any other hook so the hook
  // order is the same on every render (rules-of-hooks).
  const [showFallback, setShowFallback] = useState(false)

  // All hooks must be called unconditionally — move them all above the
  // conditional return so the call order is stable.
  const { address, isConnected, chainId: walletChain } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain = isConnected && walletChain !== CHAIN_ID

  const { data: escrowed, refetch: refetchEscrowed } = useEscrowed(dealId, address)
  const { tierCountMap } = useTierCounts(dealId, tiers)

  const isCommitted = escrowed !== undefined && BigInt(escrowed) > 0n

  const pendingRefund = isCommitted && clearingPrice > 0n
    ? BigInt(escrowed) - clearingPrice
    : 0n

  const withdrawCheck = isCommitted
    ? checkWouldStrandBuyer(BigInt(escrowed), tierCountMap, tiers, buyerCount)
    : { blocked: false as const }

  // Chain time, not the browser clock — this gates the commit button, and the
  // contract decides with block.timestamp. A skewed local clock would otherwise
  // hide a button that still works, or offer one that reverts.
  const nowSec = useChainNow()

  // Until chain time is known, do not claim the deadline has passed.
  const isPastDeadline = nowSec > 0 && Number(deadline) <= nowSec
  const isOpen = state === 0

  const [step, setStep] = useState<Step>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>()
  const [commitTxHash, setCommitTxHash] = useState<`0x${string}` | undefined>()

  const { writeContract, reset: resetWrite } = useWriteContract()

  const { isSuccess: approveSuccess } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    chainId: CHAIN_ID,
  })

  const { isSuccess: commitSuccess } = useWaitForTransactionReceipt({
    hash: commitTxHash,
    chainId: CHAIN_ID,
  })

  // Auto-advance: once approve confirms, send commit
  useEffect(() => {
    if (!approveSuccess || step !== 'approve-confirming') return
    setStep('committing')
    writeContract(
      {
        address: CONTRACTS_ACTIVE.DemandPool,
        abi: DEMAND_POOL_ABI,
        functionName: 'commit',
        args: [dealId],
        chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setCommitTxHash(hash); setStep('commit-confirming') },
        onError: (e) => { setErrMsg(parseRevertReason(e)); setStep('error') },
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveSuccess])

  useEffect(() => {
    if (!commitSuccess || step !== 'commit-confirming') return
    setStep('done')
    void refetchEscrowed()
    onCommitted()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitSuccess])

  // Approve the top tier price, not the price showing right now.
  //
  // `commit()` escrows whatever the live price is when the transaction lands,
  // and that can differ from the quote this button was rendered with: a
  // withdrawal can un-break a tier between the approve and the commit and push
  // the price UP. Approving the exact quote would then leave the commit short on
  // allowance and revert. tiers[0] is the curve's maximum (the contract enforces
  // strictly descending prices), so approving it covers every price the contract
  // can charge, while the escrow actually pulled is still only the live price.
  const maxCharge = tiers.length > 0 ? tiers[0].pricePerUnit : clearingPrice

  // All hooks have been called — safe to branch now.
  if (RELAYER_URL && !showFallback) {
    return (
      <GaslessCommitFlow
        dealId={dealId}
        clearingPrice={clearingPrice}
        deadline={deadline}
        state={state}
        onCommitted={onCommitted}
        onFallback={() => setShowFallback(true)}
      />
    )
  }

  const handleCommit = () => {
    if (!isConnected || wrongChain || !address) return
    setErrMsg('')
    setStep('approving')
    writeContract(
      {
        address: ARC_NETWORK.usdc.address,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [CONTRACTS_ACTIVE.DemandPool, maxCharge],
        chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setApproveTxHash(hash); setStep('approve-confirming') },
        onError: (e) => { setErrMsg(parseRevertReason(e)); setStep('error') },
      }
    )
  }

  const handleWithdraw = () => {
    if (!isConnected || wrongChain) return
    setErrMsg('')
    setStep('committing')
    writeContract(
      {
        address: CONTRACTS_ACTIVE.DemandPool,
        abi: DEMAND_POOL_ABI,
        functionName: 'withdraw',
        args: [dealId],
        chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setCommitTxHash(hash); setStep('commit-confirming') },
        onError: (e) => { setErrMsg(parseRevertReason(e)); setStep('error') },
      }
    )
  }

  const handleAddNetwork = () => {
    void (window as unknown as { ethereum: { request: (args: unknown) => Promise<void> } }).ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: ARC_NETWORK.hexChainId,
        chainName: ARC_NETWORK.name,
        nativeCurrency: ARC_NETWORK.nativeCurrency,
        rpcUrls: [ARC_NETWORK.rpcUrl],
        blockExplorerUrls: [ARC_NETWORK.explorerBase],
      }],
    })
  }

  const reset = () => { setStep('idle'); setErrMsg(''); resetWrite() }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!isOpen || isPastDeadline) {
    return (
      <div className="rounded-2xl p-4 text-center text-sm" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
        {state === 1 ? 'This deal has settled.' : state === 2 ? 'This deal has been refunded.' : 'This deal is closed.'}
      </div>
    )
  }

  if (!isConnected) {
    return (
      <div className="space-y-3">
        <div className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)' }}>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Commit amount</p>
          <p className="display text-2xl font-bold tabular-nums mt-0.5" style={{ color: 'var(--ink)' }}>
            {formatUsdcPrice(clearingPrice)} USDC
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>Escrowed now · refunded down to clearing price at settlement</p>
        </div>
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button
              onClick={show}
              className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
              style={{ background: 'var(--accent)' }}
            >
              Connect wallet to commit
            </button>
          )}
        </ConnectKitButton.Custom>
      </div>
    )
  }

  if (wrongChain) {
    return (
      <button
        onClick={() => switchChain({ chainId: CHAIN_ID })}
        className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99]"
        style={{ background: 'var(--accent)', color: '#fff' }}
      >
        Switch to {ARC_NETWORK.name}
      </button>
    )
  }

  const busyStep = step === 'approving' || step === 'approve-confirming' || step === 'committing' || step === 'commit-confirming'

  return (
    <div className="space-y-3">
      <AnimatePresence mode="wait">
        {isCommitted ? (
          <motion.div
            key="committed"
            className="rounded-2xl p-4 space-y-2"
            style={{ background: 'rgba(26,128,71,0.08)', border: '1px solid rgba(26,128,71,0.2)' }}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
          >
            <div className="flex items-center gap-2">
              <CheckCircle className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--success)' }}>You're in</span>
            </div>
            <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
              You escrowed{' '}
              <span className="font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                {formatUsdcPrice(BigInt(escrowed))}
              </span>
              {' — '}
              {pendingRefund > 0n ? (
                <>
                  you'll be refunded{' '}
                  <span className="font-bold tabular-nums" style={{ color: 'var(--success)' }}>
                    {formatUsdcPrice(pendingRefund)}
                  </span>{' '}
                  at the current price.
                </>
              ) : (
                "no refund at the current price — you're paying the clearing price exactly."
              )}
            </p>
          </motion.div>
        ) : (
          <motion.div
            key="not-committed"
            className="rounded-2xl p-4"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)' }}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
          >
            <p className="text-xs" style={{ color: 'var(--muted)' }}>You'll escrow</p>
            <p className="display text-2xl font-bold tabular-nums mt-0.5" style={{ color: 'var(--ink)' }}>
              {formatUsdcPrice(clearingPrice)} USDC
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
              Refunded down to clearing price at settlement
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {busyStep && (
        <div className="rounded-2xl p-3 flex items-center gap-3" style={{ background: 'var(--surface-muted)' }}>
          <Loader2 className="size-4 animate-spin shrink-0" style={{ color: 'var(--accent)' }} />
          <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
            {step === 'approving' ? 'Confirm approval in wallet…'
              : step === 'approve-confirming' ? 'Confirming approval…'
              : step === 'committing' ? 'Confirm commit in wallet…'
              : 'Confirming commit…'}
          </span>
        </div>
      )}

      {step === 'done' && commitTxHash && (
        <div className="rounded-2xl p-3 flex items-center gap-3" style={{ background: 'rgba(26,128,71,0.08)' }}>
          <CheckCircle className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
          <a href={txUrl(commitTxHash)} target="_blank" rel="noreferrer" className="text-sm flex items-center gap-1" style={{ color: 'var(--success)' }}>
            Committed — view on explorer <ExternalLink className="size-3" />
          </a>
        </div>
      )}

      {step === 'error' && (
        <div className="rounded-2xl p-3 flex items-start gap-3" style={{ background: 'rgba(186,43,76,0.08)' }}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm" style={{ color: 'var(--danger)' }}>{errMsg}</p>
            <button onClick={reset} className="text-xs mt-1 underline" style={{ color: 'var(--muted)' }}>Try again</button>
          </div>
        </div>
      )}

      {!isCommitted && step !== 'done' && (
        <button
          onClick={handleCommit}
          disabled={busyStep}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
          style={{ background: 'var(--accent)' }}
        >
          {busyStep
            ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Working…</span>
            : `Join for ${formatUsdcPrice(clearingPrice)}`}
        </button>
      )}

      {isCommitted && !isPastDeadline && step !== 'done' && (
        <div className="space-y-2">
          {withdrawCheck.blocked ? (
            <div className="rounded-2xl p-3 flex items-start gap-2.5" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
              <Lock className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--muted)' }} />
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                {withdrawCheck.reason}
              </p>
            </div>
          ) : (
            <button
              onClick={handleWithdraw}
              disabled={busyStep}
              className="w-full rounded-2xl py-2.5 text-sm font-medium transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--surface-muted)', color: 'var(--muted)', border: '1px solid var(--border)' }}
            >
              Withdraw escrow
            </button>
          )}
        </div>
      )}

      {RELAYER_URL && (
        <button
          onClick={() => setShowFallback(false)}
          className="w-full text-xs py-1 opacity-40 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--muted)' }}
        >
          Switch to gasless commit
        </button>
      )}

      <button
        onClick={handleAddNetwork}
        className="w-full text-xs py-1 opacity-40 hover:opacity-70 transition-opacity"
        style={{ color: 'var(--muted)' }}
      >
        Add {ARC_NETWORK.name} to wallet
      </button>
    </div>
  )
}
