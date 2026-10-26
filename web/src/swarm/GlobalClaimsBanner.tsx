/**
 * GlobalClaimsBanner — persistent banner under the nav showing any claimable
 * funds the connected wallet has across all deals.
 *
 * Checks:
 *   • Settler.claimable(address)                — USDC refunds / withdrawal fallbacks
 *   • Settler.goodsClaimable(token, address)    — for every distinct goodsToken
 *
 * Rendered on every tab so a buyer never misses pending claims.
 * Hidden when the wallet is disconnected or nothing is claimable.
 */

import { useMemo } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts } from 'wagmi'
import { useState, useEffect } from 'react'
import { Gift, Loader2 } from 'lucide-react'
import { CONTRACTS_ACTIVE, ARC_NETWORK, ARC_TX_FEES } from './config'
import { DEAL_FACTORY_ABI, SETTLER_ABI } from './abis'
import { useDealCount, useClaimable } from './hooks'
import { formatUsdcPrice, formatTokenAmount } from './utils'

const CHAIN_ID = ARC_NETWORK.chainId
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`

// ── Hook: collect distinct goodsTokens from all deals ─────────────────────────

function useGoodsTokens(dealCount: number): `0x${string}`[] {
  const calls = useMemo(() =>
    Array.from({ length: dealCount }, (_, i) => ({
      address: CONTRACTS_ACTIVE.DealFactory,
      abi: DEAL_FACTORY_ABI,
      functionName: 'getDeal' as const,
      args: [BigInt(i + 1)] as const,
      chainId: CHAIN_ID,
    })),
    [dealCount]
  )

  const { data } = useReadContracts({
    contracts: calls,
    query: { enabled: dealCount > 0, staleTime: 60_000 },
  })

  return useMemo(() => {
    if (!data) return []
    const seen = new Set<string>()
    const tokens: `0x${string}`[] = []
    for (const r of data) {
      if (r.status !== 'success' || !r.result) continue
      const tok = r.result.goodsToken
      if (tok && tok !== ZERO && !seen.has(tok.toLowerCase())) {
        seen.add(tok.toLowerCase())
        tokens.push(tok)
      }
    }
    return tokens
  }, [data])
}

// ── Hook: goodsClaimable for each token ───────────────────────────────────────

function useGoodsClaimables(
  tokens: `0x${string}`[],
  who: `0x${string}` | undefined,
): { token: `0x${string}`; amount: bigint }[] {
  const calls = useMemo(() =>
    tokens.map(tok => ({
      address: CONTRACTS_ACTIVE.Settler,
      abi: SETTLER_ABI,
      functionName: 'goodsClaimable' as const,
      args: [tok, who ?? ZERO] as const,
      chainId: CHAIN_ID,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tokens.join(','), who]
  )

  const { data } = useReadContracts({
    contracts: calls,
    query: { enabled: !!who && tokens.length > 0, refetchInterval: 6000 },
  })

  return useMemo(() => {
    if (!data) return []
    return tokens.map((tok, i) => ({
      token: tok,
      amount: data[i]?.status === 'success' ? BigInt(String(data[i].result ?? 0n)) : 0n,
    })).filter(x => x.amount > 0n)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tokens.join(',')])
}

// ── Token symbol + decimals helper ───────────────────────────────────────────

import { ERC20_ABI } from './abis'

interface TokenMeta { symbol: string; decimals: number }

function useTokenMeta(tokens: `0x${string}`[]): Map<string, TokenMeta> {
  const symbolCalls = useMemo(() =>
    tokens.map(tok => ({
      address: tok, abi: ERC20_ABI, functionName: 'symbol' as const, chainId: CHAIN_ID,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tokens.join(',')]
  )
  const decimalsCalls = useMemo(() =>
    tokens.map(tok => ({
      address: tok, abi: ERC20_ABI, functionName: 'decimals' as const, chainId: CHAIN_ID,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tokens.join(',')]
  )
  const { data: symData  } = useReadContracts({ contracts: symbolCalls,   query: { enabled: tokens.length > 0, staleTime: Infinity } })
  const { data: decData  } = useReadContracts({ contracts: decimalsCalls, query: { enabled: tokens.length > 0, staleTime: Infinity } })

  return useMemo(() => {
    const m = new Map<string, TokenMeta>()
    if (!symData || !decData) return m
    tokens.forEach((tok, i) => {
      if (symData[i]?.status === 'success' && decData[i]?.status === 'success') {
        m.set(tok.toLowerCase(), {
          symbol:   String(symData[i].result  ?? '?'),
          decimals: Number(decData[i].result  ?? 0),
        })
      }
    })
    return m
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symData, decData, tokens.join(',')])
}

// ── Banner component ──────────────────────────────────────────────────────────

export function GlobalClaimsBanner() {
  const { address, isConnected } = useAccount()
  const { data: dealCountRaw }   = useDealCount()
  const dealCount = dealCountRaw !== undefined ? Number(dealCountRaw) : 0

  const { data: usdcClaimableRaw, refetch: refetchUsdc } = useClaimable(address)
  const usdcClaimable = usdcClaimableRaw !== undefined ? BigInt(usdcClaimableRaw) : 0n

  const goodsTokens     = useGoodsTokens(dealCount)
  const goodsClaimables = useGoodsClaimables(goodsTokens, address)
  const tokenMeta       = useTokenMeta(goodsTokens)

  const { writeContract } = useWriteContract()
  const [busyToken, setBusyToken] = useState<string | null>(null)
  const [lastHash, setLastHash]   = useState<`0x${string}` | undefined>()
  const { isSuccess } = useWaitForTransactionReceipt({ hash: lastHash, chainId: CHAIN_ID })

  useEffect(() => {
    if (!isSuccess) return
    void refetchUsdc()
  }, [isSuccess, refetchUsdc])

  const claimUsdc = () => {
    setBusyToken('usdc')
    writeContract(
      { address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'claim', args: [], ...ARC_TX_FEES, chainId: CHAIN_ID },
      { onSuccess: h => { setLastHash(h); setBusyToken(null) }, onError: () => setBusyToken(null) }
    )
  }

  const claimGoods = (token: `0x${string}`) => {
    setBusyToken(token.toLowerCase())
    writeContract(
      { address: CONTRACTS_ACTIVE.Settler, abi: SETTLER_ABI, functionName: 'claimGoods', args: [token], ...ARC_TX_FEES, chainId: CHAIN_ID },
      { onSuccess: h => { setLastHash(h); setBusyToken(null) }, onError: () => setBusyToken(null) }
    )
  }

  if (!isConnected || !address) return null
  if (usdcClaimable === 0n && goodsClaimables.length === 0) return null

  return (
    <div className="w-full"
      style={{ background: 'rgba(26,128,71,0.07)', borderBottom: '1px solid rgba(26,128,71,0.18)' }}>
      <div className="max-w-2xl mx-auto px-4 py-2.5 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 shrink-0">
          <Gift className="size-4" style={{ color: 'var(--success)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--success)' }}>
            Ready to claim
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap flex-1">
          {usdcClaimable > 0n && (
            <button
              onClick={claimUsdc}
              disabled={!!busyToken}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] disabled:opacity-40"
              style={{ background: 'rgba(26,128,71,0.12)', color: 'var(--success)', border: '1px solid rgba(26,128,71,0.25)' }}>
              {busyToken === 'usdc'
                ? <Loader2 className="size-3.5 animate-spin" />
                : null}
              Claim {formatUsdcPrice(usdcClaimable)} USDC
            </button>
          )}

          {goodsClaimables.map(({ token, amount }) => {
            const meta = tokenMeta.get(token.toLowerCase())
            const sym  = meta?.symbol ?? '…'
            const dec  = meta?.decimals
            return (
              <button
                key={token}
                onClick={() => claimGoods(token)}
                disabled={!!busyToken}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] disabled:opacity-40"
                style={{ background: 'rgba(26,128,71,0.12)', color: 'var(--success)', border: '1px solid rgba(26,128,71,0.25)' }}>
                {busyToken === token.toLowerCase()
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : null}
                {dec !== undefined
                  ? `Claim ${formatTokenAmount(amount, dec)} ${sym}`
                  : sym !== '…' ? `Claim ${amount.toString()} ${sym}` : 'Claim tokens'}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
