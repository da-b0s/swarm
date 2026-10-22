import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { formatUsdcPrice } from './utils'

interface Props {
  price: bigint
  loading: boolean
}

/** Big animated price display. Drops with a celebratory flash when tier breaks. */
export function PriceHero({ price, loading }: Props) {
  const prevPrice = useRef(price)
  const [flash, setFlash] = useState<'down' | null>(null)

  useEffect(() => {
    if (price < prevPrice.current && prevPrice.current > 0n) {
      setFlash('down')
      const t = setTimeout(() => setFlash(null), 1200)
      prevPrice.current = price
      return () => clearTimeout(t)
    }
    prevPrice.current = price
  }, [price])

  const formatted = loading ? '—' : formatUsdcPrice(price)

  return (
    <div className="relative flex flex-col items-center select-none">
      {/* Celebratory ring on tier break */}
      <AnimatePresence>
        {flash === 'down' && (
          <motion.div
            key="ring"
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgba(26,128,71,0.18) 0%, transparent 70%)' }}
            initial={{ scale: 0.6, opacity: 0.9 }}
            animate={{ scale: 2.2, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9, ease: 'easeOut' }}
          />
        )}
      </AnimatePresence>

      <span
        className="text-xs font-semibold tracking-widest uppercase mb-2"
        style={{ color: 'var(--muted)' }}
      >
        Current price
      </span>

      <motion.div
        key={formatted}
        className="display tabular-nums font-bold leading-none"
        style={{
          fontSize: 'clamp(3.5rem, 14vw, 7rem)',
          letterSpacing: '-0.04em',
          color: flash === 'down' ? 'var(--success)' : 'var(--ink)',
          transition: 'color 0.6s ease',
        }}
        initial={{ opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 28 }}
      >
        {formatted}
      </motion.div>

      {flash === 'down' && (
        <motion.div
          className="mt-2 text-sm font-semibold"
          style={{ color: 'var(--success)' }}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          Price dropped
        </motion.div>
      )}
    </div>
  )
}
