// ISOLATED-world content script (see manifest.json content_scripts) — the piece that can see
// both the page's window (same-world DOM, so window.postMessage/addEventListener reach the
// MAIN-world providerInject.js) AND chrome.runtime (isolated-world content scripts keep limited
// chrome.* access; MAIN-world scripts do not).
//
// Relays RPC calls from the page's injected provider (providerInject.js's window.vfWallet) to
// the EXISTING background router (background.js) as plain SIGN_REQUEST messages — reusing the
// exact tab-opening ceremony flow the popup already uses for deposit/approve (see ceremony.js),
// so there is only one ceremony-opening code path in the whole extension.
//
// Authored with `export` for unit-testability; stripped to a classic script at build time
// (vite.config.extension.js), same as background.js and providerInject.js.
export const CHANNEL = 'vf-wallet-rpc'

// window.vfWallet method -> ceremony action name (ceremony.js branches on `action`).
const ACTION_BY_METHOD = {
  isConnected: 'connect',
  getAddress: 'connect',
  signTransaction: 'signTransaction',
  signAuthEntry: 'signAuthEntry',
}

/** Maps a page RPC call to the SIGN_REQUEST background.js already knows how to handle. */
export function toSignRequest(method, params) {
  const action = ACTION_BY_METHOD[method]
  if (!action) return null
  return { type: 'SIGN_REQUEST', action, params: params ?? {} }
}

/** Maps a ceremony's CEREMONY_RESULT (relayed back as background.js's SIGN_RESULT) to the shape window.vfWallet's caller expects. */
export function toProviderResult(method, ceremonyResult) {
  if (!ceremonyResult?.ok) return { error: ceremonyResult?.error || 'VF Wallet request failed' }
  switch (method) {
    case 'isConnected':
      return { result: !!ceremonyResult.address }
    case 'getAddress':
      return { result: { address: ceremonyResult.address } }
    case 'signTransaction':
      return {
        result: { signedTxXdr: ceremonyResult.signedTxXdr, signerAddress: ceremonyResult.address },
      }
    case 'signAuthEntry':
      return {
        result: {
          signedAuthEntry: ceremonyResult.signedAuthEntry,
          signerAddress: ceremonyResult.address,
        },
      }
    default:
      return { error: `unsupported vfWallet method: ${method}` }
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
  const request = toSignRequest(msg.method, msg.params)
  if (!request) {
    post({
      channel: CHANNEL,
      dir: 'res',
      id: msg.id,
      error: `unsupported vfWallet method: ${msg.method}`,
    })
    return
  }
  try {
    const ceremonyResult = await sendMessage(request)
    const { result, error } = toProviderResult(msg.method, ceremonyResult)
    post({ channel: CHANNEL, dir: 'res', id: msg.id, result, error })
  } catch (e) {
    post({ channel: CHANNEL, dir: 'res', id: msg.id, error: String(e?.message || e) })
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
