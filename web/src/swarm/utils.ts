/** Shared formatting and math utilities for Swarm v2 UI */

import { ARC_NETWORK } from './config'

/** Format 6-decimal micro-USDC bigint as "$X.XX" */
export function formatUsdcPrice(raw: bigint | number): string {
  const n = typeof raw === 'bigint' ? Number(raw) : raw
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n / 1_000_000)
}

/** Format 18-decimal native Arc balance as "$X.XX" */
export function formatNativeBalance(raw: bigint): string {
  return formatUsdcPrice(raw / 1_000_000_000_000n)
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

/** Format seconds remaining as "Xd Xh", "Xh Xm", "Xm Xs", or "Xs" */
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
 * Compute the per-unit price for a given total-units count.
 * Mirrors the Solidity _priceAt logic exactly:
 *   priceAt(units) = pricePerUnit of highest tier whose minUnits ≤ units,
 *                    or tiers[0].pricePerUnit below the first threshold.
 */
export function computePriceAt(
  tiers: readonly { minUnits: number; pricePerUnit: bigint }[],
  totalUnits: number,
): bigint {
  if (tiers.length === 0) return 0n
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (totalUnits >= tiers[i].minUnits) return tiers[i].pricePerUnit
  }
  return tiers[0].pricePerUnit
}

/**
 * Compute the total a buyer pays for `units` when current totalUnits is
 * `existingTotal`. The price includes the buyer's own units:
 *   paidPerUnit = priceAt(existingTotal + units)
 *   total       = paidPerUnit × units
 * Returns { paidPerUnit, total, breaksTier }.
 */
export function computeOrderTotal(
  tiers: readonly { minUnits: number; pricePerUnit: bigint }[],
  existingTotal: number,
  units: number,
): { paidPerUnit: bigint; total: bigint; breaksTier: boolean } {
  const priceBefore   = computePriceAt(tiers, existingTotal)
  const paidPerUnit   = computePriceAt(tiers, existingTotal + units)
  const total         = paidPerUnit * BigInt(units)
  return { paidPerUnit, total, breaksTier: paidPerUnit < priceBefore }
}

/**
 * Check the WouldStrandBuyer precondition client-side.
 * In v2, the strand check is in units: after the buyer removes their units,
 * any remaining buyer whose paidPerUnit < newPrice would be undercharged.
 *
 * callerPaidPerUnit:  per-unit price the caller locked in at commit
 * callerUnits:        units the caller ordered
 * existingTotal:      current totalUnits (including caller's units)
 * tierCountMap:       map from pricePerUnit → count of buyers at that price
 * tiers:              the deal's tier array
 */
export function checkWouldStrandBuyer(
  callerPaidPerUnit: bigint,
  callerUnits: number,
  existingTotal: number,
  tierCountMap: Map<bigint, number>,
  tiers: readonly { minUnits: number; pricePerUnit: bigint }[],
  currentBuyerCount: number,
): { blocked: false } | { blocked: true; reason: string } {
  if (currentBuyerCount <= 1) return { blocked: false } // last buyer, nobody left to strand

  const newTotal = existingTotal - callerUnits
  const newPrice = computePriceAt(tiers, newTotal)

  // Find the lowest per-unit price among remaining buyers (excluding caller's tier entry)
  let lowestRemaining = 0n
  for (let i = tiers.length - 1; i >= 0; i--) {
    const tp = tiers[i].pricePerUnit
    let cnt = tierCountMap.get(tp) ?? 0
    if (tp === callerPaidPerUnit && cnt > 0) cnt -= 1
    if (cnt > 0) {
      lowestRemaining = tp
      break
    }
  }

  if (lowestRemaining > 0n && lowestRemaining < newPrice) {
    return {
      blocked: true,
      reason: `Withdrawing would push the price back up to ${formatUsdcPrice(newPrice)}/unit, ` +
              `above what another buyer paid (${formatUsdcPrice(lowestRemaining)}/unit). ` +
              `More orders would need to join first.`,
    }
  }

  return { blocked: false }
}

/** Parse a Solidity revert error name from a wagmi error message */
export function parseRevertReason(error: unknown): string {
  const msg = (error as { message?: string })?.message ?? ''
  if (msg.includes('WouldStrandBuyer'))     return 'Withdrawal would strand another buyer'
  if (msg.includes('DeadlinePassed'))       return 'The deadline has passed'
  if (msg.includes('DeadlineNotReached'))   return 'The deadline has not passed yet'
  if (msg.includes('MinUnitsNotMet'))       return 'Minimum units not reached'
  if (msg.includes('AlreadyCommitted'))     return 'You already ordered in this deal'
  if (msg.includes('BuyerCapReached'))      return 'This deal is full (buyer cap)'
  if (msg.includes('UnitCapReached'))       return 'Not enough stock remaining'
  if (msg.includes('UnitsPerBuyerExceeded'))return 'Exceeds the per-buyer limit'
  if (msg.includes('ZeroUnits'))            return 'Quantity must be at least 1'
  if (msg.includes('DealNotOpen'))          return 'This deal is no longer open'
  if (msg.includes('SettlerNotConfigured')) return 'Contract not yet wired (contact support)'
  if (msg.includes('user rejected') || msg.includes('User rejected')) return 'Cancelled'
  if (msg.includes('insufficient allowance') || msg.includes('InsufficientAllowance')) {
    return 'The approval did not cover the current price — approve again to retry'
  }
  if (msg.includes('insufficient funds')) return 'Not enough USDC to cover gas'
  if (msg.includes('insufficient'))       return 'Insufficient USDC balance'
  return 'Transaction failed — please try again'
}
