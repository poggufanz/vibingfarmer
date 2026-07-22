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

// Same "at most one G, at most one C" universe as src/wallet/activeAccount.js. Duplicated here
// (not imported) on purpose: background.js is loaded as a classic (non-module) MV3 service
// worker — vite.config.extension.js copies it byte-for-byte after stripping `export`, so a bare
// `import` statement here would be invalid syntax at runtime. Keep in sync with
// src/wallet/activeAccount.js's listWalletAccounts/resolveActiveAccount and with approve.js's
// resolveWallet (same constraint, same duplication).
const ACTIVE_ACCOUNT_KEY = 'vf_active_account_v1'
const NETWORK = 'stellar-testnet'

async function listAccountsLocal(storageLocal) {
  const [classicMap, contractId] = await Promise.all([
    readLocal(storageLocal, 'vf_classic_wallets'),
    readLocal(storageLocal, 'vf_wallet_contract'),
  ])
  const accounts = []
  const oldestClassic = Object.values(classicMap ?? {})
    .filter((rec) => rec?.publicKey)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0]
  if (oldestClassic)
    accounts.push({
      id: `${NETWORK}:${oldestClassic.publicKey}`,
      address: oldestClassic.publicKey,
      kind: 'G',
      signer: 'classic-ed25519',
    })
  if (contractId)
    accounts.push({
      id: `${NETWORK}:${contractId}`,
      address: contractId,
      kind: 'C',
      signer: 'passkey-secp256r1',
    })
  return accounts
}

// Mirrors src/wallet/activeAccount.js's isValidPersisted() field-for-field — a record must match
// the canonical account on kind, signer, AND address (not just id+kind) or it's corrupt/stale and
// must fail closed the same way in both contexts. See that file's isValidPersisted for the
// module of record; extension/background.test.js's drift-guard suite runs identical fixtures
// through both and asserts identical outcomes.
function isValidPersisted(persisted, byId) {
  if (!persisted || persisted.version !== 1 || persisted.network !== NETWORK) return false
  if (!persisted.id || !persisted.address || !persisted.kind || !persisted.signer) return false
  const canonical = byId.get(persisted.id)
  if (!canonical) return false
  return (
    canonical.kind === persisted.kind &&
    canonical.signer === persisted.signer &&
    canonical.address === persisted.address
  )
}

/** Resolves the single authoritative active account's address (chrome.storage.local only — an
 *  MV3 service worker has no window/localStorage, so this never depends on one).
 *  - An explicit, valid vf_active_account_v1 selection always wins.
 *  - Exactly one wallet on the device auto-resolves to it.
 *  - Both a classic and a passkey wallet with NO valid selection fails closed (null) — this
 *    never silently prefers the passkey account just because it exists.
 *  keep in sync with src/wallet/activeAccount.js and approve.js resolveWallet */
export async function resolveWalletAddress(storageLocal) {
  const accounts = await listAccountsLocal(storageLocal)
  const byId = new Map(accounts.map((a) => [a.id, a]))

  const persisted = await readLocal(storageLocal, ACTIVE_ACCOUNT_KEY)
  if (isValidPersisted(persisted, byId)) return byId.get(persisted.id).address

  if (accounts.length === 1) return accounts[0].address
  return null
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
