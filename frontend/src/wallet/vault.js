const STORE_KEY = 'vf_classic_wallets'
const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i])
  return btoa(s)
}
export function ub64(str) {
  const bin = atob(str)
  const a = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
  return a
}

export async function deriveKey(password, salt, iters = 600000) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true, // extractable: session caches the exported JWK (Task 3)
    ['encrypt', 'decrypt']
  )
}

export async function encryptSecret(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, 600000)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret))
  return {
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iters: 600000 },
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(ct),
  }
}

export async function decryptWithKey(blob, key) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(blob.iv) },
    key,
    ub64(blob.ciphertext)
  )
  return dec.decode(pt)
}

export async function decryptSecret(blob, password) {
  const key = await deriveKey(password, ub64(blob.salt), blob.kdf.iters)
  return decryptWithKey(blob, key) // AES-GCM auth tag throws on wrong key
}

// --- storage (chrome.storage.local) ---
export async function loadWallets() {
  const r = await chrome.storage.local.get(STORE_KEY)
  return r?.[STORE_KEY] ?? {}
}
export async function saveWallet(rec) {
  const all = await loadWallets()
  all[rec.publicKey] = rec
  await chrome.storage.local.set({ [STORE_KEY]: all })
}
export async function getWallet(pk) {
  return (await loadWallets())[pk]
}
export async function listWallets() {
  return Object.values(await loadWallets())
}
export async function removeWallet(pk) {
  const all = await loadWallets()
  delete all[pk]
  await chrome.storage.local.set({ [STORE_KEY]: all })
}
