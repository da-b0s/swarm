/**
 * CommitFlow v2.2 — one unified ordering and withdrawal panel.
 *
 * Layout:
 *   1. Order summary (when buyer has units): total units, escrow, avg price, refund.
 *   2. Order / add-lot picker: gasless by default; "Pay gas yourself" link-button below.
 *      After success, dismisses the confirmation toast and returns to the summary.
 *   3. Partial-withdraw picker: quantity 1..unitsOf, shows USDC returned, strand check.
 *
 * The gasless path (GaslessCommitFlow) and the approve-then-commit path are both
 * rendered in this file so they share the same order summary and withdraw controls.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  useAccount, useWriteContract, useWaitForTransactionReceipt,
  useSwitchChain, useSignTypedData, useReadContract,
} from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Loader2, ExternalLink, CheckCircle, AlertCircle, Lock,
  Plus, Minus, PackagePlus, Zap, ArrowDownLeft,
} from 'lucide-react'
import {
  formatUsdcPrice, txUrl, parseRevertReason,
  checkWouldStrandBuyer, computeOrderTotal, computeWithdrawReturn, formatTokenAmount,
} from './utils'
import {
  useEscrowed, useUnitsOf, usePaidPerUnit, useTierCounts, useChainNow,
} from './hooks'
import { ARC_NETWORK, CONTRACTS_ACTIVE, RELAYER_URL, ARC_TX_FEES } from './config'
import { DEMAND_POOL_ABI, ERC20_ABI } from './abis'
import type { DealTier } from './hooks'
import { useUsdcBalance, FundingNotice } from './FundingNotice'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  dealId:           bigint
  clearingPrice:    bigint
  totalUnits:       number
  buyerCount:       number
  tiers:            DealTier[]
  maxUnits:         number
  maxUnitsPerBuyer: number
  deadline:         bigint
  state:            number
  goodsToken:       `0x${string}`
  goodsSymbol:      string
  goodsDecimals?:   number
  tokensPerUnit:    bigint
  onCommitted:      () => void
}

type CommitStep = 'idle' | 'approving' | 'approve-confirming' | 'committing' | 'commit-confirming' | 'done' | 'error'
type WithdrawStep = 'idle' | 'confirming' | 'done' | 'error'

const CHAIN_ID = ARC_NETWORK.chainId
const VALIDITY_WINDOW_SEC = 600

// ── EIP-712 types for gasless ─────────────────────────────────────────────────

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

const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const

function randomSalt(): `0x${string}` {
  const arr = crypto.getRandomValues(new Uint8Array(32))
  return ('0x' + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

class WalletCannotSignError extends Error {
  constructor() { super('wallet cannot sign this typed data'); this.name = 'WalletCannotSignError' }
}

function errText(e: unknown): string {
  const x = e as { message?: string; shortMessage?: string; details?: string; cause?: unknown }
  return [x?.shortMessage, x?.details, x?.message, x?.cause ? errText(x.cause) : ''].filter(Boolean).join(' ')
}
function isWalletParserError(e: unknown): boolean {
  return /Unable to encode value|ParserError|Invalid number/i.test(errText(e))
}
function isUserRejection(e: unknown): boolean {
  const x = e as { code?: number; cause?: { code?: number } }
  return x?.code === 4001 || x?.cause?.code === 4001 || /user rejected|denied/i.test(errText(e))
}
function shortWalletError(e: unknown): string {
  const x = e as { shortMessage?: string; message?: string }
  return (x?.shortMessage ?? x?.message ?? 'Signing failed').split('\n')[0].slice(0, 160)
}
function safeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('value too large')
  return Number(v)
}

const RELAYER_MESSAGES: Record<string, string> = {
  InvalidAuthorization:     'The signature did not match this order. Please sign again.',
  AuthorizationAlreadyUsed: 'That signature was already used. Please sign again.',
  DealNotOpen:              'This deal is no longer open.',
  DeadlinePassed:           'This deal has closed.',
  UnitCapReached:           'Not enough stock left for that quantity — try fewer.',
  UnitsPerBuyerExceeded:    'That is more than one buyer can order in this deal.',
  BuyerCapReached:          'This deal has reached its maximum number of buyers.',
  Blocklisted:              'This address cannot use USDC.',
}
function relayerMessage(code: string | undefined): string {
  if (!code) return 'The order could not be placed. You can pay the network fee yourself below.'
  return RELAYER_MESSAGES[code] ?? 'The order could not be placed. You can pay the network fee yourself below.'
}

// ── Main component ────────────────────────────────────────────────────────────

export function CommitFlow({
  dealId, clearingPrice, totalUnits, buyerCount, tiers,
  maxUnits, maxUnitsPerBuyer, deadline, state, goodsToken: _goodsToken,
  goodsSymbol, goodsDecimals, tokensPerUnit, onCommitted,
}: Props) {
  const { address, isConnected, chainId: walletChain, connector } = useAccount()
  const { switchChain }   = useSwitchChain()
  const { signTypedData } = useSignTypedData()
  const { writeContract, reset: resetWrite } = useWriteContract()
  const nowSec = useChainNow()

  const wrongChain     = isConnected && walletChain !== CHAIN_ID
  const isPastDeadline = nowSec > 0 && Number(deadline) <= nowSec
  const isOpen         = state === 0

  // ── Chain reads ─────────────────────────────────────────────────────────────
  const { data: escrowedRaw,  refetch: refetchEscrowed } = useEscrowed(dealId, address)
  const { data: myUnitsRaw,   refetch: refetchUnits    } = useUnitsOf(dealId, address)
  const { data: myPPURaw                               } = usePaidPerUnit(dealId, address)
  const { tierCountMap } = useTierCounts(dealId, tiers)
  const usdcBalance = useUsdcBalance(address)

  const myUnitsN  = myUnitsRaw   !== undefined ? Number(myUnitsRaw)     : 0
  const myEscrow  = escrowedRaw  !== undefined ? BigInt(escrowedRaw)    : 0n
  const myPPU     = myPPURaw     !== undefined ? BigInt(myPPURaw)       : 0n
  const isCommitted = myUnitsN > 0

  // Average price paid across all lots
  const avgPricePaid = isCommitted && myUnitsN > 0 ? myEscrow / BigInt(myUnitsN) : 0n
  // Refund waiting: escrowed − cp × units (spec v2.1)
  const pendingRefund = isCommitted ? myEscrow - clearingPrice * BigInt(myUnitsN) : 0n

  // ── Order picker ─────────────────────────────────────────────────────────────
  const remainingStock   = maxUnits - totalUnits
  const perBuyerHeadroom = maxUnitsPerBuyer > 0
    ? Math.max(0, maxUnitsPerBuyer - myUnitsN)
    : remainingStock
  const maxAddable  = Math.min(remainingStock, perBuyerHeadroom)
  const atOrderLimit = isCommitted && maxAddable === 0

  const [rawOrderUnits, setOrderUnits] = useState(1)
  const orderUnits = maxAddable > 0 ? Math.min(rawOrderUnits, maxAddable) : 1
  const { paidPerUnit: quotedPPU, total: quotedTotal, breaksTier } = computeOrderTotal(tiers, totalUnits, orderUnits)
  const maxPPU      = tiers.length > 0 ? tiers[0].pricePerUnit : clearingPrice
  const maxCharge   = maxPPU * BigInt(orderUnits)
  const GAS_HEAD    = 20_000n
  const neededFunds = quotedTotal + GAS_HEAD
  const cannotAfford = usdcBalance !== undefined && usdcBalance < neededFunds

  // ── Gasless state ────────────────────────────────────────────────────────────
  const [useGasless, setUseGasless] = useState(!!RELAYER_URL)
  const [salt, setSalt]             = useState<`0x${string}`>(() => randomSalt())
  const [signTotal, setSignTotal]   = useState<bigint | null>(null)
  const totalToSign = signTotal ?? quotedTotal
  const [gaslessStep, setGaslessStep] = useState<'idle' | 'signing' | 'submitting' | 'done' | 'error'>('idle')
  const [gaslessTxHash, setGaslessTxHash]   = useState<`0x${string}` | null>(null)
  const [gaslessPricePaid, setGaslessPricePaid] = useState<bigint | null>(null)
  const [gaslessExcess, setGaslessExcess]   = useState<bigint | null>(null)
  const [gaslessErr, setGaslessErr]         = useState('')

  const { data: nonce, refetch: refetchNonce } = useReadContract({
    address: CONTRACTS_ACTIVE.DemandPool,
    abi: DEMAND_POOL_ABI,
    functionName: 'authorizationNonce',
    args: [
      dealId,
      address ?? '0x0000000000000000000000000000000000000000',
      orderUnits,
      salt,
    ],
    chainId: CHAIN_ID,
    query: { enabled: !!address && useGasless },
  })

  // ── Approve-then-commit state ────────────────────────────────────────────────
  const [commitStep, setCommitStep]       = useState<CommitStep>('idle')
  const [commitErr, setCommitErr]         = useState('')
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>()
  const [commitTxHash, setCommitTxHash]   = useState<`0x${string}` | undefined>()
  const { isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash, chainId: CHAIN_ID })
  const { isSuccess: commitSuccess  } = useWaitForTransactionReceipt({ hash: commitTxHash,  chainId: CHAIN_ID })

  useEffect(() => {
    if (!approveSuccess || commitStep !== 'approve-confirming') return
    setCommitStep('committing')
    writeContract(
      {
        address: CONTRACTS_ACTIVE.DemandPool, abi: DEMAND_POOL_ABI,
        functionName: 'commit', args: [dealId, orderUnits],
        ...ARC_TX_FEES, chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setCommitTxHash(hash); setCommitStep('commit-confirming') },
        onError: (e) => { setCommitErr(parseRevertReason(e)); setCommitStep('error') },
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveSuccess])

  useEffect(() => {
    if (!commitSuccess || commitStep !== 'commit-confirming') return
    setCommitStep('done')
    void refetchEscrowed()
    void refetchUnits()
    onCommitted()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitSuccess])

  // ── Withdraw state ───────────────────────────────────────────────────────────
  const [rawWithdrawUnits, setWithdrawUnits] = useState(1)
  const withdrawUnits = myUnitsN > 0 ? Math.min(rawWithdrawUnits, myUnitsN) : 1
  const withdrawReturn = computeWithdrawReturn(myEscrow, withdrawUnits, myUnitsN)

  // Keep withdraw slider defaulting to full when units change
  useEffect(() => {
    if (myUnitsN > 0) setWithdrawUnits(myUnitsN)
  }, [myUnitsN])

  const withdrawCheck = isCommitted
    ? checkWouldStrandBuyer(myPPU, myUnitsN, totalUnits, tierCountMap, tiers, buyerCount, withdrawUnits)
    : { blocked: false as const }

  const [withdrawStep, setWithdrawStep] = useState<WithdrawStep>('idle')
  const [withdrawErr, setWithdrawErr]   = useState('')
  const [withdrawTxHash, setWithdrawTxHash] = useState<`0x${string}` | undefined>()
  const { isSuccess: withdrawSuccess  } = useWaitForTransactionReceipt({ hash: withdrawTxHash, chainId: CHAIN_ID })

  useEffect(() => {
    if (!withdrawSuccess || withdrawStep !== 'confirming') return
    setWithdrawStep('done')
    void refetchEscrowed()
    void refetchUnits()
    onCommitted()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdrawSuccess])

  // ── Handlers ──────────────────────────────────────────────────────────────────

  const handleGaslessSign = useCallback(async () => {
    if (!address || !isConnected || wrongChain || !nonce || !RELAYER_URL) return
    setGaslessErr('')
    setGaslessStep('signing')

    const validAfter  = 0n
    const baseNow     = nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000)
    const validBefore = BigInt(baseNow + VALIDITY_WINDOW_SEC)
    const authorizedAmount = totalToSign

    try {
      const typedData = {
        domain: {
          name: 'USDC', version: '2', chainId: CHAIN_ID,
          verifyingContract: ARC_NETWORK.usdc.address,
        },
        types: RECEIVE_WITH_AUTH_TYPES,
        primaryType: 'ReceiveWithAuthorization' as const,
        message: {
          from: address, to: CONTRACTS_ACTIVE.DemandPool,
          value: authorizedAmount, validAfter, validBefore, nonce,
        },
      }

      let sig: `0x${string}`
      try {
        sig = await new Promise<`0x${string}`>((resolve, reject) => {
          signTypedData(typedData, { onSuccess: resolve, onError: reject })
        })
      } catch (first: unknown) {
        if (!isWalletParserError(first) || !connector) throw first
        const provider = await connector.getProvider() as {
          request: (a: { method: string; params: unknown[] }) => Promise<unknown>
        }
        const asNumbers = JSON.stringify({
          ...typedData,
          types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...RECEIVE_WITH_AUTH_TYPES },
          message: {
            ...typedData.message,
            value: safeNumber(authorizedAmount),
            validAfter: safeNumber(validAfter),
            validBefore: safeNumber(validBefore),
          },
        })
        try {
          sig = await provider.request({
            method: 'eth_signTypedData_v4', params: [address, asNumbers],
          }) as `0x${string}`
        } catch (second: unknown) {
          if (isWalletParserError(second)) throw new WalletCannotSignError()
          throw second
        }
      }

      setGaslessStep('submitting')
      const res = await fetch(`${RELAYER_URL}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealId: dealId.toString(), buyer: address, units: orderUnits,
          authorizedAmount: authorizedAmount.toString(),
          validAfter: validAfter.toString(), validBefore: validBefore.toString(),
          salt, signature: sig,
        }),
      })

      const data = await res.json() as {
        txHash?: string; paidPerUnit?: string; escrow?: string
        excessCredited?: string; error?: string; requiredTotal?: string
      }

      if (res.status === 409 && data.requiredTotal) {
        const newTotal = BigInt(data.requiredTotal)
        setSignTotal(newTotal)
        setSalt(randomSalt())
        void refetchNonce()
        const isTopUp = myUnitsN > 0
        setGaslessErr(
          `Price rose — ${isTopUp ? 'these units' : 'your order'} now cost ${formatUsdcPrice(newTotal)}. ` +
          `Sign again at the new total to continue.`
        )
        setGaslessStep('idle')
        return
      }

      if (!res.ok || !data.txHash) {
        setGaslessErr(relayerMessage(data.error))
        setGaslessStep('error')
        return
      }

      setGaslessTxHash(data.txHash as `0x${string}`)
      setGaslessPricePaid(data.paidPerUnit ? BigInt(data.paidPerUnit) : null)
      setGaslessExcess(data.excessCredited ? BigInt(data.excessCredited) : null)
      setGaslessStep('done')
      void refetchEscrowed()
      void refetchUnits()
      onCommitted()
    } catch (e: unknown) {
      if (e instanceof WalletCannotSignError) {
        setGaslessErr('Your wallet could not sign this order. Use "Pay the network fee yourself" below.')
        setGaslessStep('error')
        return
      }
      if (isUserRejection(e)) { setGaslessErr(''); setGaslessStep('idle'); return }
      setGaslessErr(shortWalletError(e))
      setGaslessStep('error')
    }
  }, [
    address, isConnected, wrongChain, nonce, nowSec, totalToSign,
    dealId, orderUnits, salt, signTypedData, refetchNonce, onCommitted,
    connector, myUnitsN, refetchEscrowed, refetchUnits,
  ])

  const handleApproveCommit = () => {
    if (!isConnected || wrongChain || !address) return
    setCommitErr('')
    setCommitStep('approving')
    writeContract(
      {
        address: ARC_NETWORK.usdc.address, abi: ERC20_ABI,
        functionName: 'approve', args: [CONTRACTS_ACTIVE.DemandPool, maxCharge],
        ...ARC_TX_FEES, chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setApproveTxHash(hash); setCommitStep('approve-confirming') },
        onError: (e) => { setCommitErr(parseRevertReason(e)); setCommitStep('error') },
      }
    )
  }

  const handleWithdraw = () => {
    if (!isConnected || wrongChain) return
    setWithdrawErr('')
    setWithdrawStep('confirming')
    writeContract(
      {
        address: CONTRACTS_ACTIVE.DemandPool, abi: DEMAND_POOL_ABI,
        functionName: 'withdraw', args: [dealId, withdrawUnits],
        ...ARC_TX_FEES, chainId: CHAIN_ID,
      },
      {
        onSuccess: (hash) => { setWithdrawTxHash(hash) },
        onError: (e) => { setWithdrawErr(parseRevertReason(e)); setWithdrawStep('error') },
      }
    )
  }

  const resetGasless = () => {
    setGaslessStep('idle'); setGaslessErr(''); setSignTotal(null)
    setSalt(randomSalt()); void refetchNonce()
  }
  const resetCommit = () => { setCommitStep('idle'); setCommitErr(''); resetWrite() }
  const resetWithdraw = () => { setWithdrawStep('idle'); setWithdrawErr('') }

  const handleAddNetwork = () => {
    void (window as unknown as { ethereum: { request: (a: unknown) => Promise<void> } })
      .ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: ARC_NETWORK.hexChainId, chainName: ARC_NETWORK.name,
          nativeCurrency: ARC_NETWORK.nativeCurrency,
          rpcUrls: [ARC_NETWORK.rpcUrl], blockExplorerUrls: [ARC_NETWORK.explorerBase],
        }],
      })
  }

  // ── Guards ────────────────────────────────────────────────────────────────────

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
          units={orderUnits} quotedPPU={quotedPPU} quotedTotal={quotedTotal}
          breaksTier={breaksTier} goodsSymbol={goodsSymbol} goodsDecimals={goodsDecimals}
          tokensPerUnit={tokensPerUnit}
          maxOrderable={maxAddable > 0 ? maxAddable : (remainingStock)} isTopUp={false}
          onUnits={setOrderUnits}
          badge={RELAYER_URL ? 'gasless' : undefined}
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

  const gaslessBusy   = gaslessStep === 'signing' || gaslessStep === 'submitting'
  const commitBusy    = commitStep === 'approving' || commitStep === 'approve-confirming'
                     || commitStep === 'committing' || commitStep === 'commit-confirming'
  const orderBusy     = useGasless ? gaslessBusy : commitBusy
  const withdrawBusy  = withdrawStep === 'confirming'
  const anyBusy       = orderBusy || withdrawBusy

  // After a gasless or commit success, show a brief confirmation then reset
  const orderDone = (useGasless && gaslessStep === 'done') || (!useGasless && commitStep === 'done')
  const orderTxHash = useGasless ? gaslessTxHash : (commitTxHash ?? null)
  const maxOrderable = maxAddable > 0 ? maxAddable : (isCommitted ? 0 : remainingStock)

  return (
    <div className="space-y-3">
      <AnimatePresence mode="popLayout">

        {/* ── Order summary ──────────────────────────────────────────────── */}
        {isCommitted && (
          <motion.div key="order-summary"
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
                Paid{' '}
                <span className="font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                  {formatUsdcPrice(myEscrow)}
                </span>
                <span style={{ color: 'var(--muted)' }}>
                  {' '}(avg {formatUsdcPrice(avgPricePaid)} each)
                </span>
              </p>
              {pendingRefund > 0n && (
                <p>
                  Coming back to you at the current price:{' '}
                  <span className="font-bold tabular-nums" style={{ color: 'var(--success)' }}>
                    {formatUsdcPrice(pendingRefund)}
                  </span>
                  <span style={{ color: 'var(--muted)' }}>
                    {' '}({formatUsdcPrice(clearingPrice)} each)
                  </span>
                </p>
              )}
              <p style={{ color: 'var(--muted)' }}>
                You will receive{' '}
                <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>
                  {goodsDecimals !== undefined
                    ? `${formatTokenAmount(BigInt(myUnitsN) * tokensPerUnit, goodsDecimals)} ${goodsSymbol}`
                    : null}
                </span>{' '}
                when the deal closes.
              </p>
            </div>
          </motion.div>
        )}

        {/* ── Order / add-lot section ────────────────────────────────────── */}
        {!atOrderLimit && (
          <motion.div key="order-section"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}>

            {/* Order done toast — shown briefly, then reverts to summary */}
            {orderDone ? (
              <div className="rounded-2xl p-3 flex items-center gap-3"
                style={{ background: 'rgba(26,128,71,0.08)', border: '1px solid rgba(26,128,71,0.2)' }}>
                <CheckCircle className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
                <div className="flex-1 min-w-0">
                  <span className="text-sm" style={{ color: 'var(--success)' }}>
                    {isCommitted ? 'Added to your order' : 'Order placed'}
                    
                    {useGasless && gaslessPricePaid !== null && ` at ${formatUsdcPrice(gaslessPricePaid)} each`}
                  </span>
                  {useGasless && gaslessExcess !== null && gaslessExcess > 0n && (
                    <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                      {formatUsdcPrice(gaslessExcess)} to collect: the price dropped while your order went through
                    </p>
                  )}
                </div>
                {orderTxHash && (
                  <a href={txUrl(orderTxHash)} target="_blank" rel="noreferrer"
                    style={{ color: 'var(--muted)' }}>
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
            ) : (
              <>
                <OrderPreviewCard
                  units={orderUnits} quotedPPU={quotedPPU} quotedTotal={quotedTotal}
                  breaksTier={breaksTier} goodsSymbol={goodsSymbol} goodsDecimals={goodsDecimals}
                  tokensPerUnit={tokensPerUnit}
                  maxOrderable={maxOrderable} isTopUp={isCommitted}
                  onUnits={setOrderUnits}
                  badge={useGasless ? 'gasless' : undefined}
                />

                {/* Status rows */}
                {(gaslessBusy || commitBusy) && (
                  <div className="mt-2 rounded-2xl p-3 flex items-center gap-3"
                    style={{ background: 'var(--surface-muted)' }}>
                    <Loader2 className="size-4 animate-spin shrink-0" style={{ color: 'var(--accent)' }} />
                    <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
                      {gaslessStep === 'signing'           ? 'Sign in your wallet…'
                        : gaslessStep === 'submitting'     ? 'Placing your order…'
                        : commitStep  === 'approving'      ? 'Allow USDC in your wallet…'
                        : commitStep  === 'approve-confirming' ? 'Waiting for confirmation…'
                        : commitStep  === 'committing'     ? 'Confirm the order in your wallet…'
                        : 'Confirming order…'}
                    </span>
                  </div>
                )}

                {useGasless && (gaslessStep === 'error' || (gaslessStep === 'idle' && gaslessErr)) && (
                  <div className="mt-2 rounded-2xl p-3 flex items-start gap-3"
                    style={{ background: gaslessStep === 'error' ? 'rgba(186,43,76,0.08)' : 'rgba(255,160,0,0.08)',
                             border: `1px solid ${gaslessStep === 'error' ? 'rgba(186,43,76,0.2)' : 'rgba(255,160,0,0.2)'}` }}>
                    <AlertCircle className="size-4 shrink-0 mt-0.5"
                      style={{ color: gaslessStep === 'error' ? 'var(--danger)' : 'var(--warn, #b45309)' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm"
                        style={{ color: gaslessStep === 'error' ? 'var(--danger)' : 'var(--warn, #b45309)' }}>
                        {gaslessErr}
                      </p>
                      {gaslessStep === 'error' && (
                        <button onClick={resetGasless} className="text-xs mt-1 underline" style={{ color: 'var(--muted)' }}>
                          Try again
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {!useGasless && commitStep === 'error' && (
                  <div className="mt-2 rounded-2xl p-3 flex items-start gap-3" style={{ background: 'rgba(186,43,76,0.08)' }}>
                    <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm" style={{ color: 'var(--danger)' }}>{commitErr}</p>
                      <button onClick={resetCommit} className="text-xs mt-1 underline" style={{ color: 'var(--muted)' }}>Try again</button>
                    </div>
                  </div>
                )}

                {/* Funding notice */}
                {maxOrderable > 0 && cannotAfford && usdcBalance !== undefined && (
                  <div className="mt-2">
                    <FundingNotice needed={neededFunds} balance={usdcBalance} />
                  </div>
                )}

                {/* Primary order button */}
                {maxOrderable > 0 && !cannotAfford && (
                  <button
                    onClick={useGasless ? () => { void handleGaslessSign() } : handleApproveCommit}
                    disabled={anyBusy || (useGasless && !nonce)}
                    className="mt-2 w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
                    style={{ background: 'var(--accent)' }}>
                    {orderBusy
                      ? <span className="flex items-center justify-center gap-2">
                          <Loader2 className="size-4 animate-spin" /> Working…
                        </span>
                      : useGasless
                        ? <span className="flex items-center justify-center gap-2">
                            {isCommitted ? <PackagePlus className="size-4" /> : <Zap className="size-4" />}
                            {isCommitted
                              ? `Add ${orderUnits} unit${orderUnits !== 1 ? 's' : ''} for ${formatUsdcPrice(totalToSign)}`
                              : `Order ${orderUnits} unit${orderUnits !== 1 ? 's' : ''} for ${formatUsdcPrice(totalToSign)}`}
                          </span>
                        : isCommitted
                          ? <span className="flex items-center justify-center gap-2">
                              <PackagePlus className="size-4" />
                              {`Add ${orderUnits} unit${orderUnits !== 1 ? 's' : ''} for ${formatUsdcPrice(quotedTotal)}`}
                            </span>
                          : `Order ${orderUnits} unit${orderUnits !== 1 ? 's' : ''} for ${formatUsdcPrice(quotedTotal)}`}
                  </button>
                )}

                {/* Gasless ↔ gas-yourself toggle */}
                {RELAYER_URL && maxOrderable > 0 && !cannotAfford && (
                  <button
                    onClick={() => { setUseGasless(g => !g); resetGasless(); resetCommit() }}
                    className="w-full text-sm py-1.5 font-medium underline-offset-2 hover:underline transition-all"
                    style={{ color: 'var(--muted)' }}>
                    {useGasless
                      ? 'Pay the network fee yourself instead'
                      : 'Use fee-free ordering instead'}
                  </button>
                )}
              </>
            )}
          </motion.div>
        )}

        {/* At-limit notice */}
        {atOrderLimit && (
          <motion.div key="at-limit"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}>
            <div className="rounded-2xl p-3 text-center text-sm"
              style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
              {maxUnitsPerBuyer > 0
                ? `You've ordered the maximum of ${maxUnitsPerBuyer} unit${maxUnitsPerBuyer !== 1 ? 's' : ''} per buyer for this deal.`
                : 'Sold out.'}
            </div>
          </motion.div>
        )}

        {/* No stock, not committed */}
        {!isCommitted && maxOrderable === 0 && (
          <motion.div key="no-stock"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="rounded-2xl p-3 text-center text-sm"
              style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
              No stock remaining
            </div>
          </motion.div>
        )}

        {/* ── Partial / full withdrawal section ─────────────────────────── */}
        {isCommitted && !isPastDeadline && (
          <motion.div key="withdraw-section"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}>

            {withdrawStep === 'done' && withdrawTxHash ? (
              <div className="rounded-2xl p-3 flex items-center gap-3"
                style={{ background: 'rgba(26,128,71,0.08)', border: '1px solid rgba(26,128,71,0.2)' }}>
                <CheckCircle className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
                <span className="text-sm flex-1" style={{ color: 'var(--success)' }}>
                  Withdrawal done
                </span>
                <a href={txUrl(withdrawTxHash)} target="_blank" rel="noreferrer"
                  style={{ color: 'var(--muted)' }}>
                  <ExternalLink className="size-3.5" />
                </a>
              </div>
            ) : (
              <div className="rounded-2xl p-4 space-y-3"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>

                {/* Section header */}
                <div className="flex items-center gap-1.5">
                  <ArrowDownLeft className="size-3.5" style={{ color: 'var(--muted)' }} />
                  <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
                    Reduce or cancel your order
                  </span>
                </div>

                {/* Units to withdraw */}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>Units to withdraw</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setWithdrawUnits(u => Math.max(1, u - 1))}
                      disabled={withdrawUnits <= 1}
                      className="size-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-30"
                      style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
                      <Minus className="size-3.5" />
                    </button>
                    <span className="text-xl font-bold tabular-nums w-10 text-center"
                      style={{ color: 'var(--ink)' }}>
                      {withdrawUnits}
                    </span>
                    <button
                      onClick={() => setWithdrawUnits(u => Math.min(myUnitsN, u + 1))}
                      disabled={withdrawUnits >= myUnitsN}
                      className="size-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-30"
                      style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                </div>

                {/* Return amount */}
                <div className="flex items-baseline justify-between border-t pt-2"
                  style={{ borderColor: 'var(--border)' }}>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    {withdrawUnits === myUnitsN ? 'You get back' : 'You get back'}
                  </span>
                  <span className="text-lg font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                    {formatUsdcPrice(withdrawReturn)}
                  </span>
                </div>

                {withdrawUnits < myUnitsN && (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    Keeps {myUnitsN - withdrawUnits} unit{myUnitsN - withdrawUnits !== 1 ? 's' : ''} and{' '}
                    {formatUsdcPrice(myEscrow - withdrawReturn)} escrowed.
                  </p>
                )}

                {/* Strand check / withdraw button */}
                {withdrawCheck.blocked ? (
                  <div className="flex items-start gap-2.5 rounded-xl p-3"
                    style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
                    <Lock className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--muted)' }} />
                    <p className="text-xs" style={{ color: 'var(--muted)' }}>{withdrawCheck.reason}</p>
                  </div>
                ) : (
                  <button
                    onClick={handleWithdraw}
                    disabled={anyBusy}
                    className="w-full rounded-xl py-2.5 text-sm font-medium transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{
                      background: 'var(--surface-muted)',
                      color: 'var(--muted)',
                      border: '1px solid var(--border)',
                    }}>
                    {withdrawBusy
                      ? <span className="flex items-center justify-center gap-2">
                          <Loader2 className="size-4 animate-spin" /> Confirming…
                        </span>
                      : withdrawUnits === myUnitsN
                        ? 'Cancel my whole order'
                        : `Remove ${withdrawUnits} unit${withdrawUnits !== 1 ? 's' : ''}`}
                  </button>
                )}

                {withdrawStep === 'error' && (
                  <div className="flex items-start gap-2 rounded-xl p-2"
                    style={{ background: 'rgba(186,43,76,0.08)' }}>
                    <AlertCircle className="size-3.5 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs" style={{ color: 'var(--danger)' }}>{withdrawErr}</p>
                      <button onClick={resetWithdraw} className="text-xs mt-0.5 underline" style={{ color: 'var(--muted)' }}>Try again</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}

      </AnimatePresence>

      <button onClick={handleAddNetwork}
        className="w-full text-xs py-1 opacity-30 hover:opacity-60 transition-opacity"
        style={{ color: 'var(--muted)' }}>
        Add {ARC_NETWORK.name} to wallet
      </button>
    </div>
  )
}

// ── Order preview card ────────────────────────────────────────────────────────

interface OrderPreviewProps {
  units:          number
  quotedPPU:      bigint
  quotedTotal:    bigint
  breaksTier:     boolean
  goodsSymbol:    string
  goodsDecimals?: number
  tokensPerUnit:  bigint
  maxOrderable:   number
  isTopUp:        boolean
  onUnits:        (n: number) => void
  badge?:         'gasless' | undefined
}

function OrderPreviewCard({
  units, quotedPPU, quotedTotal, breaksTier,
  goodsSymbol, goodsDecimals, tokensPerUnit, maxOrderable, isTopUp, onUnits, badge,
}: OrderPreviewProps) {
  const tokensReceived = BigInt(units) * tokensPerUnit

  return (
    <div className="rounded-2xl p-4 space-y-3"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)' }}>

      <div className="flex items-center gap-1.5">
        {isTopUp
          ? <><PackagePlus className="size-3.5" style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>
                Add to your order{badge === 'gasless' ? ' · no network fee' : ''}
              </span></>
          : badge === 'gasless'
            ? <><Zap className="size-3.5" style={{ color: 'var(--accent)' }} />
                <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>No network fee</span></>
            : null}
      </div>

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
          <span className="text-xl font-bold tabular-nums w-10 text-center" style={{ color: 'var(--ink)' }}>
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

      {maxOrderable > 0 && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          {isTopUp
            ? `Up to ${maxOrderable} more unit${maxOrderable !== 1 ? 's' : ''} available`
            : `Up to ${maxOrderable} unit${maxOrderable !== 1 ? 's' : ''} available`}
        </p>
      )}

      <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-baseline justify-between">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {formatUsdcPrice(quotedPPU)}/unit
          </span>
          <span className="text-2xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
            {formatUsdcPrice(quotedTotal)}
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--subtle)' }}>
          {goodsDecimals !== undefined
            ? `You will receive ${formatTokenAmount(tokensReceived, goodsDecimals)} ${goodsSymbol}`
            : null}
          {badge === 'gasless' ? ' · one signature, nothing else to pay' : ''}
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
