import { useState, useEffect } from 'react'
import { ConnectKitButton } from 'connectkit'
import { motion, AnimatePresence } from 'framer-motion'
import { Layers, PlusCircle, FlaskConical, ChevronRight, ExternalLink } from 'lucide-react'
import { DealRoom } from './swarm/DealRoom'
import { SupplierView } from './swarm/SupplierView'
import { ProofPage } from './swarm/ProofPage'
import { useDealCount } from './swarm/hooks'
import { ACTIVE_NETWORK, ARC_NETWORK, DEPLOYMENT_READY } from './swarm/config'

type Tab = 'deal' | 'post' | 'proof'

function readDealId(): bigint | undefined {
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('deal')
  if (!raw) return undefined
  try { return BigInt(raw) } catch { return undefined }
}

function writeDealId(id: bigint) {
  const url = new URL(window.location.href)
  url.searchParams.set('deal', id.toString())
  window.history.replaceState(null, '', url.toString())
}

export default function App() {
  const [tab, setTab] = useState<Tab>('deal')
  const [dealId, setDealId] = useState<bigint>(() => readDealId() ?? 0n)
  const [dealInput, setDealInput] = useState('')
  const [inputError, setInputError] = useState('')

  const { data: dealCount } = useDealCount()
  const count = dealCount !== undefined ? BigInt(dealCount as bigint) : undefined
  const noDeals = count === 0n

  // Deal ids start at 1 (`dealId = ++dealCount`), so 0 is never a real deal.
  // Land on the newest deal rather than showing deal 0 as an expired one.
  const [pinned, setPinned] = useState(() => readDealId() !== undefined)
  useEffect(() => {
    if (pinned || count === undefined || count === 0n) return
    setDealId(count)
    setPinned(true)
  }, [count, pinned])

  // Keep URL in sync, but not before we know which deal to show.
  useEffect(() => { if (dealId > 0n) writeDealId(dealId) }, [dealId])

  const handleNavigateDeal = () => {
    const trimmed = dealInput.trim()
    if (!trimmed) { setInputError('Enter a deal ID'); return }
    try {
      const id = BigInt(trimmed)
      if (id < 0n) { setInputError('Deal ID must be positive'); return }
      setDealId(id)
      setDealInput('')
      setInputError('')
      setTab('deal')
    } catch {
      setInputError('Invalid deal ID')
    }
  }

  const handleDealPosted = (id: bigint) => {
    setDealId(id)
    setTab('deal')
  }

  // ─── render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      {/* Nav */}
      <nav
        className="sticky top-0 z-40 w-full"
        style={{ background: 'rgba(255,255,255,0.80)', backdropFilter: 'blur(32px) saturate(200%)', WebkitBackdropFilter: 'blur(32px) saturate(200%)', borderBottom: '1px solid var(--border)' }}
      >
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          {/* Wordmark — the word itself is the first thing to go on a narrow
              screen; the mark and the network badge both have to stay. */}
          <div className="flex items-center gap-2 mr-1 shrink-0 min-w-0">
            <div className="size-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--accent)' }}>
              <Layers className="size-4 text-white" />
            </div>
            <span className="display text-base font-bold hidden sm:inline" style={{ color: 'var(--ink)' }}>Swarm</span>
            {ACTIVE_NETWORK === 'testnet' && (
              <span className="text-xs font-medium px-1.5 py-0.5 rounded-md shrink-0" style={{ background: 'rgba(26,128,71,0.1)', color: 'var(--success)' }}>
                testnet
              </span>
            )}
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 flex-1 justify-center min-w-0">
            {([
              { id: 'deal' as Tab, label: 'Deal room', Icon: Layers },
              { id: 'post' as Tab, label: 'Post', Icon: PlusCircle },
              { id: 'proof' as Tab, label: 'Proof', Icon: FlaskConical },
            ] as const).map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all"
                style={{
                  background: tab === id ? 'var(--accent)' : 'transparent',
                  color: tab === id ? '#fff' : 'var(--muted)',
                }}
              >
                <Icon className="size-3.5" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          {/* Wallet */}
          <div className="shrink-0">
            <ConnectKitButton />
          </div>
        </div>
      </nav>

      {/* No deployment on the active network — refuse rather than let a wallet
          sign against a zero address. */}
      {!DEPLOYMENT_READY && (
        <div className="max-w-2xl mx-auto px-4 pt-4">
          <div
            className="rounded-2xl p-3 text-sm"
            style={{ background: 'rgba(197,48,48,0.08)', border: '1px solid rgba(197,48,48,0.35)', color: 'var(--danger, #9B2C2C)' }}
          >
            <strong>Swarm is not deployed on {ARC_NETWORK.name} yet.</strong> Nothing
            here can be committed to. Run <code>VITE_SWARM_NETWORK=testnet</code> to
            use the verified testnet deployment.
          </div>
        </div>
      )}

      {/* Body */}
      <main className="max-w-2xl mx-auto">
        {/* Deal ID navigator — shown in deal tab */}
        {tab === 'deal' && (
          <div className="px-4 pt-5">
            <div
              className="rounded-2xl p-3 flex gap-2 items-center"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)' }}
            >
              <input
                type="number"
                min="0"
                value={dealInput}
                onChange={e => { setDealInput(e.target.value); setInputError('') }}
                onKeyDown={e => e.key === 'Enter' && handleNavigateDeal()}
                placeholder={`Deal ID (current: ${dealId.toString()})`}
                className="flex-1 bg-transparent text-sm outline-none tabular-nums placeholder:text-slate-300"
                style={{ color: 'var(--ink)' }}
              />
              {dealCount !== undefined && (
                <span className="text-xs shrink-0" style={{ color: 'var(--subtle)' }}>
                  of {dealCount.toString()}
                </span>
              )}
              <button
                onClick={handleNavigateDeal}
                className="flex items-center gap-1 text-xs font-semibold rounded-lg px-2.5 py-1.5 transition-all hover:scale-[1.02] active:scale-[0.98]"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                Go <ChevronRight className="size-3" />
              </button>
            </div>
            {inputError && (
              <p className="text-xs mt-1 px-1" style={{ color: 'var(--danger)' }}>{inputError}</p>
            )}
            <a
              href={`${ARC_NETWORK.explorerBase}/address/${import.meta.env.VITE_DEAL_FACTORY_ADDRESS ?? ''}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 mt-2 px-1 text-xs"
              style={{ color: 'var(--subtle)' }}
            >
              View DealFactory on explorer <ExternalLink className="size-3" />
            </a>
          </div>
        )}

        {/* Tab content */}
        <AnimatePresence mode="wait">
          {tab === 'deal' && (
            <motion.div key="deal" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              {noDeals || dealId === 0n ? (
                <div className="px-4 pt-6">
                  <div
                    className="rounded-2xl p-6 text-center"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                  >
                    <p className="display text-lg font-bold" style={{ color: 'var(--ink)' }}>
                      {noDeals ? 'No deals yet' : 'Loading deals…'}
                    </p>
                    {noDeals && (
                      <>
                        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
                          Nobody has posted a deal on {ARC_NETWORK.name} yet. Post the first one and watch the price fall as buyers join.
                        </p>
                        <button
                          onClick={() => setTab('post')}
                          className="mt-4 px-4 py-2 rounded-xl text-sm font-medium"
                          style={{ background: 'var(--accent)', color: '#fff' }}
                        >
                          Post a deal
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <DealRoom dealId={dealId} />
              )}
            </motion.div>
          )}
          {tab === 'post' && (
            <motion.div key="post" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <SupplierView onDealPosted={handleDealPosted} />
            </motion.div>
          )}
          {tab === 'proof' && (
            <motion.div key="proof" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <ProofPage />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  )
}
