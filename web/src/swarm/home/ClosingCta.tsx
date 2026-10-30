/**
 * ClosingCta — full-width CTA band + footer.
 */

import { ArrowRight, ExternalLink } from 'lucide-react'
import { CONTRACTS_ACTIVE, ARC_NETWORK } from '../config'

interface Props {
  onBrowse: () => void
  onPost:   () => void
  onProof:  () => void
}

export function ClosingCta({ onBrowse, onPost, onProof }: Props) {
  const factoryExplorer = `${ARC_NETWORK.explorerBase}/address/${CONTRACTS_ACTIVE.DealFactory}`

  return (
    <footer>
      {/* CTA band */}
      <div className="rounded-2xl px-8 py-10 text-center"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <h2 className="display text-2xl sm:text-3xl font-bold mb-2" style={{ color: 'var(--ink)' }}>
          Bring the stock. Or bring your friends.
        </h2>
        <p className="text-sm mb-7" style={{ color: 'var(--muted)' }}>
          Sellers deposit tokens. Buyers drive the price down together.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button onClick={onPost}
            className="inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all hover:opacity-90"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            Post a deal <ArrowRight className="size-4" />
          </button>
          <button onClick={onBrowse}
            className="inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-all hover:opacity-80"
            style={{ color: 'var(--ink)', border: '1px solid var(--border)', background: 'transparent' }}>
            Browse deals
          </button>
        </div>
      </div>

      {/* Footer links */}
      <div className="mt-6 pb-8 flex flex-wrap gap-x-5 gap-y-2 text-sm justify-center"
        style={{ color: 'var(--muted)' }}>
        <button onClick={onProof} className="hover:opacity-70 transition-opacity">Proof</button>
        <a href="https://github.com/da-b0s/swarm" target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity">
          GitHub <ExternalLink className="size-3" />
        </a>
        <a href="https://studio.arc.io" target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity">
          Arc Studio <ExternalLink className="size-3" />
        </a>
        <a href={factoryExplorer} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:opacity-70 transition-opacity">
          DealFactory on-chain <ExternalLink className="size-3" />
        </a>
      </div>
    </footer>
  )
}
