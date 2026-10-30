/**
 * PricePerToken — inline rate display for a deal unit price.
 *
 * Shows "2.26 USDC per EURC" next to any per-unit price.
 * When a market rate is available, adds "x% vs market" in amber or red
 * when the deal price is significantly above the market rate.
 *
 * When tokensPerUnit is exactly 1 whole token (i.e. 10^decimals base units),
 * the per-token price equals the per-unit price and we show it once without
 * a redundant "N USDC per UNIT = N USDC per TOKEN" repetition.
 *
 * Usage:
 *   <PricePerToken
 *     pricePerUnit={clearingPrice}
 *     tokensPerUnit={deal.tokensPerUnit}
 *     tokenDecimals={tokenDecimals}
 *     tokenSymbol={goodsSymbol}
 *     marketRate={rates?.get(token.marketSymbol)}
 *   />
 */

import { pricePerToken, marketDeviation } from './utils'

interface Props {
  pricePerUnit:  bigint
  tokensPerUnit: bigint
  tokenDecimals: number | undefined
  tokenSymbol:   string
  marketRate?:   number        // USD per 1 whole token; omit when unavailable
  className?:    string
}

export function PricePerToken({
  pricePerUnit, tokensPerUnit, tokenDecimals, tokenSymbol, marketRate, className,
}: Props) {
  if (tokenDecimals === undefined || !pricePerUnit || !tokensPerUnit) return null

  const rate = pricePerToken(pricePerUnit, tokensPerUnit, tokenDecimals)
  if (!rate) return null

  // Check if 1 unit IS 1 whole token — if so don't repeat the price
  const oneWholeToken = 10n ** BigInt(tokenDecimals)
  const isOneWhole = tokensPerUnit === oneWholeToken

  const dev = marketRate !== undefined
    ? marketDeviation(pricePerUnit, tokensPerUnit, tokenDecimals, marketRate)
    : null

  const devColor = dev?.severity === 'red' ? 'var(--danger)' : 'var(--warn, #b45309)'

  if (isOneWhole) {
    // Per-unit price IS per-token price — just show the market deviation if any
    if (!dev) return null
    return (
      <span className={className} style={{ color: devColor }}>
        {dev.label}
      </span>
    )
  }

  return (
    <span className={className} style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'baseline', gap: '0.3em', flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--ink-2)' }}>{rate} per {tokenSymbol}</span>
      {dev && (
        <span style={{ color: devColor, fontSize: '0.9em' }}>({dev.label})</span>
      )}
    </span>
  )
}
