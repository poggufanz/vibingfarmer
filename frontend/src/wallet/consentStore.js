// Origin+account consent (replaces the old origin-only vf_allowlist) plus immutable, expiring
// per-request snapshots for the dapp provider flow (background.js opens approve.html against a
// snapshot, never against live URL params — see background.js/approve.js).
//
// Canonical module of record. background.js CANNOT `import` this (it's an MV3 service worker
// loaded as a classic script — see its own docstring) and mirrors these functions inline instead;
// background.test.js runs a drift-guard suite comparing both, same convention as
// src/wallet/activeAccount.js's resolveActiveAccount / background.js's resolveWalletAddress.
//
// The snapshot shape is deliberately not dapp-specific (any `method` string, opaque `params`) so
// a later internal-action producer (VFW 13 — popup-originated ceremonies like deposit/approve)
// can reuse it unchanged; only the dapp provider path (background.js) produces one today.
export const CONSENT_KEY = 'vf_consents_v2'
export const REQUEST_TTL_MS = 5 * 60 * 1000
export const NETWORK = 'stellar-testnet'

async function readLocal(storageLocal, key) {
  const got = (await storageLocal?.get(key)) ?? {}
  return got[key]
}

/** Consent is scoped to the (origin, account) PAIR — origin A/account G never authorizes origin
 *  A/account C or origin B/account G. */
export function consentId(origin, accountId) {
  return `${origin}::${accountId}`
}

function isFresh(record, now) {
  return Boolean(record) && (record.expiresAt == null || now < record.expiresAt)
}

export async function readConsent({ origin, account, storageLocal, now = Date.now() }) {
  if (!origin || !account?.id) return null
  const all = (await readLocal(storageLocal, CONSENT_KEY)) ?? {}
  const record = all[consentId(origin, account.id)]
  if (!record || record.origin !== origin || record.accountId !== account.id) return null
  return isFresh(record, now) ? record : null
}

export async function grantConsent({ origin, account, storageLocal, now = Date.now() }) {
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

/** requester identity comes from Chrome-verified `sender` (content-script messages cannot spoof
 *  origin/tab/frame/document) — never from anything the page itself sent. */
export function createRequestSnapshot({ rid, method, params, sender, account, now = Date.now() }) {
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

/** Fail-closed on anything unproven: missing/malformed/expired snapshot, a `sender` (when
 *  supplied) whose origin/tab/frame/document no longer matches the one the snapshot was created
 *  for, an active account that no longer matches the snapshot's, or a requested `opts.address`
 *  that disagrees with it. `sender` is optional — callers with no live Chrome sender to compare
 *  against (e.g. approve.js's own pre-sign check) still get the account/expiry/address checks. */
export function validateRequestSnapshot(
  snapshot,
  { activeAccount, sender, now = Date.now() } = {}
) {
  const fail = (error) => ({ ok: false, code: -3, error })
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
