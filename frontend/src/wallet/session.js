// frontend/src/wallet/session.js
import { getWallet, deriveKey, decryptWithKey, ub64 } from './vault.js'

const SESSION_KEY = 'vf_classic_session'
const DEFAULT_IDLE_MS = 600000 // 10 min

export async function unlock(publicKey, password) {
  const rec = await getWallet(publicKey)
  if (!rec) throw new Error('wallet not found')
  const key = await deriveKey(password, ub64(rec.blob.salt), rec.blob.kdf.iters)
  await decryptWithKey(rec.blob, key) // throws on wrong password (auth tag)
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

export async function isUnlocked() {
  const r = await chrome.storage.session.get(SESSION_KEY)
  return Boolean(r?.[SESSION_KEY])
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
