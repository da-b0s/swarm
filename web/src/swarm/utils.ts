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
 * Compute how much USDC comes back from a partial or full withdrawal.
 * Mirrors the Solidity formula exactly (rounded down):
 *   returned = escrowed × units / unitsOf
 */
export function computeWithdrawReturn(
  escrowed: bigint,
  withdrawUnits: number,
  totalUnits: number,
): bigint {
  if (totalUnits === 0) return 0n
  return (escrowed * BigInt(withdrawUnits)) / BigInt(totalUnits)
}

/**
 * Check the WouldStrandBuyer precondition client-side for a withdrawal.
 *
 * v2.2: the strand check applies to partial withdrawals too. After removing
 * `withdrawUnits`, if the caller keeps some units (partial), their own
 * paidPerUnit must also be ≥ newPrice. The contract's _lowestPaidAll is used
 * for partial (includes caller); _lowestPaidExcluding for full (excludes caller).
 *
 * callerPaidPerUnit: the buyer's cheapest-lot price (paidPerUnit from chain)
 * withdrawUnits:     units being withdrawn now (may be < callerUnits = partial)
 * callerUnits:       total units the caller holds (= unitsOf from chain)
 * existingTotal:     current totalUnits (including caller's units)
 * tierCountMap:      map from pricePerUnit → count of buyers at that price
 * tiers:             the deal's tier array
 * currentBuyerCount: total buyers currently in the deal
 */
export function checkWouldStrandBuyer(
  callerPaidPerUnit: bigint,
  callerUnits: number,
  existingTotal: number,
  tierCountMap: Map<bigint, number>,
  tiers: readonly { minUnits: number; pricePerUnit: bigint }[],
  currentBuyerCount: number,
  withdrawUnits?: number,  // if undefined, withdrawing all
): { blocked: false } | { blocked: true; reason: string } {
  const wUnits    = withdrawUnits ?? callerUnits
  const isFull    = wUnits >= callerUnits
  const newTotal  = existingTotal - wUnits
  const newPrice  = computePriceAt(tiers, newTotal)

  // Single buyer, full withdrawal: never stranded
  if (currentBuyerCount <= 1 && isFull) return { blocked: false }

  if (isFull) {
    // Full withdrawal: check lowest price among remaining buyers (excluding caller's tier entry)
    let lowestRemaining = 0n
    for (let i = tiers.length - 1; i >= 0; i--) {
      const tp  = tiers[i].pricePerUnit
      let cnt   = tierCountMap.get(tp) ?? 0
      if (tp === callerPaidPerUnit && cnt > 0) cnt -= 1
      if (cnt > 0) {
        lowestRemaining = tp
        break
      }
    }
    if (lowestRemaining > 0n && lowestRemaining < newPrice) {
      return {
        blocked: true,
        reason: `Withdrawing would push the price back to ${formatUsdcPrice(newPrice)}/unit, ` +
                `above what another buyer paid (${formatUsdcPrice(lowestRemaining)}/unit). ` +
                `More orders need to join first.`,
      }
    }
  } else {
    // Partial withdrawal: caller stays in the deal, use _lowestPaidAll (includes caller)
    let lowestAll = 0n
    for (let i = tiers.length - 1; i >= 0; i--) {
      const tp  = tiers[i].pricePerUnit
      const cnt = tierCountMap.get(tp) ?? 0
      if (cnt > 0) {
        lowestAll = tp
        break
      }
    }
    if (lowestAll > 0n && lowestAll < newPrice) {
      return {
        blocked: true,
        reason: `Partially withdrawing ${wUnits} unit${wUnits !== 1 ? 's' : ''} would push the price ` +
                `back to ${formatUsdcPrice(newPrice)}/unit, above what a buyer ` +
                `(${lowestAll === callerPaidPerUnit ? 'including you' : 'another buyer'}) paid ` +
                `(${formatUsdcPrice(lowestAll)}/unit). Try fewer units.`,
      }
    }
  }

  return { blocked: false }
}

/**
 * Format a token amount in base units to a human-readable string,
 * trimming trailing zeros. Caps at 6 significant fractional digits so
 * 18-decimal tokens display sensibly.
 *
 * Examples (decimals = 6):
 *   1_000_000n → "1"
 *   1_500_000n → "1.5"
 * Examples (decimals = 18):
 *   1_000_000_000_000_000_000n → "1"
 *   1_500_000_000_000_000_000n → "1.5"
 *   1_234_567_890_000_000_000n → "1.23456789" (trimmed trailing zeros)
 *
 * While decimals are loading, callers should show nothing rather than
 * the raw number — pass undefined and check for undefined return.
 */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString()
  const scaleBig = 10n ** BigInt(decimals)
  const whole = raw / scaleBig
  const frac  = raw % scaleBig
  if (frac === 0n) return whole.toString()
  // Pad fractional part to `decimals` digits, then trim trailing zeros
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  // Cap at 6 significant fractional digits for readability on 18-decimal tokens
  const capped = fracStr.length > 6 ? fracStr.slice(0, 6).replace(/0+$/, '') : fracStr
  if (capped === '') return whole.toString()
  return `${whole}.${capped}`
}

/**
 * Compute USDC price per 1 whole token.
 *
 * The contract prices deals in USDC per unit, but a unit may be a fraction of
 * a token (e.g. 0.5 EURC). This helper gives the effective exchange rate so
 * buyers can compare against the market.
 *
 * All arithmetic is done in bigint to avoid float imprecision; the result is
 * formatted for display only.
 *
 * @param pricePerUnit  micro-USDC per unit (6-decimal, from the contract)
 * @param tokensPerUnit raw token base-units per unit (token's own decimals)
 * @param tokenDecimals decimal count of the goods token
 * @returns             formatted string like "2.26 USDC" or null when either
 *                      input is zero / undefined
 */
export function pricePerToken(
  pricePerUnit:  bigint,
  tokensPerUnit: bigint,
  tokenDecimals: number,
): string | null {
  if (!pricePerUnit || !tokensPerUnit || tokensPerUnit === 0n) return null
  // price per whole token = (pricePerUnit * 10^tokenDecimals) / tokensPerUnit
  // Keep as micro-USDC (6 decimal), multiply by 10^tokenDecimals then divide by tokensPerUnit
  const scale = 10n ** BigInt(tokenDecimals)
  const microUsdcPerToken = (pricePerUnit * scale) / tokensPerUnit
  return formatUsdcPrice(microUsdcPerToken) + ' USDC'
}

/**
 * Compute market deviation of a USDC/token rate vs a USD/token market rate.
 * @param pricePerUnit   micro-USDC per unit (contract, 6 decimals)
 * @param tokensPerUnit  token base-units per unit
 * @param tokenDecimals  decimals of goods token
 * @param marketUsdRate  USD per 1 whole token from market data (e.g. 1.08 for EUR)
 * @returns  { pct: number, label: string, severity: 'ok'|'amber'|'red' } or null
 */
export function marketDeviation(
  pricePerUnit:  bigint,
  tokensPerUnit: bigint,
  tokenDecimals: number,
  marketUsdRate: number,
): { pct: number; label: string; severity: 'ok' | 'amber' | 'red' } | null {
  if (!pricePerUnit || !tokensPerUnit || tokensPerUnit === 0n || marketUsdRate <= 0) return null
  const scale = 10n ** BigInt(tokenDecimals)
  const microUsdcPerToken = (pricePerUnit * scale) / tokensPerUnit
  const dealRate = Number(microUsdcPerToken) / 1_000_000
  const pct = ((dealRate - marketUsdRate) / marketUsdRate) * 100
  const absPct = Math.abs(pct)
  if (absPct < 0.5) return null   // not worth showing sub-half-percent noise
  const sign = pct > 0 ? '+' : ''
  const label = `${sign}${Math.round(pct)}% vs market`
  const severity: 'ok' | 'amber' | 'red' = pct > 15 ? 'red' : pct > 5 ? 'amber' : 'ok'
  return { pct, label, severity }
}

/** Parse a Solidity revert error name from a wagmi error message */
export function parseRevertReason(error: unknown): string {
  const msg = (error as { message?: string })?.message ?? ''
  if (msg.includes('WouldStrandBuyer'))       return 'Removing these units would raise the price above what another buyer paid'
  if (msg.includes('WithdrawInvalidUnits'))   return 'Choose between 1 and the number of units you hold'
  if (msg.includes('DeadlinePassed'))         return 'The deadline has passed'
  if (msg.includes('DeadlineNotReached'))     return 'The deadline has not passed yet'
  if (msg.includes('MinUnitsNotMet'))         return 'Minimum units not reached'
  if (msg.includes('BuyerCapReached'))        return 'This deal is full (buyer cap)'
  if (msg.includes('UnitCapReached'))         return 'Not enough stock remaining'
  if (msg.includes('UnitsPerBuyerExceeded'))  return 'Exceeds the per-buyer limit'
  if (msg.includes('ZeroUnits'))              return 'Quantity must be at least 1'
  if (msg.includes('DealNotOpen'))            return 'This deal is no longer open'
  if (msg.includes('SettlerNotConfigured'))   return 'Contract not yet wired (contact support)'
  if (msg.includes('user rejected') || msg.includes('User rejected')) return 'Cancelled'
  if (msg.includes('insufficient allowance') || msg.includes('InsufficientAllowance')) {
    return 'The approval did not cover the current price — approve again to retry'
  }
  if (msg.includes('insufficient funds')) return 'Not enough USDC to cover gas'
  if (msg.includes('insufficient'))       return 'Insufficient USDC balance'
  return 'Transaction failed — please try again'
}
