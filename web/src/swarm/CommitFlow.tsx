import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, ExternalLink, CheckCircle, AlertCircle, Lock, Plus, Minus, PackagePlus } from 'lucide-react'
import {
  formatUsdcPrice, txUrl, parseRevertReason,
  checkWouldStrandBuyer, computeOrderTotal,
} from './utils'
import {
  useEscrowed, useUnitsOf, usePaidPerUnit, useTierCounts, useChainNow,
} from './hooks'
import { ARC_NETWORK, CONTRACTS_ACTIVE, RELAYER_URL, ARC_TX_FEES } from './config'
import { DEMAND_POOL_ABI, ERC20_ABI } from './abis'
import type { DealTier } from './hooks'
import { GaslessCommitFlow } from './GaslessCommitFlow'
import { useUsdcBalance, FundingNotice } from './FundingNotice'

interface Props {
  dealId:           bigint
  clearingPrice:    bigint
  totalUnits:       number    // current totalUnits in pool
  buyerCount:       number
  tiers:            DealTier[]
  maxUnits:         number    // stock cap
  maxUnitsPerBuyer: number    // 0 = no per-buyer limit
  deadline:         bigint
  state:            number
  goodsToken:       `0x${string}`
  goodsSymbol:      string
  tokensPerUnit:    bigint
  onCommitted:      () => void
}

type Step = 'idle' | 'approving' | 'approve-confirming' | 'committing' | 'commit-confirming' | 'done' | 'error'

const CHAIN_ID = ARC_NETWORK.chainId

export function CommitFlow({
  dealId, clearingPrice, totalUnits, buyerCount, tiers,
  maxUnits, maxUnitsPerBuyer, deadline, state, goodsToken,
  goodsSymbol, tokensPerUnit, onCommitted,
}: Props) {
  const [showFallback, setShowFallback] = useState(false)

  const { address, isConnected, chainId: walletChain } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain = isConnected && walletChain !== CHAIN_ID

  const { data: escrowed,    refetch: refetchEscrowed } = useEscrowed(dealId, address)
  const { data: myUnits                               } = useUnitsOf(dealId, address)
  const { data: myPaidPerUnit                         } = usePaidPerUnit(dealId, address)
  const { tierCountMap } = useTierCounts(dealId, tiers)

  const nowSec        = useChainNow()
  const isPastDeadline = nowSec > 0 && Number(deadline) <= nowSec
  const isOpen         = state === 0

  // Committed state — read from chain
  const isCommitted   = myUnits !== undefined && Number(myUnits) > 0
  const myUnitsN      = myUnits    !== undefined ? Number(myUnits)     : 0
  const myPPU         = myPaidPerUnit !== undefined ? BigInt(myPaidPerUnit) : 0n
  const myEscrow      = escrowed  !== undefined ? BigInt(escrowed)     : 0n

  // Average price paid across all lots: escrowed ÷ units (display only)
  const avgPricePaid  = isCommitted && myUnitsN > 0
    ? myEscrow / BigInt(myUnitsN)
    : 0n

  // Pending refund from escrow: escrowed − cp × units  (v2.1: per spec, not paidPerUnit)
  const currentPPU    = clearingPrice
  const pendingRefund = isCommitted && myEscrow > 0n
    ? myEscrow - (currentPPU * BigInt(myUnitsN))
    : 0n

  // Strand check — withdraw pre-check; uses paidPerUnit (cheapest lot) as specified
  const withdrawCheck = isCommitted
    ? checkWouldStrandBuyer(myPPU, myUnitsN, totalUnits, tierCountMap, tiers, buyerCount)
    : { blocked: false as const }

  // Quantity picker for a new lot:
  //   remainingStock: how many units are still available overall
  //   perBuyerHeadroom: how many MORE units this buyer can add (per-buyer limit minus already owned)
  //   maxAddable: min of both — 0 means at the limit
  const remainingStock   = maxUnits - totalUnits
  const perBuyerHeadroom = maxUnitsPerBuyer > 0
    ? Math.max(0, maxUnitsPerBuyer - myUnitsN)
    : remainingStock
  const maxAddable       = Math.min(remainingStock, perBuyerHeadroom)
  // For a non-committed buyer, maxOrderable is exactly maxAddable
  const maxOrderable     = maxAddable

  const [rawUnits, setUnits] = useState(1)
  const units = maxOrderable > 0 ? Math.min(rawUnits, maxOrderable) : 1

  // What this lot will cost (price includes all totalUnits + this lot)
  const { paidPerUnit: quotedPPU, total: quotedTotal, breaksTier } = computeOrderTotal(tiers, totalUnits, units)

  // Approve: tiers[0].pricePerUnit × units (worst-case ceiling for this lot)
  const maxPPU    = tiers.length > 0 ? tiers[0].pricePerUnit : clearingPrice
  const maxCharge = maxPPU * BigInt(units)

  // Funding check — include a small gas headroom
  const GAS_HEADROOM   = 20_000n // $0.02
  const usdcBalance    = useUsdcBalance(address)
  const neededForOrder = quotedTotal + GAS_HEADROOM
  const cannotAfford   = usdcBalance !== undefined && usdcBalance < neededForOrder

  const [step,          setStep]         = useState<Step>('idle')
  const [errMsg,        setErrMsg]       = useState('')
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>()
  const [commitTxHash,  setCommitTxHash]  = useState<`0x${string}` | undefined>()

  const { writeContract, reset: resetWrite } = useWriteContract()
  const { isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash, chainId: CHAIN_ID })
  const { isSuccess: commitSuccess  } = useWaitForTransactionReceipt({ hash: commitTxHash,  chainId: CHAIN_ID })

  // Auto-advance: approve confirmed → send commit
  useEffect(() => {
    if (!approveSuccess || step !== 'approve-confirming') return
    setStep('committing')
    writeContract(
      {
        address: CONTRACTS_ACTIVE.DemandPool,
        abi: DEMAND_POOL_ABI,
        functionName: 'commit',
        args: [dealId, units],
        ...ARC_TX_FEES, chainId: CHAIN_ID,
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

  // Show gasless path when relayer is set
  if (RELAYER_URL && !showFallback) {
    return (
      <GaslessCommitFlow
        dealId={dealId}
        clearingPrice={clearingPrice}
        totalUnits={totalUnits}
        tiers={tiers}
        maxUnits={maxUnits}
        maxUnitsPerBuyer={maxUnitsPerBuyer}
        currentUnits={myUnitsN}
        deadline={deadline}
        state={state}
        goodsToken={goodsToken}
        goodsSymbol={goodsSymbol}
        tokensPerUnit={tokensPerUnit}
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
        ...ARC_TX_FEES, chainId: CHAIN_ID,
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
        ...ARC_TX_FEES, chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setCommitTxHash(hash); setStep('commit-confirming') },
        onError: (e) => { setErrMsg(parseRevertReason(e)); setStep('error') },
      }
    )
  }

  const handleAddNetwork = () => {
    void (window as unknown as { ethereum: { request: (a: unknown) => Promise<void> } }).ethereum.request({
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

  if (!isOpen || isPastDeadline) {
    return (
      <div className="rounded-2xl p-4 text-center text-sm"
        style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
        {state === 1 ? 'This deal has settled.' : state === 2 ? 'This deal has been refunded.' : 'This deal is closed.'}
      </div>
    )
  }

  if (!isConnected) {
    return (
      <div className="space-y-3">
        <OrderPreviewCard
          units={units} quotedPPU={quotedPPU} quotedTotal={quotedTotal}
          breaksTier={breaksTier} goodsSymbol={goodsSymbol} tokensPerUnit={tokensPerUnit}
          maxOrderable={maxOrderable} isTopUp={false}
          onUnits={setUnits} connected={false}
        />
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button onClick={show}
              className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
              style={{ background: 'var(--accent)' }}>
              Connect wallet to order
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

  const busyStep = step === 'approving' || step === 'approve-confirming' || step === 'committing' || step === 'commit-confirming'
  // "At the limit" means the buyer has an order but cannot add more units
  const atLimit = isCommitted && maxAddable === 0

  return (
    <div className="space-y-3">
      <AnimatePresence mode="wait">
        {/* Order summary — shown when buyer has an existing order */}
        {isCommitted && (
          <motion.div key="committed"
            className="rounded-2xl p-4 space-y-2"
            style={{ background: 'rgba(26,128,71,0.08)', border: '1px solid rgba(26,128,71,0.2)' }}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}>
            <div className="flex items-center gap-2">
              <CheckCircle className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--success)' }}>
                Your order: {myUnitsN} unit{myUnitsN !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="text-sm space-y-0.5" style={{ color: 'var(--ink-2)' }}>
              <p>
                Escrowed{' '}
                <span className="font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                  {formatUsdcPrice(myEscrow)}
                </span>
                {myUnitsN > 0 && avgPricePaid !== myPPU && (
                  <span style={{ color: 'var(--muted)' }}>
                    {' '}(avg {formatUsdcPrice(avgPricePaid)}/unit)
                  </span>
                )}
                {myUnitsN > 0 && avgPricePaid === myPPU && (
                  <span style={{ color: 'var(--muted)' }}>
                    {' '}({formatUsdcPrice(avgPricePaid)}/unit)
                  </span>
                )}
              </p>
              {pendingRefund > 0n && (
                <p>
                  Refund at settlement:{' '}
                  <span className="font-bold tabular-nums" style={{ color: 'var(--success)' }}>
                    {formatUsdcPrice(pendingRefund)}
                  </span>{' '}
                  <span style={{ color: 'var(--muted)' }}>at {formatUsdcPrice(clearingPrice)}/unit</span>
                </p>
              )}
              <p style={{ color: 'var(--muted)' }}>
                You'll receive{' '}
                <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>
                  {(BigInt(myUnitsN) * tokensPerUnit).toString()} {goodsSymbol}
                </span>{' '}
                at settlement.
              </p>
            </div>
          </motion.div>
        )}

        {/* Add-lot picker — shown when buyer has an order and can still add */}
        {isCommitted && !atLimit && step !== 'done' && (
          <motion.div key="topup-picker"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}>
            <OrderPreviewCard
              units={units} quotedPPU={quotedPPU} quotedTotal={quotedTotal}
              breaksTier={breaksTier} goodsSymbol={goodsSymbol} tokensPerUnit={tokensPerUnit}
              maxOrderable={maxOrderable} isTopUp={true}
              onUnits={setUnits} connected={true}
            />
          </motion.div>
        )}

        {/* New-order picker — shown when buyer has no order yet */}
        {!isCommitted && step !== 'done' && (
          <motion.div key="not-committed"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}>
            <OrderPreviewCard
              units={units} quotedPPU={quotedPPU} quotedTotal={quotedTotal}
              breaksTier={breaksTier} goodsSymbol={goodsSymbol} tokensPerUnit={tokensPerUnit}
              maxOrderable={maxOrderable} isTopUp={false}
              onUnits={setUnits} connected={true}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {busyStep && (
        <div className="rounded-2xl p-3 flex items-center gap-3" style={{ background: 'var(--surface-muted)' }}>
          <Loader2 className="size-4 animate-spin shrink-0" style={{ color: 'var(--accent)' }} />
          <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
            {step === 'approving'          ? 'Confirm approval in wallet…'
              : step === 'approve-confirming' ? 'Confirming approval…'
              : step === 'committing'         ? 'Confirm order in wallet…'
              : 'Confirming order…'}
          </span>
        </div>
      )}

      {step === 'done' && commitTxHash && (
        <div className="rounded-2xl p-3 flex items-center gap-3" style={{ background: 'rgba(26,128,71,0.08)' }}>
          <CheckCircle className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
          <a href={txUrl(commitTxHash)} target="_blank" rel="noreferrer"
            className="text-sm flex items-center gap-1" style={{ color: 'var(--success)' }}>
            {isCommitted ? 'Lot added' : 'Order placed'} — view on explorer <ExternalLink className="size-3" />
          </a>
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

      {/* At-limit notice (buyer has an order but cannot add more) */}
      {atLimit && (
        <div className="rounded-2xl p-3 text-center text-sm"
          style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
          {maxUnitsPerBuyer > 0
            ? `You've reached the per-buyer limit of ${maxUnitsPerBuyer} unit${maxUnitsPerBuyer !== 1 ? 's' : ''}.`
            : 'No stock remaining.'}
        </div>
      )}

      {/* Funding notice — shown when buyer cannot afford the lot */}
      {!atLimit && step !== 'done' && maxOrderable > 0 && cannotAfford && usdcBalance !== undefined && (
        <FundingNotice needed={neededForOrder} balance={usdcBalance} />
      )}

      {/* Order / add-lot button */}
      {!atLimit && step !== 'done' && maxOrderable > 0 && !cannotAfford && (
        <button
          onClick={handleCommit}
          disabled={busyStep}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
          style={{ background: 'var(--accent)' }}>
          {busyStep
            ? <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Working…</span>
            : isCommitted
              ? <span className="flex items-center justify-center gap-2">
                  <PackagePlus className="size-4" />
                  {`Add ${units} unit${units !== 1 ? 's' : ''} for ${formatUsdcPrice(quotedTotal)}`}
                </span>
              : `Order ${units} unit${units !== 1 ? 's' : ''} for ${formatUsdcPrice(quotedTotal)}`}
        </button>
      )}

      {!isCommitted && maxOrderable === 0 && (
        <div className="rounded-2xl p-3 text-center text-sm" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
          No stock remaining
        </div>
      )}

      {isCommitted && !isPastDeadline && step !== 'done' && (
        <div className="space-y-2">
          {withdrawCheck.blocked ? (
            <div className="rounded-2xl p-3 flex items-start gap-2.5"
              style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
              <Lock className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--muted)' }} />
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{withdrawCheck.reason}</p>
            </div>
          ) : (
            <button
              onClick={handleWithdraw}
              disabled={busyStep}
              className="w-full rounded-2xl py-2.5 text-sm font-medium transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--surface-muted)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
              Withdraw entire order
            </button>
          )}
        </div>
      )}

      {RELAYER_URL && (
        <button onClick={() => setShowFallback(false)}
          className="w-full text-xs py-1 opacity-40 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--muted)' }}>
          Switch to gasless order
        </button>
      )}

      <button onClick={handleAddNetwork}
        className="w-full text-xs py-1 opacity-40 hover:opacity-70 transition-opacity"
        style={{ color: 'var(--muted)' }}>
        Add {ARC_NETWORK.name} to wallet
      </button>
    </div>
  )
}

// ── Order preview card with quantity picker ───────────────────────────────────

interface OrderPreviewProps {
  units:        number
  quotedPPU:    bigint
  quotedTotal:  bigint
  breaksTier:   boolean
  goodsSymbol:  string
  tokensPerUnit:bigint
  maxOrderable: number
  isTopUp:      boolean
  onUnits:      (n: number) => void
  connected:    boolean
}

function OrderPreviewCard({
  units, quotedPPU, quotedTotal, breaksTier,
  goodsSymbol, tokensPerUnit, maxOrderable, isTopUp, onUnits,
}: OrderPreviewProps) {
  const tokensReceived = BigInt(units) * tokensPerUnit

  return (
    <div className="rounded-2xl p-4 space-y-3"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)' }}>

      {isTopUp && (
        <div className="flex items-center gap-1.5">
          <PackagePlus className="size-3.5" style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>Add to your order</span>
        </div>
      )}

      {/* Quantity picker */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {isTopUp ? 'Units to add' : 'Quantity'}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onUnits(Math.max(1, units - 1))}
            disabled={units <= 1}
            className="size-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-30"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
            <Minus className="size-3.5" />
          </button>
          <span className="display text-xl font-bold tabular-nums w-10 text-center"
            style={{ color: 'var(--ink)' }}>
            {units}
          </span>
          <button
            onClick={() => onUnits(Math.min(maxOrderable, units + 1))}
            disabled={units >= maxOrderable}
            className="size-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-30"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Max hint */}
      {maxOrderable > 0 && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          {isTopUp
            ? `Up to ${maxOrderable} more unit${maxOrderable !== 1 ? 's' : ''} available`
            : `Up to ${maxOrderable} unit${maxOrderable !== 1 ? 's' : ''} available`}
        </p>
      )}

      {/* Price + goods summary */}
      <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-baseline justify-between">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {formatUsdcPrice(quotedPPU)}/unit
          </span>
          <span className="display text-2xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
            {formatUsdcPrice(quotedTotal)}
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--subtle)' }}>
          {"You'll receive"} {tokensReceived.toString()} {goodsSymbol}
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
