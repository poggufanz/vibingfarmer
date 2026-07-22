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
const dappInflight = new Map() // rid -> {reply, origin, account, windowId, settled, release}
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
// pre-sign account re-check (same constraint, same duplication).
const ACTIVE_ACCOUNT_KEY = 'vf_active_account_v1'
const NETWORK = 'stellar-testnet'

// Same duplication constraint as ACTIVE_ACCOUNT_KEY above — keep in lockstep with
// src/wallet/consentStore.js; background.test.js's drift-guard suite runs identical fixtures
// through both and asserts identical outcomes.
const CONSENT_KEY = 'vf_consents_v2'
const REQUEST_TTL_MS = 5 * 60 * 1000
const LEGACY_ALLOWLIST_MIGRATION_KEY = 'vf_allowlist_migration_v1'

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

// Same resolution matrix as src/wallet/activeAccount.js's resolveActiveAccount, minus the
// legacy-localStorage-hint migration branch — an MV3 service worker has no window/localStorage,
// so background.js never has a legacyStorage to migrate from (that migration only ever runs from
// the popup). Never persists a selection (background.js stays read-only over storage.local's
// account keys, same as the resolveWalletAddress it now backs).
async function resolveActiveAccountLocal(storageLocal) {
  const accounts = await listAccountsLocal(storageLocal)
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const persisted = await readLocal(storageLocal, ACTIVE_ACCOUNT_KEY)
  if (isValidPersisted(persisted, byId)) {
    return { status: 'ready', account: byId.get(persisted.id) }
  }
  if (accounts.length === 0) return { status: 'empty' }
  if (accounts.length === 1) return { status: 'ready', account: accounts[0] }
  return { status: 'selection-required', accounts }
}

/** Resolves the single authoritative active account's address (chrome.storage.local only — an
 *  MV3 service worker has no window/localStorage, so this never depends on one).
 *  - An explicit, valid vf_active_account_v1 selection always wins.
 *  - Exactly one wallet on the device auto-resolves to it.
 *  - Both a classic and a passkey wallet with NO valid selection fails closed (null) — this
 *    never silently prefers the passkey account just because it exists.
 *  keep in sync with src/wallet/activeAccount.js */
export async function resolveWalletAddress(storageLocal) {
  const result = await resolveActiveAccountLocal(storageLocal)
  return result.status === 'ready' ? result.account.address : null
}

// ---- consent + request-snapshot mirror of src/wallet/consentStore.js (see that file's own
// docstring for why this can't just import it) ----

function consentId(origin, accountId) {
  return `${origin}::${accountId}`
}

function isFreshConsent(record, now) {
  return Boolean(record) && (record.expiresAt == null || now < record.expiresAt)
}

async function readConsentLocal({ origin, account, storageLocal, now }) {
  if (!origin || !account?.id) return null
  const all = (await readLocal(storageLocal, CONSENT_KEY)) ?? {}
  const record = all[consentId(origin, account.id)]
  if (!record || record.origin !== origin || record.accountId !== account.id) return null
  return isFreshConsent(record, now) ? record : null
}

async function grantConsentLocal({ origin, account, storageLocal, now }) {
  const all = (await readLocal(storageLocal, CONSENT_KEY)) ?? {}
  const record = {
    version: 2,
    origin,
    accountId: account.id,
    accountAddress: account.address,
    accountKind: account.kind,
    network: NETWORK,
    capabilities: ['readAddress', 'requestSignatures'],
    grantedAt: now,
    expiresAt: null,
  }
  all[consentId(origin, account.id)] = record
  await storageLocal?.set?.({ [CONSENT_KEY]: all })
  return record
}

function createRequestSnapshotLocal({ rid, method, params, sender, account, now }) {
  return {
    version: 1,
    rid,
    method,
    params: params ?? {},
    requester: {
      origin: sender?.origin ?? null,
      tabId: sender?.tab?.id ?? null,
      frameId: sender?.frameId ?? null,
      documentId: sender?.documentId ?? null,
    },
    account: account ?? null,
    createdAt: now,
    expiresAt: now + REQUEST_TTL_MS,
  }
}

function validateRequestSnapshotLocal(snapshot, { activeAccount, sender, now }) {
  const fail = (error) => ({ ok: false, code: INVALID, error })
  if (!snapshot || snapshot.version !== 1 || !snapshot.rid || !snapshot.method) {
    return fail('VF Wallet: request missing or invalid')
  }
  if (!snapshot.requester?.origin || !snapshot.account?.id || !snapshot.account?.address) {
    return fail('VF Wallet: request missing or invalid')
  }
  if (typeof snapshot.expiresAt !== 'number' || now > snapshot.expiresAt) {
    return fail('VF Wallet: request expired — close this window and retry from the site')
  }
  if (sender) {
    const req = snapshot.requester
    const senderTabId = sender.tab?.id ?? null
    const sameContext =
      sender.origin === req.origin &&
      senderTabId === (req.tabId ?? null) &&
      (sender.frameId ?? null) === (req.frameId ?? null) &&
      (sender.documentId ?? null) === (req.documentId ?? null)
    if (!sameContext) return fail('VF Wallet: request context changed')
  }
  if (!activeAccount || activeAccount.id !== snapshot.account.id) {
    return fail('VF Wallet: active account changed')
  }
  const wantAddress = snapshot.params?.opts?.address
  if (wantAddress && wantAddress !== snapshot.account.address) {
    return fail('VF Wallet: requested address does not match the active account')
  }
  return { ok: true }
}

/** One-time, idempotent: the pre-VFW1 model had exactly one address, no per-account concept, so
 *  migrating a legacy vf_allowlist origin is only ever safe when the device has EXACTLY ONE
 *  wallet today — any ambiguity (0 or 2+ accounts) means the "historically exposed address"
 *  can't be proven, so no authorization carries over (never grants every current account) and
 *  the origin must reconnect. Writes the migration record (+ any granted consents) before
 *  deleting the old allowlist, so a failed write leaves vf_allowlist intact for retry. */
async function migrateLegacyAllowlist({ storageLocal, now }) {
  if (await readLocal(storageLocal, LEGACY_ALLOWLIST_MIGRATION_KEY)) return
  const legacy = (await readLocal(storageLocal, 'vf_allowlist')) ?? {}
  const origins = Object.keys(legacy)
  if (origins.length === 0) {
    await storageLocal?.set?.({
      [LEGACY_ALLOWLIST_MIGRATION_KEY]: { at: now, migrated: 0, skipped: 0 },
    })
    return
  }

  const activeResult = await resolveActiveAccountLocal(storageLocal)
  const accounts = await listAccountsLocal(storageLocal)
  let migrated = 0
  let skipped = 0
  const write = {}
  if (activeResult.status === 'ready' && accounts.length === 1) {
    const consents = (await readLocal(storageLocal, CONSENT_KEY)) ?? {}
    for (const origin of origins) {
      consents[consentId(origin, activeResult.account.id)] = {
        version: 2,
        origin,
        accountId: activeResult.account.id,
        accountAddress: activeResult.account.address,
        accountKind: activeResult.account.kind,
        network: NETWORK,
        capabilities: ['readAddress', 'requestSignatures'],
        grantedAt: now,
        expiresAt: null,
      }
      migrated++
    }
    write[CONSENT_KEY] = consents
  } else {
    skipped = origins.length // ambiguous or empty — never grant; the user must reconnect
  }
  write[LEGACY_ALLOWLIST_MIGRATION_KEY] = { at: now, migrated, skipped }
  await storageLocal?.set?.(write) // one atomic write for consents + the migration record
  await storageLocal?.remove?.('vf_allowlist') // only after the write above succeeded
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
  const now = env.now ?? Date.now

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

  await migrateLegacyAllowlist({ storageLocal, now: now() })

  const activeResult = await resolveActiveAccountLocal(storageLocal)
  const account = activeResult.status === 'ready' ? activeResult.account : null

  if (method === 'isConnected') {
    const consent = account
      ? await readConsentLocal({ origin, account, storageLocal, now: now() })
      : null
    reply({ ok: true, connected: Boolean(consent), address: consent ? account.address : null })
    return
  }
  if (method === 'getAddress' && account) {
    const consent = await readConsentLocal({ origin, account, storageLocal, now: now() })
    if (consent) {
      reply({ ok: true, address: account.address })
      return
    }
  }

  // Consent needed (or no unambiguous account yet — approve.html itself renders the "create a
  // wallet first" screen) → snapshot the Chrome-verified requester + active account, queue an
  // approval popup, keep the reply channel pending.
  const rid = uuid()
  const snapshot = createRequestSnapshotLocal({
    rid,
    method,
    params: msg.params,
    sender,
    account,
    now: now(),
  })
  if (account) {
    const check = validateRequestSnapshotLocal(snapshot, {
      activeAccount: account,
      sender,
      now: now(),
    })
    if (!check.ok) {
      reply({ ok: false, code: check.code, error: check.error })
      return
    }
  }
  await storageSession?.set({ [`vf_req_${rid}`]: snapshot })
  const entry = { reply, origin, account, windowId: null, settled: false, release: null }
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

/** Fires whenever the active-account resolution could have changed (storage.onChanged on
 *  vf_active_account_v1 OR the underlying wallet set, wired below): cancels every queued/open
 *  dapp request whose snapshot account no longer matches — SEP-43 -3, never left to be silently
 *  signed/answered against a stale account — and tells every dapp tab an account change happened
 *  so window.vfWallet callers stop trusting a cached one. The broadcast NEVER carries the actual
 *  address: every tab gets it (not just consented origins), so leaking the real address here
 *  would hand any site the user's address on every switch without consent — a page that wants it
 *  re-fetches via getAddress(), which stays consent-gated. */
export async function handleActiveAccountChanged(env = {}) {
  const storageLocal = env.storageLocal ?? globalThis.chrome?.storage?.local
  const tabs = env.tabs ?? globalThis.chrome?.tabs
  const windows = env.windows ?? globalThis.chrome?.windows
  const pending = env.dappPending ?? dappInflight

  const activeResult = await resolveActiveAccountLocal(storageLocal)
  const account = activeResult.status === 'ready' ? activeResult.account : null

  for (const [rid, entry] of pending) {
    if (entry.settled) continue
    const matches = Boolean(account && entry.account && entry.account.id === account.id)
    if (matches) continue
    if (entry.windowId != null) {
      try {
        await windows?.remove?.(entry.windowId)
      } catch {
        // already closed by the user — nothing to clean up
      }
    }
    settleDappRequest(pending, rid, {
      ok: false,
      code: INVALID,
      error: 'VF Wallet: active account changed',
    })
  }

  const openTabs = (await tabs?.query?.({})) ?? []
  for (const tab of openTabs) {
    tabs?.sendMessage?.(tab.id, { type: 'VF_ACCOUNT_CHANGED', address: null })?.catch?.(() => {})
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
  const now = env.now ?? Date.now

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
    // Dapp-path result from approve.html. Re-validate the stashed snapshot (never trust a stale
    // or account-switched result — "Never grant consent from a stale result"), grant origin+
    // account consent on success, then route the payload back to the content script waiting in
    // dappInflight. vf_last_result is NOT written — that key is the wallet popup's own
    // last-action display, not dapp business.
    const dappPending = env.dappPending ?? dappInflight
    const { type: _msgType, rid, ...rest } = msg
    const snapshot = await readLocal(storageSession, `vf_req_${rid}`)
    await storageSession?.remove?.(`vf_req_${rid}`) // consume once, whatever happens next

    if (rest.ok && snapshot && storageLocal) {
      const activeResult = await resolveActiveAccountLocal(storageLocal)
      const activeAccount = activeResult.status === 'ready' ? activeResult.account : null
      const check = validateRequestSnapshotLocal(snapshot, { activeAccount, now: now() })
      if (!check.ok) {
        settleDappRequest(dappPending, rid, { ok: false, code: check.code, error: check.error })
        return
      }
      await grantConsentLocal({
        origin: snapshot.requester.origin,
        account: activeAccount,
        storageLocal,
        now: now(),
      })
    }
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

/** Whether a chrome.storage.onChanged event could have changed active-account resolution: the
 *  explicit selection key, or either wallet-set key it's derived from (a wallet appearing/
 *  disappearing changes what resolveActiveAccountLocal resolves to just as much as an explicit
 *  selection does). */
export function shouldReactToStorageChange(changes, area) {
  return Boolean(
    area === 'local' &&
    (changes?.[ACTIVE_ACCOUNT_KEY] ||
      changes?.['vf_wallet_contract'] ||
      changes?.['vf_classic_wallets'])
  )
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
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (shouldReactToStorageChange(changes, area)) handleActiveAccountChanged({})
  })
}
