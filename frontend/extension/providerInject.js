// Injected into the MAIN world of matched pages (see manifest.json content_scripts) so
// `window.vfWallet` exists in the PAGE's own JS realm — required for a Stellar Wallets Kit
// custom module (frontend/src/stellar/vfWalletModule.js) to detect + call VF Wallet, mirroring
// how Freighter/xBull expose a window-level provider object.
//
// MAIN-world scripts have NO chrome.* API access, so every call is relayed over
// window.postMessage to providerBridge.js — the paired ISOLATED-world content script declared
// right after this one in manifest.json, which alone can reach chrome.runtime.
//
// Authored with `export` for unit-testability (vitest imports the factory directly). The
// extension build (vite.config.extension.js) strips the keyword before copying into
// extension-dist — MAIN-world content scripts are plain classic scripts, not ES modules,
// exactly like background.js's service worker.
export const CHANNEL = 'vf-wallet-rpc'

/**
 * Builds the window.vfWallet object. `post`/`listen` are injectable so this is testable without
 * a real window (defaults to window.postMessage / window.addEventListener('message', ...)).
 */
export function createVfWalletProvider({ post, listen } = {}) {
  post = post ?? ((msg) => window.postMessage(msg, '*'))
  listen = listen ?? ((fn) => window.addEventListener('message', fn))
  let seq = 0
  const pending = new Map()

  listen((event) => {
    if (event.source !== window) return
    const msg = event.data
    if (!msg || msg.channel !== CHANNEL || msg.dir !== 'res') return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) {
      // error is either a legacy string or a SEP-43 {code, message} object (providerBridge.js).
      const isObj = typeof msg.error === 'object' && msg.error !== null
      const err = new Error(isObj ? (msg.error.message ?? 'VF Wallet request failed') : msg.error)
      if (isObj && msg.error.code !== undefined) err.code = msg.error.code
      p.reject(err)
    } else p.resolve(msg.result)
  })

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = `vf-${Date.now()}-${seq++}`
      pending.set(id, { resolve, reject })
      post({ channel: CHANNEL, dir: 'req', id, method, params })
    })
  }

  return {
    isConnected: () => call('isConnected'),
    getAddress: (params) => call('getAddress', params),
    signTransaction: (xdr, opts) => call('signTransaction', { xdr, opts }),
    signAuthEntry: (authEntry, opts) => call('signAuthEntry', { authEntry, opts }),
  }
}

// Real wiring — only when actually running as an injected page script (a no-op under vitest,
// where `window` either doesn't exist or isn't the real browser window).
if (typeof window !== 'undefined' && !window.vfWallet) {
  window.vfWallet = createVfWalletProvider()
  window.dispatchEvent(new Event('vfWallet#initialized'))
}
