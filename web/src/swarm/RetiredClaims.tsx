import { useState, useEffect } from 'react'
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { Loader2, Archive } from 'lucide-react'
import { ARC_NETWORK, ARC_TX_FEES, RETIRED_SETTLERS, POLL_LIST } from './config'
import { formatUsdcPrice } from './utils'

const CLAIM_ABI = [
  { type: 'function', name: 'claimable', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

/**
 * USDC still owed to the connected wallet by settler contracts from earlier
 * testnet deployments. The app now points at newer contracts, so without this a
 * refund or withdrawal credited by a retired deployment would be unreachable
 * from the UI, although it is safe on chain.
 */
export function RetiredClaims() {
  const { address } = useAccount()
  const { data, refetch } = useReadContracts({
    contracts: RETIRED_SETTLERS.map((s) => ({
      address: s, abi: CLAIM_ABI, functionName: 'claimable' as const,
      args: [address ?? '0x0000000000000000000000000000000000000000'] as const, chainId: ARC_NETWORK.chainId,
    })),
    query: { enabled: !!address && RETIRED_SETTLERS.length > 0, refetchInterval: POLL_LIST, refetchIntervalInBackground: false },
  })
  const owed = RETIRED_SETTLERS.map((s, i) => ({ settler: s, amount: data?.[i]?.result ?? 0n })).filter((x) => x.amount > 0n)

  const { writeContract, isPending } = useWriteContract()
  const [hash, setHash] = useState<`0x${string}` | undefined>()
  const [target, setTarget] = useState<string | null>(null)
  const { isSuccess } = useWaitForTransactionReceipt({ hash, chainId: ARC_NETWORK.chainId, query: { enabled: !!hash } })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])
  const busy = isPending || (!!hash && !isSuccess) ? target : null

  if (!address || owed.length === 0) return null
  const total = owed.reduce((a, x) => a + x.amount, 0n)

  return (
    <div className="rounded-2xl p-3 space-y-2" style={{ background: 'rgba(80,80,120,0.06)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
        <Archive className="size-4" /> {formatUsdcPrice(total)} to claim from earlier test deployments
      </div>
      {owed.map((x) => (
        <button key={x.settler} disabled={busy !== null}
          onClick={() => {
            setTarget(x.settler)
            writeContract({ address: x.settler, abi: CLAIM_ABI, functionName: 'claim', ...ARC_TX_FEES, chainId: ARC_NETWORK.chainId },
              { onSuccess: (h) => setHash(h) })
          }}
          className="w-full rounded-xl py-2 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: 'var(--accent)' }}>
          {busy === x.settler ? <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Claiming…</span> : `Claim ${formatUsdcPrice(x.amount)}`}
        </button>
      ))}
    </div>
  )
}
