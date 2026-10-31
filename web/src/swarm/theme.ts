import { useSyncExternalStore } from 'react'

export type ThemeMode = 'light' | 'system' | 'dark'
/** What is actually rendered — never 'system'. */
export type Theme = 'light' | 'dark'

const KEY = 'swarm-theme'

function resolveMode(mode: ThemeMode): Theme {
  if (mode === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

function readMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch { /* storage blocked */ }
  return 'system'
}

let currentMode: ThemeMode = readMode()
const listeners = new Set<() => void>()

function apply() {
  const resolved = resolveMode(currentMode)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}
apply()

// Re-apply when the OS preference changes (only matters while mode === 'system').
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentMode === 'system') {
      apply()
      listeners.forEach(l => l())
    }
  })
} catch { /* SSR / restricted env */ }

export function setTheme(mode: ThemeMode) {
  currentMode = mode
  try { localStorage.setItem(KEY, mode) } catch { /* storage blocked */ }
  apply()
  listeners.forEach(l => l())
}

/** @deprecated use setTheme */
export function toggleTheme() {
  setTheme(currentMode === 'dark' ? 'light' : 'dark')
}

/** Returns the active resolved theme ('light' | 'dark'). */
export function useTheme(): Theme {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => listeners.delete(l) },
    () => resolveMode(currentMode),
  )
}

/** Returns the stored mode ('light' | 'system' | 'dark'). */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => listeners.delete(l) },
    () => currentMode,
  )
}
