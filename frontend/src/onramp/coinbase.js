// Documented fallback on-ramp (spec §9): "if no 2026 provider supports USDC-to-Stellar
// directly (fallback: on-ramp to Base, skip the Stellar hub for funding only)". Coinbase
// Onramp's own docs confirm USDC delivery on Ethereum/Base/Polygon/Solana/Optimism/Avalanche/
// Arbitrum — Stellar is NOT among them — so this adapter targets BASE instead of Stellar.
// https://docs.cdp.coinbase.com/onramp/additional-resources/faq
//
// Use this ONLY when ./transak.js is unavailable for a user's country/KYC tier. Its
// `OnRampRequest.address` MUST be a Base 0x… address, not a Stellar G… address — callers
// switch the destination, not just the provider, when they fall back to this adapter.
//
// The server-side branch for provider:'coinbase-base' currently 501s (frontend/api/
// onramp-session.js, Task 4.2) — Coinbase's Session Token API needs a CDP-key-signed JWT,
// a materially separate integration from Transak's static access-token auth, deliberately
// deferred until this fallback is actually needed. This adapter's wiring is real and tested;
// only the server's upstream call is stubbed.

import { registerProvider } from './OnRamp.js'

/**
 * @typedef {import('./OnRamp.js').OnRampRequest} OnRampRequest
 * @typedef {import('./OnRamp.js').OnRampResult} OnRampResult
 */

/**
 * Coinbase-Base on-ramp provider — implements the OnRamp interface (see ./OnRamp.js).
 * @param {OnRampRequest} req  req.address must be a Base 0x… address
 * @returns {Promise<OnRampResult>}
 */
export async function open({ address, amount }) {
  const res = await fetch('/api/onramp-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'coinbase-base', address, amount }),
  })
  if (!res.ok) throw new Error('on-ramp session unavailable')
  const data = await res.json()
  if (!data.onrampUrl) throw new Error('on-ramp session missing onrampUrl')

  // VERIFY: Coinbase-hosted Onramp opens as a full-page redirect, not an embeddable iframe
  // widget (per docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/overview) — there is no
  // JS SDK equivalent to Transak's modal. This popup + poll-for-close is a placeholder UX;
  // confirm the desired flow (redirect vs popup) once the server branch above is built —
  // Coinbase does not emit a same-window JS completion event, so `completed` here can only
  // ever be a best-effort guess, never a confirmed order status.
  const popup = window.open(data.onrampUrl, 'coinbase-onramp', 'width=460,height=720')
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(timer)
        resolve({ completed: false, network: 'base' })
      }
    }, 500)
  })
}

export const coinbaseBaseOnRamp = { open }
registerProvider('coinbase-base', coinbaseBaseOnRamp)
