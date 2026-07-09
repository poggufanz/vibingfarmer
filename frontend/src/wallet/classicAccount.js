// frontend/src/wallet/classicAccount.js
import { Horizon } from '@stellar/stellar-sdk'
import { HORIZON_URL } from '../stellar/config.js'
import { generate24, keypairFromMnemonic, keypairFromSecret } from './classicKeypair.js'
import { encryptSecret, saveWallet, decryptWithKey } from './vault.js'
import { unlock, getUnlocked, lock } from './session.js'

let _horizon
export function horizonServer() {
  if (!_horizon) _horizon = new Horizon.Server(HORIZON_URL)
  return _horizon
}

async function persistAndUnlock({ keypair, label, password, extra = {} }) {
  const publicKey = keypair.publicKey()
  const blob = await encryptSecret(keypair.secret(), password)
  await saveWallet({ label, publicKey, blob, createdAt: Date.now(), ...extra })
  await unlock(publicKey, password)
  return publicKey
}

// pendingBackup: when true, the 24-word mnemonic is encrypted and folded into the SAME
// saveWallet call that persists the account record (needsBackup + mnemonicBlob alongside
// label/publicKey/blob). This closes the creation-time race where a second, later save
// added the backup gate: an MV3 popup teardown between the two saves could persist a
// flagless record and silently lose the mnemonic. One record, written once, either has
// the full backup gate or never existed. Default false leaves every other caller/test
// (import paths) producing the exact same record shape as before.
export async function createClassicWallet({ label, password, pendingBackup = false }) {
  const mnemonic = generate24()
  const keypair = keypairFromMnemonic(mnemonic, 0)
  const extra = pendingBackup
    ? { needsBackup: true, mnemonicBlob: await encryptSecret(mnemonic, password) }
    : {}
  const publicKey = await persistAndUnlock({ keypair, label, password, extra })
  return { publicKey, mnemonic }
}

export async function importFromSecret({ secret, password, label }) {
  const keypair = keypairFromSecret(secret)
  return { publicKey: await persistAndUnlock({ keypair, label, password }) }
}

export async function importFromMnemonic({ mnemonic, password, label, index = 0 }) {
  const keypair = keypairFromMnemonic(mnemonic, index)
  return { publicKey: await persistAndUnlock({ keypair, label, password }) }
}

export { lock }
export async function unlockWallet(publicKey, password) {
  return unlock(publicKey, password)
}

// Reconstruct secret -> keypair -> run fn -> wipe. Secret bytes never persisted.
export async function withSecret(fn) {
  const u = await getUnlocked()
  if (!u) throw new Error('locked')
  let secret = null
  let bytes = null
  try {
    secret = await decryptWithKey(u.blob, u.key) // 'S...' string (unavoidable; minimized)
    bytes = new TextEncoder().encode(secret)
    const kp = keypairFromSecret(secret)
    return await fn(kp)
  } finally {
    if (bytes) bytes.fill(0)
    secret = null // drop ref ASAP; JS can't guarantee wipe of the string (labeled in HonestyLabels)
  }
}

export async function readBalances(publicKey, { horizon = horizonServer() } = {}) {
  try {
    const acc = await horizon.loadAccount(publicKey)
    return acc.balances.map((b) =>
      b.asset_type === 'native'
        ? { asset: 'XLM', code: 'XLM', issuer: null, balance: b.balance }
        : {
            asset: `${b.asset_code}:${b.asset_issuer}`,
            code: b.asset_code,
            issuer: b.asset_issuer,
            balance: b.balance,
          }
    )
  } catch (e) {
    if (e?.response?.status === 404) return null // unfunded
    throw e
  }
}

export async function fundTestnet(publicKey, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`)
  return r.ok
}
