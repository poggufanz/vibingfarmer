// Pure-ish router so it is unit-testable; chrome.* is injected as `env`.
const inflight = new Map()

export async function handleMessage(msg, env, reply) {
  const tabs = env.tabs ?? chrome.tabs
  const pending = env.pending ?? inflight

  if (msg.type === 'SIGN_REQUEST') {
    const base =
      typeof chrome !== 'undefined' && chrome?.runtime?.getURL
        ? chrome.runtime.getURL('ceremony.html')
        : 'ceremony.html'
    const url = `${base}?challenge=${encodeURIComponent(msg.challenge)}&rpId=${encodeURIComponent(msg.rpId)}`
    const tab = await tabs.create({ url, active: true })
    pending.set(tab.id, reply)
    return
  }

  if (msg.type === 'CEREMONY_RESULT') {
    const r = pending.get(msg.tabId)
    if (r) {
      r({ type: 'SIGN_RESULT', assertion: msg.assertion })
      pending.delete(msg.tabId)
    }
  }
}

// Attach to the real chrome runtime only when running as a service worker.
if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg, {}, sendResponse)
    return true // keep channel open for async reply
  })
}
