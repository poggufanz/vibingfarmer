// Pure-ish router so it is unit-testable; chrome.* injected as `env`.
//
// Two request families:
//  - SIGN_REQUEST / CEREMONY_RESULT{tabId}: the wallet popup's own flows (deposit/approve) —
//    self-initiated from the extension UI, so no per-origin consent gate; keeps the original
//    ceremony-tab mechanism.
//  - PROVIDER_REQUEST / CEREMONY_RESULT{rid}: dapp requests relayed by providerBridge.js.
//    Origin comes from Chrome-verified sender.origin (pages cannot spoof it). isConnected and
//    already-approved getAddress are answered silently from storage — a passive check must
//    never open UI (that was the "keeps reconnecting" bug). Everything else opens the
//    approve.html consent popup, one window at a time (queueHolder serializes).
const inflight = new Map() // tabId -> reply (internal ceremonies)
const dappInflight = new Map() // rid -> {reply, origin, windowId, settled, release}
const globalQueue = { p: Promise.resolve() }

const REJECTED = -4 // SEP-43: user rejected
const INVALID = -3 // SEP-43: invalid client request
const SILENT_METHODS = ['isConnected', 'getAddress']
const CONSENT_METHODS = ['getAddress', 'signTransaction', 'signAuthEntry']

async function readLocal(storageLocal, key) {
  const got = (await storageLocal?.get(key)) ?? {}
  return got[key]
}

/** Passkey smart account wins; else the oldest classic wallet's G-address. */
export async function resolveWalletAddress(storageLocal) {
  const passkey = (await readLocal(storageLocal, 'vf_wallet_contract')) || null
  if (passkey) return passkey
  const classic = (await readLocal(storageLocal, 'vf_classic_wallets')) ?? {}
  const first = Object.values(classic).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0]
  return first?.publicKey ?? null
}

function settleDappRequest(pending, rid, payload) {
  const entry = pending.get(rid)
  if (!entry) return
  pending.delete(rid)
  entry.settled = true
  try {
    entry.reply(payload) // may throw if the message channel already closed — nothing to do then
  } catch {
    // reply channel gone; the queue must still advance
  } finally {
    entry.release?.() // let the approval queue move on
  }
}

export async function handleProviderMessage(msg, sender, env, reply) {
  const storageLocal = env.storageLocal ?? globalThis.chrome?.storage?.local
  const storageSession = env.storageSession ?? globalThis.chrome?.storage?.session
  const windows = env.windows ?? globalThis.chrome?.windows
  const pending = env.dappPending ?? dappInflight
  const queue = env.queueHolder ?? globalQueue
  const uuid = env.uuid ?? (() => crypto.randomUUID())

  const origin = sender?.origin ?? (sender?.url ? new URL(sender.url).origin : null)
  if (!origin || !origin.startsWith('http')) {
    reply({ ok: false, code: INVALID, error: 'VF Wallet: request origin missing' })
    return
  }
  const method = msg.method
  if (![...SILENT_METHODS, ...CONSENT_METHODS].includes(method)) {
    reply({ ok: false, code: INVALID, error: `unsupported vfWallet method: ${method}` })
    return
  }

  const allowlist = (await readLocal(storageLocal, 'vf_allowlist')) ?? {}
  const address = await resolveWalletAddress(storageLocal)
  const connected = Boolean(allowlist[origin] && address)

  if (method === 'isConnected') {
    reply({ ok: true, connected, address: connected ? address : null })
    return
  }
  if (method === 'getAddress' && connected) {
    reply({ ok: true, address })
    return
  }

  // Consent needed → stash params, queue an approval popup, keep the reply channel pending.
  const rid = uuid()
  await storageSession?.set({ [`vf_req_${rid}`]: { method, params: msg.params ?? {}, origin } })
  const entry = { reply, origin, windowId: null, settled: false, release: null }
  pending.set(rid, entry)
  queue.p = queue.p.then(async () => {
    if (entry.settled) return // settled while queued (e.g. teardown)
    try {
      const base =
        typeof chrome !== 'undefined' && chrome?.runtime?.getURL
          ? chrome.runtime.getURL('approve.html')
          : 'approve.html'
      const win = await windows.create({
        url: `${base}?rid=${encodeURIComponent(rid)}`,
        type: 'popup',
        width: 400,
        height: 640,
        focused: true,
      })
      entry.windowId = win?.id ?? null
    } catch (e) {
      // A failed windows.create must not poison queue.p: settle this request as an internal
      // error and keep the chain resolved so later consents still get their window.
      settleDappRequest(pending, rid, { ok: false, code: -1, error: String(e?.message || e) })
      return
    }
    await new Promise((resolve) => {
      if (entry.settled) return resolve()
      entry.release = resolve
    })
  })
}

/** A closed approval window without an answer = the user walked away = rejection. */
export function handleWindowRemoved(windowId, env = {}) {
  const pending = env.dappPending ?? dappInflight
  for (const [rid, entry] of pending) {
    if (entry.windowId === windowId && !entry.settled) {
      settleDappRequest(pending, rid, {
        ok: false,
        code: REJECTED,
        error: 'User rejected the request',
      })
    }
  }
}

export async function handleMessage(msg, env, reply) {
  // globalThis.chrome?.* so the fallbacks no-op (not throw) under unit tests,
  // where `chrome` is undefined and only the needed env members are injected.
  const tabs = env.tabs ?? globalThis.chrome?.tabs
  const storageSession = env.storageSession ?? globalThis.chrome?.storage?.session
  const storageLocal = env.storageLocal ?? globalThis.chrome?.storage?.local
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

  if (msg.type === 'CEREMONY_RESULT' && msg.rid) {
    // Dapp-path result from approve.html. Persist the origin's consent on success, then route
    // the payload back to the content script waiting in dappInflight. vf_last_result is NOT
    // written — that key is the wallet popup's own last-action display, not dapp business.
    const dappPending = env.dappPending ?? dappInflight
    const { type: _msgType, rid, ...rest } = msg
    const req = await readLocal(storageSession, `vf_req_${rid}`)
    if (rest.ok && req?.origin && storageLocal) {
      const allowlist = (await readLocal(storageLocal, 'vf_allowlist')) ?? {}
      if (!allowlist[req.origin]) {
        allowlist[req.origin] = { addedAt: Date.now() }
        await storageLocal.set({ vf_allowlist: allowlist })
      }
    }
    await storageSession?.remove?.(`vf_req_${rid}`)
    settleDappRequest(dappPending, rid, rest)
    return
  }

  if (msg.type === 'CEREMONY_RESULT') {
    // Spread every field the ceremony sent (deposit/approve's hash/status/shares..., plus the
    // generic wallet-kit actions' address/signedTxXdr/signedAuthEntry — see ceremony.js) instead
    // of a fixed allow-list, so new ceremony actions never need a background.js change just to
    // have their result fields reach the caller.
    const { type: _msgType, tabId: _msgTabId, ...rest } = msg
    const result = { type: 'SIGN_RESULT', ...rest }
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

/** Internal messages (SIGN_REQUEST / CEREMONY_RESULT) may only come from our own extension
 *  pages — a content script's sender.url is the web page, so it fails the prefix check. */
export function isInternalSender(sender, base = globalThis.chrome?.runtime?.getURL?.('') ?? '') {
  return Boolean(base && sender?.url?.startsWith(base))
}

// Attach to the real chrome runtime only when running as a service worker.
if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'PROVIDER_REQUEST') {
      handleProviderMessage(msg, sender, {}, sendResponse)
    } else if (isInternalSender(sender)) {
      handleMessage(msg, {}, sendResponse)
    }
    return true // keep channel open for async reply
  })
  chrome.windows?.onRemoved?.addListener?.((windowId) => handleWindowRemoved(windowId))
}
