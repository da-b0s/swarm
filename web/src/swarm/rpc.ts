/**
 * Shared RPC helpers for Arc Testnet / Mainnet eth_getLogs scanning.
 *
 * Two error classes let callers react differently:
 *   RateLimitError       — HTTP 429 or "rate limit" in message. Keep window,
 *                          wait with exponential back-off, retry.
 *   RangeTooLargeError   — "requested range too large" or similar. Halve
 *                          window, retry immediately at the same cursor.
 *
 * Any other JSON-RPC error is rethrown as a plain Error.
 */

import { ARC_NETWORK } from './config'

// ── Error classes ─────────────────────────────────────────────────────────────

/** The node is rate-limiting this client. Keep window; back off before retry. */
export class RateLimitError extends Error {
  constructor(msg: string) { super(msg); this.name = 'RateLimitError' }
}

/** The requested block range is too wide for this node. Halve window; retry. */
export class RangeTooLargeError extends Error {
  constructor(msg: string) { super(msg); this.name = 'RangeTooLargeError' }
}

// ── Core fetch ────────────────────────────────────────────────────────────────

type JsonRpcResponse<T> =
  | { result: T; error?: undefined }
  | { result?: undefined; error: { message?: string } }

/**
 * POST a JSON-RPC request to the active network's RPC endpoint.
 * Throws RateLimitError, RangeTooLargeError, or a plain Error on failure.
 */
export async function rpcFetch<T>(method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const r = await fetch(ARC_NETWORK.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  if (r.status === 429) throw new RateLimitError('rate limit exceeded (HTTP 429)')

  const json = await r.json() as JsonRpcResponse<T>
  if (json.error) {
    const msg = json.error.message ?? 'RPC error'
    const low = msg.toLowerCase()
    // Match "rate" before "limit" so "rate limit" is never mis-classified as a
    // range error (both contain the word "limit").
    if (low.includes('rate limit') || low.includes('rate_limit') || low.includes('too many requests')) {
      throw new RateLimitError(msg)
    }
    if (low.includes('range') || low.includes('too large') || low.includes('too many blocks')) {
      throw new RangeTooLargeError(msg)
    }
    throw new Error(msg)
  }
  return json.result
}

// ── eth_blockNumber ────────────────────────────────────────────────────────────

export async function getLatestBlock(): Promise<bigint> {
  return BigInt(await rpcFetch<string>('eth_blockNumber', []))
}

// ── Window-growth helpers used by both scanners ────────────────────────────────

export const SCAN_MAX_WINDOW  = 5000n
export const SCAN_MIN_WINDOW  = 500n
export const RATE_BASE_MS     = 500
export const RATE_MAX_MS      = 16_000
export const GROW_AFTER       = 4      // consecutive successes before growing
export const GROW_FACTOR      = 1.25

/** Grow `window` by GROW_FACTOR, capped at SCAN_MAX_WINDOW. */
export function growWindow(w: bigint): bigint {
  return BigInt(Math.min(Number(SCAN_MAX_WINDOW), Math.floor(Number(w) * GROW_FACTOR)))
}

/** Halve `window`, floored at SCAN_MIN_WINDOW. */
export function shrinkWindow(w: bigint): bigint {
  const half = w / 2n
  return half < SCAN_MIN_WINDOW ? SCAN_MIN_WINDOW : half
}
