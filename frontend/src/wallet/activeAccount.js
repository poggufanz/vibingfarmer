// frontend/src/wallet/activeAccount.js
// One authoritative "which account is active" record, shared by popup/background/provider
// bridge/approval/ceremony/Base association. Chrome storage (chrome.storage.local) is the only
// durable store this module writes to — legacyStorage (window.localStorage) is read-only, a
// one-time migration hint for the popup, never a decision surface on its own (background.js runs
// as an MV3 service worker with no window/localStorage at all, and must never need one).
//
// Universe of accounts is deliberately small: at most ONE classic (G) wallet — the oldest by
// createdAt in vf_classic_wallets, matching the "single classic wallet" assumption already baked
// into session.js/approve.js/background.js — and at most ONE passkey (C) wallet, from account.js's
// vf_wallet_contract cache. "Establish one authoritative active account" means picking between
// those (at most) two, not enumerating every record a store could theoretically hold.
export const ACTIVE_ACCOUNT_KEY = 'vf_active_account_v1'
export const NETWORK = 'stellar-testnet'

async function readLocal(storageLocal, key) {
  const got = (await storageLocal?.get(key)) ?? {}
  return got[key]
}

function accountShape({ address, kind, signer }) {
  return { version: 1, id: `${NETWORK}:${address}`, network: NETWORK, address, kind, signer }
}

function toActiveAccount(account, selectedAt = Date.now()) {
  return { ...account, selectedAt }
}

// The only two possible entries: the oldest classic (G) wallet, and the cached passkey (C)
// wallet. Order is insignificant — callers key off `kind`/`id`, never array position.
export async function listWalletAccounts({ storageLocal }) {
  const [classicMap, contractId] = await Promise.all([
    readLocal(storageLocal, 'vf_classic_wallets'),
    readLocal(storageLocal, 'vf_wallet_contract'),
  ])
  const accounts = []
  const oldestClassic = Object.values(classicMap ?? {})
    .filter((rec) => rec?.publicKey)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0]
  if (oldestClassic) {
    accounts.push(
      accountShape({ address: oldestClassic.publicKey, kind: 'G', signer: 'classic-ed25519' })
    )
  }
  if (contractId) {
    accounts.push(accountShape({ address: contractId, kind: 'C', signer: 'passkey-secp256r1' }))
  }
  return accounts
}

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

function safeLegacyRead(legacyStorage, key) {
  try {
    return legacyStorage?.getItem?.(key) ?? null
  } catch {
    return null // a throwing storage (locked-down origin, etc.) is just "no hint"
  }
}

async function persistActive(storageLocal, account) {
  const record = toActiveAccount(account)
  await storageLocal?.set?.({ [ACTIVE_ACCOUNT_KEY]: record })
  return record
}

// Resolution matrix:
//   0 accounts                                          -> { status: 'empty' }
//   1 account, no valid persisted selection              -> auto-selects it, { status: 'ready' }
//   2 accounts, a valid persisted selection exists        -> honors it exactly, { status: 'ready' }
//   2 accounts, no persisted selection, valid legacy hint -> migrates once, { status: 'ready' }
//   2 accounts, no persisted selection, no legacy hint    -> { status: 'selection-required' }
// A persisted selection that no longer resolves to a real account (removed/corrupt/mismatched
// kind-signer-address) is cleared before falling through — never silently trusted, never
// silently replaced by a guess. No branch here ever prefers 'C' just because it exists.
export async function resolveActiveAccount({ storageLocal, legacyStorage, migrate = true }) {
  const accounts = await listWalletAccounts({ storageLocal })
  const byId = new Map(accounts.map((a) => [a.id, a]))

  const persisted = await readLocal(storageLocal, ACTIVE_ACCOUNT_KEY)
  if (persisted) {
    if (isValidPersisted(persisted, byId)) {
      return {
        status: 'ready',
        account: { ...byId.get(persisted.id), selectedAt: persisted.selectedAt },
      }
    }
    await clearActiveAccount({ storageLocal }) // removed/corrupt/mismatched — fail closed
  }

  if (accounts.length === 0) return { status: 'empty' }

  if (accounts.length === 1) {
    return { status: 'ready', account: await persistActive(storageLocal, accounts[0]) }
  }

  if (migrate && legacyStorage) {
    const legacyType = safeLegacyRead(legacyStorage, 'vf_wallet_type')
    const wantKind = legacyType === 'classic' ? 'G' : legacyType === 'passkey' ? 'C' : null
    const match = wantKind ? accounts.find((a) => a.kind === wantKind) : null
    if (match) return { status: 'ready', account: await persistActive(storageLocal, match) }
  }

  return { status: 'selection-required', accounts }
}

export async function selectActiveAccount({ accountId, storageLocal }) {
  const accounts = await listWalletAccounts({ storageLocal })
  const account = accounts.find((a) => a.id === accountId)
  if (!account) throw new Error(`selectActiveAccount: unknown account "${accountId}"`)
  return persistActive(storageLocal, account)
}

export async function clearActiveAccount({ storageLocal }) {
  await storageLocal?.remove?.(ACTIVE_ACCOUNT_KEY)
}

export function sameAccount(a, b) {
  return Boolean(a && b && a.id === b.id && a.kind === b.kind)
}
