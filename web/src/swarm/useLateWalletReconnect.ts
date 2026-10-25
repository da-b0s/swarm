import { useEffect, useRef } from 'react'
import { useConfig, useReconnect } from 'wagmi'

const ANSWER_TIMEOUT_MS = 4000
const CONNECT_TIMEOUT_MS = 8000
const ATTEMPTS = 3

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])
}

/**
 * Restores the saved wallet connection after a page reload. Replaces wagmi's
 * reconnectOnMount, which main.tsx turns off.
 *
 * wagmi's built-in restore asks the wallet about the saved connection with no
 * timeout. When an extension wallet never answers one of those early requests,
 * the restore hangs: the page shows a remembered address but is not connected,
 * and connecting again is refused because wagmi considers that wallet already
 * connected. Reproduced with a stand-in wallet that ignores its first request.
 * Extension wallets can also announce themselves (EIP-6963) only after the app
 * has started, which the built-in restore misses.
 *
 * Here every wallet request has a timeout and is retried with a fresh request,
 * the restore runs again whenever a wallet announces itself, and if the wallet
 * never answers the page is simply left disconnected with a working Connect
 * button. A deliberate disconnect is respected: wagmi's isAuthorized() returns
 * false once the user has disconnected.
 */
export function useLateWalletReconnect() {
  const config = useConfig()
  const { reconnectAsync } = useReconnect()
  const running = useRef(false)

  useEffect(() => {
    // Read wagmi's live status at the moment it matters, not a render snapshot.
    const busy = () => config.state.status === 'connected' || config.state.status === 'connecting'
    const restore = async () => {
      if (running.current || busy()) return
      running.current = true
      try {
        const recentId = await config.storage?.getItem('recentConnectorId')
        if (!recentId) return
        const connector = config.connectors.find((c) => c.id === recentId)
        if (!connector) return // not announced yet; the announcement listener retries

        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          let authorized: boolean
          try {
            authorized = await withTimeout(connector.isAuthorized(), ANSWER_TIMEOUT_MS)
          } catch {
            continue // no answer: ask again with a fresh request
          }
          if (!authorized) return // not authorised, or the user disconnected
          if (busy()) return
          try {
            // wagmi's reconnect path, limited to this connector. An ordinary
            // connect sends wallet_requestPermissions, which opens a MetaMask
            // popup on every reload; reconnecting does not.
            const restored = await withTimeout(reconnectAsync({ connectors: [connector] }), CONNECT_TIMEOUT_MS)
            if (restored.length > 0) return
          } catch {
            // timed out
          }
          const st = config.state.status
          if (st === 'reconnecting' || st === 'connecting') {
            config.setState((x) => ({ ...x, connections: new Map(), current: null, status: 'disconnected' }))
          }
        }
      } finally {
        running.current = false
      }
    }

    void restore()
    const onAnnounce = () => { setTimeout(() => { void restore() }, 50) }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.addEventListener('ethereum#initialized', onAnnounce)
    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
      window.removeEventListener('ethereum#initialized', onAnnounce)
    }
  }, [config, reconnectAsync])
}
