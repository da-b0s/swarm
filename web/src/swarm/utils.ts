/** Shared formatting and math utilities for Swarm UI */

import { ARC_NETWORK } from './config'

/** Format 6-decimal micro-USDC bigint as "$X.XX" */
export function formatUsdcPrice(raw: bigint | number): string {
  const n = typeof raw === 'bigint' ? Number(raw) : raw
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n / 1_000_000)
}

/** Format 18-decimal native Arc balance as "$X.XX" (divide by 10^12 first) */
export function formatNativeBalance(raw: bigint): string {
  // Native is 18-dec USDC, ERC-20 view is 6-dec. raw / 1e12 gives 6-dec view.
  const sixDec = raw / 1_000_000_000_000n
  return formatUsdcPrice(sixDec)
}

/** Shorten address: 0x1234...abcd */
export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

/** Explorer link for a transaction hash */
export function txUrl(hash: string): string {
  return `${ARC_NETWORK.explorerBase}/tx/${hash}`
}

/** Explorer link for an address */
export function addrUrl(addr: string): string {
  return `${ARC_NETWORK.explorerBase}/address/${addr}`
}

/** Format seconds remaining as "Xd Xh Xm Xs" */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'Ended'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * Compute the clearing price for a given buyer count against the tier curve.
 * Mirrors the Solidity _clearingPriceAt logic exactly.
 * tiers[0] = highest price (lowest minBuyers), tiers[last] = lowest price (highest minBuyers).
 */
export function computeClearingPrice(
  tiers: readonly { minBuyers: number; pricePerUnit: bigint }[],
  count: number,
): bigint {
  if (tiers.length === 0) return 0n
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (count >= tiers[i].minBuyers) return tiers[i].pricePerUnit
  }
  return tiers[0].pricePerUnit
}

/**
 * Check the WouldStrandBuyer precondition client-side before attempting withdraw.
 * Returns { blocked: true, reason: string } if the withdrawal would be blocked,
 * or { blocked: false } if it is safe to proceed.
 *
 * callerPrice: what the caller escrowed (uint64)
 * tierCountMap: map from pricePerUnit → count of buyers at that price
 * tiers: the deal's tier array
 * currentCount: current buyer count
 */
export function checkWouldStrandBuyer(
  callerPrice: bigint,
  tierCountMap: Map<bigint, number>,
  tiers: readonly { minBuyers: number; pricePerUnit: bigint }[],
  currentCount: number,
): { blocked: false } | { blocked: true; reason: string; nextSafeCount: number } {
  const newCount = currentCount - 1
  if (newCount <= 0) return { blocked: false } // last buyer, no one left to strand

  const newPrice = computeClearingPrice(tiers, newCount)

  // Find lowest price among remaining buyers (excluding caller)
  let lowestRemaining = 0n
  for (let i = tiers.length - 1; i >= 0; i--) {
    const tp = tiers[i].pricePerUnit
    let cnt = tierCountMap.get(tp) ?? 0
    if (tp === callerPrice && cnt > 0) cnt -= 1
    if (cnt > 0) {
      lowestRemaining = tp
      break
    }
  }

  if (lowestRemaining > 0n && lowestRemaining < newPrice) {
    // Find the next safe count: lowest threshold > currentCount
    // One more buyer would bring count to currentCount+1; check if new price ≤ lowestRemaining
    const nextSafeCount = currentCount + 1
    return {
      blocked: true,
      reason: `You can't withdraw right now — leaving would push the price back up to ${formatUsdcPrice(newPrice)}, above what the newest buyer paid (${formatUsdcPrice(lowestRemaining)}). One more buyer joins and you're free to go.`,
      nextSafeCount,
    }
  }

  return { blocked: false }
}

/** Parse a Solidity revert error name from a wagmi error message */
export function parseRevertReason(error: unknown): string {
  const msg = (error as { message?: string })?.message ?? ''
  // Common Swarm named errors
  if (msg.includes('WouldStrandBuyer'))    return 'Withdrawal would strand another buyer'
  if (msg.includes('DeadlinePassed'))      return 'The deadline has passed'
  if (msg.includes('DeadlineNotReached'))  return 'The deadline has not passed yet'
  if (msg.includes('MinBuyersNotMet'))     return 'Not enough buyers committed'
  if (msg.includes('AlreadyCommitted'))    return 'You already committed to this deal'
  if (msg.includes('BuyerCapReached'))     return 'This deal is full'
  if (msg.includes('DealNotOpen'))         return 'This deal is no longer open'
  if (msg.includes('SettlerNotConfigured')) return 'Contract not yet wired (contact support)'
  if (msg.includes('user rejected') || msg.includes('User rejected')) return 'Cancelled'
  // Allowance before balance: an ERC-20 allowance shortfall also contains the
  // word "insufficient", and reporting it as a balance problem sends the user
  // off to top up a wallet that was never short of funds.
  if (msg.includes('insufficient allowance') || msg.includes('InsufficientAllowance')) {
    return 'The approval did not cover the current price — approve again to retry'
  }
  if (msg.includes('insufficient funds')) return 'Not enough USDC to cover gas'
  if (msg.includes('insufficient')) return 'Insufficient USDC balance'
  return 'Transaction failed — please try again'
}
