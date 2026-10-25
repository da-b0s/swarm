import { useReadContract } from 'wagmi'
import { Wallet, ExternalLink } from 'lucide-react'
import { ARC_NETWORK, ACTIVE_NETWORK } from './config'
import { ERC20_ABI } from './abis'
import { formatUsdcPrice } from './utils'

/** The connected wallet's USDC balance (6 decimals), refreshed every few seconds. */
export function useUsdcBalance(address: `0x${string}` | undefined) {
  const { data } = useReadContract({
    address: ARC_NETWORK.usdc.address,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: ARC_NETWORK.chainId,
    query: { enabled: !!address, refetchInterval: 5000 },
  })
  return data
}

/**
 * Shown in place of an order button when the wallet cannot cover the order.
 * Asking for a signature or a transaction the wallet cannot pay for only ends in
 * a long error from the wallet; say what is needed instead.
 */
export function FundingNotice({ needed, balance }: { needed: bigint; balance: bigint }) {
  const short = needed - balance
  return (
    <div className="rounded-2xl p-4 space-y-2"
      style={{ background: 'rgba(255,160,0,0.08)', border: '1px solid rgba(255,160,0,0.25)' }}>
      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
        <Wallet className="size-4" /> Add USDC to your wallet to order
      </div>
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        This order needs {formatUsdcPrice(needed)}. Your wallet has {formatUsdcPrice(balance)} —{' '}
        {formatUsdcPrice(short)} short. On Arc, USDC also pays for gas, so this one balance covers everything.
      </p>
      {ACTIVE_NETWORK === 'testnet' && (
        <a href="https://faucet.circle.com" target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium underline" style={{ color: 'var(--accent)' }}>
          Get free test USDC (choose Arc Testnet) <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  )
}
