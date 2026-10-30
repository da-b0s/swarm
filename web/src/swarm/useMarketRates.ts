/**
 * useMarketRates — fetch USD exchange rates from CoinGecko once on mount and
 * every POLL_MARKET_RATES ms while the tab is visible.
 *
 * Endpoint:
 *   GET https://api.coingecko.com/api/v3/simple/price
 *         ?ids=usd-coin,bitcoin,ethereum&vs_currencies=usd,eur,gbp,mxn
 *
 * Mapping to Map<marketSymbol, USD per 1 whole token>:
 *   EUR = usd-coin.usd / usd-coin.eur   (USDC is the USD reference)
 *   GBP = usd-coin.usd / usd-coin.gbp
 *   MXN = usd-coin.usd / usd-coin.mxn
 *   BTC = bitcoin.usd
 *   ETH = ethereum.usd
 *
 * Any value that is missing or not a positive finite number is skipped.
 * If the fetch fails, the previous rates are kept and no error is surfaced.
 */

import { useState, useEffect, useRef } from 'react'
import { POLL_MARKET_RATES } from './config'

type RateMap = Map<string, number>

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price' +
  '?ids=usd-coin,bitcoin,ethereum&vs_currencies=usd,eur,gbp,mxn'

interface CoinGeckoResponse {
  'usd-coin'?: { usd?: number; eur?: number; gbp?: number; mxn?: number }
  bitcoin?:    { usd?: number }
  ethereum?:   { usd?: number }
}

function pos(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

async function fetchRates(): Promise<RateMap | null> {
  try {
    const res  = await fetch(COINGECKO_URL)
    if (!res.ok) return null
    const json = await res.json() as CoinGeckoResponse

    const usdc    = json['usd-coin']
    const usdcUsd = pos(usdc?.usd)  // USDC in USD — should be ~1

    const map: RateMap = new Map()

    // Fiat stablecoins: USD / (USDC per fiat unit)
    // e.g. EUR: if usd-coin.eur = 0.924, then 1 EUR = 1/0.924 USDC ≈ 1.082 USD
    if (usdcUsd !== null) {
      const usdcEur = pos(usdc?.eur)
      if (usdcEur !== null) map.set('EUR', usdcUsd / usdcEur)

      const usdcGbp = pos(usdc?.gbp)
      if (usdcGbp !== null) map.set('GBP', usdcUsd / usdcGbp)

      const usdcMxn = pos(usdc?.mxn)
      if (usdcMxn !== null) map.set('MXN', usdcUsd / usdcMxn)
    }

    const btcUsd = pos(json.bitcoin?.usd)
    if (btcUsd !== null) map.set('BTC', btcUsd)

    const ethUsd = pos(json.ethereum?.usd)
    if (ethUsd !== null) map.set('ETH', ethUsd)

    return map.size > 0 ? map : null
  } catch {
    return null
  }
}

/**
 * Returns a Map from marketSymbol (e.g. "EUR") to USD per 1 whole token.
 * undefined while the first fetch is in flight.
 * Never throws; silently keeps stale data on error.
 */
export function useMarketRates(): RateMap | undefined {
  const [rates, setRates] = useState<RateMap | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const result = await fetchRates()
      if (!cancelled && result) setRates(result)
    }

    const schedule = () => {
      if (document.hidden) {
        // Tab hidden: wait until it becomes visible again before fetching
        const onVisible = () => {
          document.removeEventListener('visibilitychange', onVisible)
          void load().then(scheduleNext)
        }
        document.addEventListener('visibilitychange', onVisible)
        return
      }
      void load().then(scheduleNext)
    }

    const scheduleNext = () => {
      if (cancelled) return
      timerRef.current = setTimeout(schedule, POLL_MARKET_RATES)
    }

    void load().then(scheduleNext)

    return () => {
      cancelled = true
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  return rates
}
