// Transak on-ramp adapter (SP4, primary provider) — implements OnRamp's `open({address,amount})`
// contract by delivering USDC DIRECTLY to a Stellar G… address.
//
// Verified via Transak's public getCryptoCurrencies API: an entry with
// { symbol:'USDC', network:{name:'stellar'}, uniqueId:'USDCstellar', isSellAllowed:false }
// exists (buy-only, matching our on-ramp-only need) —
// https://docs.transak.com/api/public/get-crypto-currencies — and transak.com/buy/usdc has a
// dedicated "How to directly buy USDC on Stellar chain" section. MoonPay's Stellar/USDC support
// could not be confirmed current in 2026 (only native XLM with a memo tag is documented);
// Coinbase Onramp's own docs list USDC networks as Ethereum/Base/Polygon/Solana/Optimism/
// Avalanche/Arbitrum — Stellar is NOT included. See ./coinbase.js for the documented
// Base-delivery fallback (spec §9) if Transak becomes unavailable for a user's country/KYC tier.
//
// Session URLs are minted server-side (frontend/api/onramp-session.js) so the Transak
// ACCESS_TOKEN secret never reaches the client bundle — mirrors the existing
// frontend/src/stellar/relay.js <-> frontend/api/stellar-relay.js split in this codebase.

import { registerProvider } from './OnRamp.js'

/**
 * @typedef {import('./OnRamp.js').OnRampRequest} OnRampRequest
 * @typedef {import('./OnRamp.js').OnRampResult} OnRampResult
 */

/**
 * Fetch a one-time Transak widgetUrl for `address`/`amount` from our own server proxy.
 * @param {OnRampRequest} req
 * @returns {Promise<string>} widgetUrl
 */
async function fetchWidgetUrl({ address, amount }) {
  const res = await fetch('/api/onramp-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'transak', address, amount }),
  })
  if (!res.ok) throw new Error('on-ramp session unavailable')
  const data = await res.json()
  if (!data.widgetUrl) throw new Error('on-ramp session missing widgetUrl')
  return data.widgetUrl
}

/**
 * Open the Transak widget for `widgetUrl` and resolve once the user finishes or closes it.
 * Split out from `open()` so tests can inject a fake SDK module without touching the DOM.
 * @param {string} widgetUrl
 * @param {{ Transak: any }} sdk  the `@transak/ui-js-sdk` module (or a test double)
 * @returns {Promise<OnRampResult>}
 */
export function launchWidget(widgetUrl, sdk) {
  const { Transak } = sdk
  return new Promise((resolve, reject) => {
    let transak
    try {
      // No containerId => Transak renders as a modal overlay (per @transak/ui-js-sdk's README:
      // "If you want to use our modal UI, do not pass the containerId").
      transak = new Transak({ widgetUrl, widgetWidth: '450px', widgetHeight: '650px' })
      transak.init()
    } catch (e) {
      reject(e)
      return
    }
    Transak.on(Transak.EVENTS.TRANSAK_ORDER_SUCCESSFUL, (orderData) => {
      transak.cleanup()
      // VERIFY: exact TRANSAK_ORDER_SUCCESSFUL payload shape against a live sandbox run before
      // go-live — the SDK docs show the callback signature but not the full orderData schema.
      // https://registry.npmjs.org/@transak/ui-js-sdk
      resolve({
        completed: true,
        orderId: orderData?.id ?? orderData?.status?.id,
        network: 'stellar',
      })
    })
    Transak.on(Transak.EVENTS.TRANSAK_WIDGET_CLOSE, () => {
      transak.cleanup()
      resolve({ completed: false, network: 'stellar' })
    })
  })
}

/**
 * Transak on-ramp provider — implements the OnRamp interface (see ./OnRamp.js).
 * @param {OnRampRequest} req
 * @returns {Promise<OnRampResult>}
 */
export async function open(req) {
  const widgetUrl = await fetchWidgetUrl(req)
  const sdk = await import('@transak/ui-js-sdk')
  return launchWidget(widgetUrl, sdk)
}

export const transakOnRamp = { open }
registerProvider('transak', transakOnRamp)
