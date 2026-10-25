import { useEffect } from 'react'
import { useAccount, useReconnect } from 'wagmi'

/**
 * Restores a saved wallet connection when the wallet appears after the app.
 *
 * wagmi reconnects once, on mount. A browser-extension wallet can inject itself
 * and announce over EIP-6963 a moment later; when it does, that single attempt
 * finds no connector for the saved MetaMask connection and gives up without
 * asking the wallet anything. The page then looks half-connected after a
 * refresh: the address is remembered but nothing works, and connecting again
 * collides with the stale state. Reproduced by delaying the wallet's injection
 * by 600 ms: zero wallet calls after reload.
 *
 * So retry the reconnect whenever a wallet announces itself or `window.ethereum`
 * finishes initialising, as long as we are not already connected.
 */
export function useLateWalletReconnect() {
  const { status } = useAccount()
  const { reconnect } = useReconnect()

  useEffect(() => {
    if (status === 'connected' || status === 'connecting') return
    let pending: ReturnType<typeof setTimeout> | undefined
    const retry = () => {
      // Let wagmi register the newly announced connector first.
      clearTimeout(pending)
      pending = setTimeout(() => reconnect(), 50)
    }
    window.addEventListener('eip6963:announceProvider', retry)
    window.addEventListener('ethereum#initialized', retry)
    return () => {
      clearTimeout(pending)
      window.removeEventListener('eip6963:announceProvider', retry)
      window.removeEventListener('ethereum#initialized', retry)
    }
  }, [status, reconnect])
}
