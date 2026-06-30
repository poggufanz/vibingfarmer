// Pure-ish router so it is unit-testable; chrome.* injected as `env`.
const inflight = new Map()

export async function handleMessage(msg, env, reply) {
  // globalThis.chrome?.* so the fallbacks no-op (not throw) under unit tests,
  // where `chrome` is undefined and only the needed env members are injected.
  const tabs = env.tabs ?? globalThis.chrome?.tabs
  const storageSession = env.storageSession ?? globalThis.chrome?.storage?.session
  const runtime = env.runtime ?? globalThis.chrome?.runtime
  const pending = env.pending ?? inflight

  if (msg.type === 'SIGN_REQUEST') {
    const base =
      typeof chrome !== 'undefined' && chrome?.runtime?.getURL
        ? chrome.runtime.getURL('ceremony.html')
        : 'ceremony.html'
    const url = `${base}?action=${encodeURIComponent(msg.action)}`
    const tab = await tabs.create({ url, active: true })
    // Stash params under a per-tab key (avoids overflowing the query string).
    if (storageSession?.set) await storageSession.set({ [`vf_params_${tab.id}`]: msg.params ?? {} })
    pending.set(tab.id, reply)
    return
  }

  if (msg.type === 'CEREMONY_RESULT') {
    const result = {
      type: 'SIGN_RESULT',
      action: msg.action,
      ok: msg.ok,
      hash: msg.hash,
      status: msg.status,
      sharesBefore: msg.sharesBefore,
      sharesAfter: msg.sharesAfter,
      error: msg.error,
    }
    if (storageSession?.set)
      await storageSession.set({ vf_last_result: { ...result, at: Date.now() } })
    // Forward to an open popup (best-effort; the popup may have been dismissed by Face-ID).
    // In MV3 when no popup is open, sendMessage rejects — catch silently (result is persisted).
    runtime?.sendMessage?.(result)?.catch(() => {})
    const r = pending.get(msg.tabId)
    if (r) {
      r(result)
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
