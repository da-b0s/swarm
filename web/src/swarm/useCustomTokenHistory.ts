/**
 * useCustomTokenHistory — persist and recall unverified token addresses the
 * seller has used before (pasted in "Other token…" or found in their own deals).
 *
 * Storage: localStorage key `swarm.customTokens`, JSON array of lowercase
 * 0x-addresses, newest-first, capped at MAX_HISTORY entries.
 * All reads/writes are wrapped in try/catch so a broken localStorage never
 * crashes the sell page.
 */

import { useState, useEffect } from 'react'

const LS_KEY      = 'swarm.customTokens'
const MAX_HISTORY = 10

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && v.startsWith('0x'))
  } catch {
    return []
  }
}

function writeHistory(addrs: string[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(addrs))
  } catch {
    // ignore
  }
}

/** Add `address` (lowercased) to the front of the history, deduplicating and
 *  capping at MAX_HISTORY. Also fires a same-tab event so the hook refreshes. */
export function recordCustomToken(address: string): void {
  const lower   = address.toLowerCase()
  const current = readHistory().filter(a => a !== lower)
  writeHistory([lower, ...current].slice(0, MAX_HISTORY))
  try { window.dispatchEvent(new Event('swarm-custom-tokens')) } catch { /* ignore */ }
}

/** Return stored history as a live array; updates on same-tab writes and
 *  cross-tab storage events. */
export function useCustomTokenHistory(): string[] {
  const [history, setHistory] = useState<string[]>(() => readHistory())

  useEffect(() => {
    const refresh = () => setHistory(readHistory())
    window.addEventListener('swarm-custom-tokens', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('swarm-custom-tokens', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  return history
}
