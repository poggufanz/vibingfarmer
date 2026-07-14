// ISOLATED-world content script (see manifest.json content_scripts) — the piece that can see
// both the page's window (same-world DOM, so window.postMessage/addEventListener reach the
// MAIN-world providerInject.js) AND chrome.runtime (isolated-world content scripts keep limited
// chrome.* access; MAIN-world scripts do not).
//
// Relays page RPC calls to background.js as PROVIDER_REQUEST messages carrying the ORIGINAL
// method name — background needs it to answer isConnected/getAddress silently for allowlisted
// origins (no ceremony) and to open the approve.html consent window otherwise. The page origin
// is deliberately NOT in the payload: background reads Chrome-verified sender.origin, which the
// page cannot spoof.
//
// Authored with `export` for unit-testability; stripped to a classic script at build time
// (vite.config.extension.js), same as background.js and providerInject.js.
export const CHANNEL = 'vf-wallet-rpc'

const SUPPORTED_METHODS = ['isConnected', 'getAddress', 'signTransaction', 'signAuthEntry']

/** Wraps a page RPC call for background.js; null for methods VF Wallet does not support. */
export function toProviderRequest(method, params) {
  if (!SUPPORTED_METHODS.includes(method)) return null
  return { type: 'PROVIDER_REQUEST', method, params: params ?? {} }
}

/** Maps background's reply to the shape window.vfWallet's caller expects. */
export function toProviderResult(method, res) {
  if (!res?.ok) {
    return { error: { code: res?.code ?? -1, message: res?.error || 'VF Wallet request failed' } }
  }
  switch (method) {
    case 'isConnected':
      return { result: Boolean(res.connected ?? res.address) }
    case 'getAddress':
      return { result: { address: res.address } }
    case 'signTransaction':
      return { result: { signedTxXdr: res.signedTxXdr, signerAddress: res.address } }
    case 'signAuthEntry':
      return { result: { signedAuthEntry: res.signedAuthEntry, signerAddress: res.address } }
    default:
      return { error: { code: -3, message: `unsupported vfWallet method: ${method}` } }
  }
}

/**
 * Pure request handler. `env.sendMessage` stands in for chrome.runtime.sendMessage and
 * `env.post` for window.postMessage back to the page — both injectable so this is testable
 * without a real extension runtime.
 */
export async function handleProviderRequest(msg, env = {}) {
  const sendMessage = env.sendMessage ?? ((m) => chrome.runtime.sendMessage(m))
  const post = env.post ?? ((m) => window.postMessage(m, '*'))
  const request = toProviderRequest(msg.method, msg.params)
  if (!request) {
    post({
      channel: CHANNEL,
      dir: 'res',
      id: msg.id,
      error: { code: -3, message: `unsupported vfWallet method: ${msg.method}` },
    })
    return
  }
  try {
    const res = await sendMessage(request)
    const { result, error } = toProviderResult(msg.method, res)
    post({ channel: CHANNEL, dir: 'res', id: msg.id, result, error })
  } catch (e) {
    const raw = String(e?.message || e)
    // Orphaned content script: the extension was reloaded/updated while this page kept the
    // old injected script — chrome.runtime is gone until the page itself reloads.
    const message = /extension context invalidated/i.test(raw)
      ? 'VF Wallet was updated — reload this page and try again.'
      : raw
    post({
      channel: CHANNEL,
      dir: 'res',
      id: msg.id,
      error: { code: -1, message },
    })
  }
}

// Real wiring — only when actually running as a content script.
if (typeof window !== 'undefined' && globalThis.chrome?.runtime?.sendMessage) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const msg = event.data
    if (!msg || msg.channel !== CHANNEL || msg.dir !== 'req') return
    handleProviderRequest(msg)
  })
}
