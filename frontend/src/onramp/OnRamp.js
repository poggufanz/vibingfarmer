// Stable on-ramp interface (Approach C, SP4 — optional, last).
// See docs/superpowers/specs/2026-07-04-approach-c-hybrid-cross-chain-design.md §5.4/§9 and
// docs/superpowers/plans/2026-07-05-approach-c-product-build.md Phase SP4 / Task 4.1.
//
// The app calls OnRamp.open({ address, amount }); WHICH concrete widget runs is swappable
// behind this contract (registered in PROVIDERS). This file intentionally has NO import of
// transak.js/coinbase.js — concrete adapters register themselves via registerProvider() as
// their own last build step (Task 4.3 / Task 4.4), so this interface is buildable and fully
// testable before either concrete provider exists.

/**
 * @typedef {object} OnRampRequest
 * @property {string} address   destination address (a Stellar G… address for the primary provider)
 * @property {number} [amount]  optional preset fiat amount in USD
 */
/**
 * @typedef {object} OnRampResult
 * @property {boolean} completed   true once the widget reports a successful order
 * @property {string} [orderId]    provider order id, when completed
 * @property {string} network      'stellar' | 'base' — which chain actually received the funds
 */
/**
 * @typedef {object} OnRampProvider
 * @property {(req: OnRampRequest) => Promise<OnRampResult>} open
 */

/** Registry of swappable providers, keyed by name. Populated by each adapter module. */
export const PROVIDERS = {}

/** Name of the provider `open()` uses when none is passed explicitly. */
let defaultProviderName = null

/**
 * Register a concrete provider under `name`. The FIRST provider ever registered also becomes
 * the default (later registrations only add to PROVIDERS, they don't steal default status —
 * this keeps the primary Stellar-direct provider default even after a fallback registers).
 * @param {string} name
 * @param {OnRampProvider} provider
 */
export function registerProvider(name, provider) {
  PROVIDERS[name] = provider
  // Elect a default only when there isn't a live one. In the real app providers are never
  // removed, so the primary (first-registered) stays default forever; the `!PROVIDERS[...]`
  // clause just lets a fresh default take over if the prior one was cleared (test isolation).
  if (!defaultProviderName || !PROVIDERS[defaultProviderName]) defaultProviderName = name
}

/**
 * Open the on-ramp widget for `req`. Uses the default (first-registered) provider unless
 * `provider` is passed explicitly — pass one to target a specific fallback, e.g.
 * `open(req, PROVIDERS['coinbase-base'])`.
 * @param {OnRampRequest} req
 * @param {OnRampProvider} [provider]
 * @returns {Promise<OnRampResult>}
 */
export function open(req, provider) {
  if (!req || typeof req.address !== 'string' || !req.address) {
    return Promise.reject(new Error('OnRamp.open: address is required'))
  }
  const target = provider || PROVIDERS[defaultProviderName]
  if (!target) {
    return Promise.reject(new Error('OnRamp.open: no provider registered'))
  }
  return target.open(req)
}

export const OnRamp = { open, PROVIDERS, registerProvider }
export default OnRamp
