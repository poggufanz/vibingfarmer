// frontend/src/wallet/classicAccount.js
import { Horizon } from '@stellar/stellar-sdk'
import { HORIZON_URL } from '../stellar/config.js'
import { generate24, keypairFromMnemonic, keypairFromSecret } from './classicKeypair.js'
import { encryptSecret, saveWallet, getWallet } from './vault.js'
import { unlock, getUnlocked, lock } from './session.js'

let _horizon
export function horizonServer() {
  if (!_horizon) _horizon = new Horizon.Server(HORIZON_URL)
  return _horizon
}

async function persistAndUnlock({ keypair, label, password }) {
  const publicKey = keypair.publicKey()
  const blob = await encryptSecret(keypair.secret(), password)
  await saveWallet({ label, publicKey, blob, createdAt: Date.now() })
  await unlock(publicKey, password)
  return publicKey
}

export async function createClassicWallet({ label, password }) {
  const mnemonic = generate24()
  const keypair = keypairFromMnemonic(mnemonic, 0)
  const publicKey = await persistAndUnlock({ keypair, label, password })
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
  const { decryptWithKey } = await import('./vault.js')
  const { keypairFromSecret } = await import('./classicKeypair.js')
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
