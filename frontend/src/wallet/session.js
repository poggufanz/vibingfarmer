// frontend/src/wallet/session.js
import { getWallet, deriveKey, decryptWithKey, ub64 } from './vault.js'
import { keypairFromSecret } from './classicKeypair.js'

const SESSION_KEY = 'vf_classic_session'
const DEFAULT_IDLE_MS = 600000 // 10 min

export async function unlock(publicKey, password) {
  const rec = await getWallet(publicKey)
  if (!rec) throw new Error('wallet not found')
  const key = await deriveKey(password, ub64(rec.blob.salt), rec.blob.kdf.iters)
  const secret = await decryptWithKey(rec.blob, key) // throws on wrong password (auth tag)
  // Verify the decrypted secret actually derives the account we were asked to unlock — a stored
  // record whose blob/publicKey pairing is corrupt or mismatched must fail closed here, not hand
  // back a session that silently answers to the wrong address (see activeAccount.js: an unlocked
  // G1 secret can never satisfy a G2 active-account snapshot).
  if (keypairFromSecret(secret).publicKey() !== publicKey) {
    throw new Error('wallet record public key mismatch')
  }
  const jwk = await crypto.subtle.exportKey('jwk', key)
  await chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
  await chrome.storage.session.set({ [SESSION_KEY]: { publicKey, jwk } })
  touch()
}

export async function getUnlocked() {
  const r = await chrome.storage.session.get(SESSION_KEY)
  const s = r?.[SESSION_KEY]
  if (!s) return null
  const rec = await getWallet(s.publicKey)
  if (!rec) return null
  const key = await crypto.subtle.importKey('jwk', s.jwk, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ])
  return { publicKey: s.publicKey, key, blob: rec.blob }
}

export async function lock() {
  await chrome.storage.session.remove(SESSION_KEY)
}

// expectedPublicKey (optional): a session unlocked for a DIFFERENT address answers false — the
// active-account snapshot for G2 must never read as "unlocked" off a lingering G1 session.
export async function isUnlocked(expectedPublicKey) {
  const r = await chrome.storage.session.get(SESSION_KEY)
  const s = r?.[SESSION_KEY]
  if (!s) return false
  if (expectedPublicKey && s.publicKey !== expectedPublicKey) return false
  return true
}

export function touch(idleMs = DEFAULT_IDLE_MS) {
  chrome.alarms?.create?.('vf_classic_autolock', { when: nowPlus(idleMs) })
}
function nowPlus(ms) {
  // app runtime only; alarms use absolute epoch ms
  return Date.now() + ms
}

export function installAutoLock({ idleMs = DEFAULT_IDLE_MS } = {}) {
  chrome.alarms?.onAlarm?.addListener?.((a) => {
    if (a?.name === 'vf_classic_autolock') lock()
  })
  touch(idleMs)
}
