import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'
const KEY = 'swarm-theme'

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* storage blocked */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

let current: Theme = initial()
const listeners = new Set<() => void>()
function apply() {
  document.documentElement.dataset.theme = current
  document.documentElement.style.colorScheme = current
}
apply()

export function toggleTheme() {
  current = current === 'dark' ? 'light' : 'dark'
  try { localStorage.setItem(KEY, current) } catch { /* storage blocked */ }
  apply()
  listeners.forEach((l) => l())
}

/** Light/dark preference: follows the system until the user picks one, then remembers it. */
export function useTheme(): Theme {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => current)
}
