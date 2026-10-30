import { useState, useEffect } from 'react'
import { ConnectKitButton } from 'connectkit'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft, Sun, Moon, Monitor } from 'lucide-react'
import { useThemeMode, setTheme, type ThemeMode } from './swarm/theme'
import { DealRoom } from './swarm/DealRoom'
import { DealList } from './swarm/DealList'
import { HomePage } from './swarm/HomePage'
import { SupplierView } from './swarm/SupplierView'
import { ProofPage } from './swarm/ProofPage'
import { GlobalClaimsBanner } from './swarm/GlobalClaimsBanner'
import { RetiredClaims } from './swarm/RetiredClaims'
import { useLateWalletReconnect } from './swarm/useLateWalletReconnect'
import { ACTIVE_NETWORK, ARC_NETWORK, DEPLOYMENT_READY } from './swarm/config'
import { SwarmLogo } from './swarm/SwarmLogo'

type Tab = 'home' | 'deals' | 'post' | 'proof'

// ── URL param helpers ─────────────────────────────────────────────────────────

function readDealId(): bigint | undefined {
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('deal')
  if (!raw) return undefined
  try { return BigInt(raw) } catch { return undefined }
}

function writeDealId(id: bigint | null) {
  const url = new URL(window.location.href)
  if (id !== null) url.searchParams.set('deal', id.toString())
  else url.searchParams.delete('deal')
  window.history.replaceState(null, '', url.toString())
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  useLateWalletReconnect()
  const themeMode = useThemeMode()

  const [tab,     setTab]     = useState<Tab>(() => (readDealId() !== undefined ? 'deals' : 'home'))
  const [dealId,  setDealId]  = useState<bigint | null>(() => readDealId() ?? null)
  const [listTab, setListTab] = useState<'active' | 'ended'>('active')

  // If a ?deal= param was present on load, go straight to that deal room.
  // Keep URL in sync as we navigate.
  useEffect(() => { writeDealId(dealId) }, [dealId])

  const handleSelectDeal = (id: bigint) => {
    setDealId(id)
    setTab('deals')
  }

  const handleDealPosted = (id: bigint) => {
    setDealId(id)
    setTab('deals')
  }

  const handleBack = () => {
    setDealId(null)
    writeDealId(null)
  }

  const handleTabChange = (t: Tab) => {
    setTab(t)
    if (t !== 'deals') setDealId(null)
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>

      {/* Nav */}
      <nav
        className="sticky top-0 z-40 w-full"
        style={{
          background: 'var(--nav-bg)',
          backdropFilter: 'blur(32px) saturate(200%)',
          WebkitBackdropFilter: 'blur(32px) saturate(200%)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-2 sm:gap-3">
          {/* Logo + wordmark */}
          <button onClick={() => handleTabChange('home')} aria-label="Swarm home"
            className="flex items-center gap-2 shrink-0 min-w-0">
            <SwarmLogo size={28} />
            <span className="hidden sm:inline display text-base font-bold" style={{ color: 'var(--ink)' }}>Swarm</span>
            {ACTIVE_NETWORK === 'testnet' && (
              <span className="text-xs font-medium px-1.5 py-0.5 rounded-md shrink-0 hidden sm:inline"
                style={{ background: 'rgba(26,128,71,0.1)', color: 'var(--success)' }}>
                testnet
              </span>
            )}
          </button>

          {/* Tab bar — left-aligned after logo */}
          <div className="flex gap-0 sm:gap-1 ml-0 sm:ml-4">
            {(['deals', 'post', 'proof'] as const).map(id => (
              <button key={id}
                onClick={() => handleTabChange(id)}
                className="px-1.5 sm:px-3 py-1.5 rounded-xl text-sm font-medium transition-all"
                style={{
                  background: tab === id ? 'var(--accent)' : 'transparent',
                  color: tab === id ? '#fff' : 'var(--muted)',
                }}>
                {id === 'deals' ? 'Deals' : id === 'post' ? 'Sell' : 'Proof'}
              </button>
            ))}
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Theme: one button that cycles on phones, three-way control from md up */}
          <button className="md:hidden shrink-0 p-2 rounded-xl"
            onClick={() => setTheme(themeMode === 'light' ? 'dark' : themeMode === 'dark' ? 'system' : 'light')}
            aria-label={`Theme: ${themeMode}. Tap to change`}
            style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
            {themeMode === 'light' ? <Sun className="size-4" /> : themeMode === 'dark' ? <Moon className="size-4" /> : <Monitor className="size-4" />}
          </button>
          <div className="hidden md:flex shrink-0 items-center rounded-xl overflow-hidden text-xs font-medium"
            style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
            {(['light', 'system', 'dark'] as ThemeMode[]).map(m => (
              <button key={m}
                onClick={() => setTheme(m)}
                aria-label={`${m} mode`}
                aria-pressed={themeMode === m}
                className="px-2.5 py-1.5 transition-all capitalize"
                style={{
                  background: themeMode === m ? 'var(--accent)' : 'transparent',
                  color: themeMode === m ? 'var(--on-accent)' : 'var(--muted)',
                }}>
                {m}
              </button>
            ))}
          </div>

          {/* Wallet */}
          <div className="shrink-0">
            <ConnectKitButton />
          </div>
        </div>
      </nav>

      {/* Global claims banner */}
      <GlobalClaimsBanner />
      <div className="max-w-6xl mx-auto px-4 pt-3"><RetiredClaims /></div>

      {/* Deployment warning */}
      {!DEPLOYMENT_READY && (
        <div className="max-w-6xl mx-auto px-4 pt-4">
          <div className="rounded-2xl p-3 text-sm"
            style={{ background: 'rgba(197,48,48,0.08)', border: '1px solid rgba(197,48,48,0.35)', color: 'var(--danger, #9B2C2C)' }}>
            <strong>Swarm is not deployed on {ARC_NETWORK.name} yet.</strong> Nothing
            here can be committed to. Run <code>VITE_SWARM_NETWORK=testnet</code> to
            use the verified testnet deployment.
          </div>
        </div>
      )}

      {/* Body */}
      <main className="max-w-6xl mx-auto">
        <AnimatePresence mode="wait">

          {tab === 'deals' && (
            <motion.div key="deals"
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              {dealId !== null ? (
                <>
                  <div className="px-4 pt-4">
                    <button onClick={handleBack}
                      className="flex items-center gap-1 text-sm transition-all hover:opacity-70"
                      style={{ color: 'var(--muted)' }}>
                      <ChevronLeft className="size-4" />
                      All deals
                    </button>
                  </div>
                  <DealRoom dealId={dealId} />
                </>
              ) : (
                <DealList
                  activeTab={listTab}
                  onTabChange={setListTab}
                  onSelectDeal={handleSelectDeal}
                  onPost={() => handleTabChange('post')}
                />
              )}
            </motion.div>
          )}

          {tab === 'home' && (
            <motion.div key="home"
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <HomePage
                onBrowse={() => handleTabChange('deals')}
                onSell={() => handleTabChange('post')}
                onProof={() => handleTabChange('proof')}
                onSelectDeal={handleSelectDeal}
              />
            </motion.div>
          )}

          {tab === 'post' && (
            <motion.div key="post"
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <SupplierView onDealPosted={handleDealPosted} />
            </motion.div>
          )}

          {tab === 'proof' && (
            <motion.div key="proof"
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <ProofPage />
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  )
}
