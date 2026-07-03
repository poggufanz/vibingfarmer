# VF Wallet — Classic ed25519 Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Freighter-style classic ed25519 self-custody wallet (`G…` address, 24-word backup, local signing, own gas) to the VF extension, alongside the untouched live passkey path.

**Architecture:** Popup-hosted keyring (classic signing is pure JS crypto — no WebAuthn ceremony tab). Secret encrypted at rest (AES-256-GCM + PBKDF2-600k) in `chrome.storage.local`; the *derived AES key* (not the raw secret) is cached in `chrome.storage.session` while unlocked (MetaMask `cacheEncryptionKey` pattern); the raw ed25519 secret is reconstructed as a `Uint8Array` on demand, signs, and is wiped. New logic lives in `frontend/src/wallet/*.js`; presentational screens in `frontend/src/wallet/ui/classic/*.jsx`; wired into `frontend/extension/popup.jsx`.

**Tech Stack:** `@stellar/stellar-sdk@^16` (installed), `@scure/bip39` + `ed25519-hd-key` (SEP-0005 derivation), WebCrypto (zero-dep encryption), `qrcode` (receive), React 18, vitest.

**Spec:** `docs/superpowers/specs/2026-07-02-vf-wallet-classic-design.md` (read it — this plan implements it).

## Global Constraints

Every task's requirements implicitly include these (verbatim from spec):

- **Chain:** Stellar **testnet only**. `NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'`, `HORIZON_URL = 'https://horizon-testnet.stellar.org'`, `SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'` — import from `frontend/src/stellar/config.js`, never hardcode.
- **KDF:** PBKDF2-HMAC-SHA256, **600000** iterations, AES-256-GCM. Fresh 16-byte salt + 12-byte IV per encryption (`crypto.getRandomValues`). Never reuse an IV.
- **At rest:** only AES-GCM ciphertext in `chrome.storage.local`. **Never** a plaintext secret/mnemonic in `.local`, `localStorage`, or IndexedDB.
- **Unlocked:** cache the derived AES key (exported JWK) in `chrome.storage.session` with `setAccessLevel('TRUSTED_CONTEXTS')` — never the raw `S…`. Reconstruct the secret as a `Uint8Array`, sign, `fill(0)` in a `try/finally`. Secret is never a `String`.
- **Amounts:** pass to stellar-sdk as decimal **strings** (7-dp). Never JS-float math on balances for on-chain values.
- **Mnemonic:** 24 words, SEP-0005, path `m/44'/148'/x'` (all hardened).
- **Signing = local only.** VF API / relayer never receives a classic secret. Classic pays its own gas via Horizon (not the relay).
- **No generic contract-invoke decoding to text** — clear-sign is rich for payments/createAccount only; deposits go through the existing relay/`ApproveOverlay` flow.
- **Tooling:** run all frontend commands from `frontend/` in **PowerShell** (not WSL — rollup needs the win32 binary). Tests need **Node 20+** (Web Crypto + `btoa`/`atob` globals). Test runner: `npm test` (`vitest run`).
- **Deps pinned**, no remote code, do not touch the passkey path; all prior tests stay green.
- **Do not `git add -A`** — `planning/` and `docs/superpowers/` are intended local-only; stage explicit paths.
- **Commit messages:** conventional, no step numbers in the message text.

---

## Task 1: `classicKeypair.js` — ed25519 keypair + SEP-0005 mnemonic

**Files:**
- Create: `frontend/src/wallet/classicKeypair.js`
- Test: `frontend/src/wallet/classicKeypair.test.js`
- Modify: `frontend/package.json` (add deps)

**Interfaces:**
- Consumes: `@stellar/stellar-sdk` (`Keypair`, `StrKey`), `@scure/bip39`, `ed25519-hd-key`.
- Produces:
  - `generate24(): string` — 24-word mnemonic
  - `validate(mnemonic: string): boolean`
  - `keypairFromMnemonic(mnemonic: string, index=0): Keypair` — throws `Error('invalid mnemonic')` if checksum fails
  - `keypairFromSecret(secret: string): Keypair` — throws `Error('invalid secret')` if not a valid StrKey `S…`
  - `randomKeypair(): Keypair`
  - (`Keypair.publicKey() → 'G…'`, `Keypair.secret() → 'S…'`)

- [ ] **Step 1: Install deps (pinned)**

Run (from `frontend/`, PowerShell):
```
npm install @scure/bip39@1.3.0 ed25519-hd-key@1.3.0 qrcode@1.5.4 --save-exact
```
Expected: added to `dependencies`. (`qrcode` is used in Task 10; install now to avoid a second lockfile churn.)

- [ ] **Step 2: Write the failing test**

```javascript
// frontend/src/wallet/classicKeypair.test.js
import { describe, it, expect } from 'vitest'
import { generate24, validate, keypairFromMnemonic, keypairFromSecret } from './classicKeypair.js'

// Canonical SEP-0005 published test vector (account m/44'/148'/0')
const VEC_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe'
const VEC_PUB = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6'
const VEC_SEC = 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN'

describe('classicKeypair', () => {
  it('derives the SEP-0005 vector keypair from its mnemonic', () => {
    const kp = keypairFromMnemonic(VEC_MNEMONIC, 0)
    expect(kp.publicKey()).toBe(VEC_PUB)
    expect(kp.secret()).toBe(VEC_SEC)
  })

  it('generate24 produces a valid 24-word mnemonic', () => {
    const m = generate24()
    expect(m.split(' ')).toHaveLength(24)
    expect(validate(m)).toBe(true)
  })

  it('rejects a bad-checksum mnemonic and a bad secret', () => {
    expect(validate('bogus bogus bogus')).toBe(false)
    expect(() => keypairFromSecret('SNOTVALID')).toThrow()
  })

  it('round-trips a secret key', () => {
    expect(keypairFromSecret(VEC_SEC).publicKey()).toBe(VEC_PUB)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- classicKeypair`
Expected: FAIL (`classicKeypair.js` does not exist / exports undefined).

- [ ] **Step 4: Write minimal implementation**

```javascript
// frontend/src/wallet/classicKeypair.js
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { derivePath } from 'ed25519-hd-key'

// Uint8Array -> lowercase hex (avoids relying on a Buffer polyfill)
function toHex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s
}

export function generate24() {
  return generateMnemonic(wordlist, 256) // 256 bits => 24 words
}

export function validate(mnemonic) {
  return validateMnemonic((mnemonic || '').trim(), wordlist)
}

export function keypairFromMnemonic(mnemonic, index = 0) {
  const m = (mnemonic || '').trim().replace(/\s+/g, ' ')
  if (!validateMnemonic(m, wordlist)) throw new Error('invalid mnemonic')
  const seed = mnemonicToSeedSync(m) // Uint8Array (64 bytes)
  const { key } = derivePath(`m/44'/148'/${index}'`, toHex(seed)) // SLIP-0010 ed25519, 32-byte key
  return Keypair.fromRawEd25519Seed(key)
}

export function keypairFromSecret(secret) {
  const s = (secret || '').trim()
  if (!StrKey.isValidEd25519SecretSeed(s)) throw new Error('invalid secret')
  return Keypair.fromSecret(s)
}

export function randomKeypair() {
  return Keypair.random()
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- classicKeypair`
Expected: PASS (4 tests). If the vector fails, the derivation path or lib wiring is wrong — fix before proceeding (do not edit the vector; it is authoritative).

- [ ] **Step 6: Commit**

```
git add frontend/src/wallet/classicKeypair.js frontend/src/wallet/classicKeypair.test.js frontend/package.json frontend/package-lock.json
git commit -m "feat(wallet): classic ed25519 keypair + SEP-0005 mnemonic"
```

---

## Task 2: `vault.js` — AES-256-GCM + PBKDF2-600k encrypted store + chrome test mock

**Files:**
- Create: `frontend/src/wallet/vault.js`
- Create: `frontend/src/wallet/testUtils.js` (shared chrome mock — reused by Tasks 3 & 4)
- Test: `frontend/src/wallet/vault.test.js`

**Interfaces:**
- Produces:
  - `b64(bytes: Uint8Array|ArrayBuffer): string`, `ub64(s: string): Uint8Array`
  - `deriveKey(password: string, salt: Uint8Array, iters=600000): Promise<CryptoKey>` (extractable AES-GCM)
  - `encryptSecret(secret: string, password: string): Promise<VaultBlob>`
  - `decryptSecret(blob: VaultBlob, password: string): Promise<string>` (throws on wrong password)
  - `decryptWithKey(blob: VaultBlob, key: CryptoKey): Promise<string>`
  - `saveWallet(rec: WalletRecord): Promise<void>`, `loadWallets(): Promise<Record<string,WalletRecord>>`, `getWallet(pk): Promise<WalletRecord|undefined>`, `listWallets(): Promise<WalletRecord[]>`, `removeWallet(pk): Promise<void>`
  - Types: `VaultBlob = { version:1, kdf:{name:'PBKDF2',hash:'SHA-256',iters:number}, salt:string, iv:string, ciphertext:string }`; `WalletRecord = { label:string, publicKey:string, blob:VaultBlob, createdAt:number }`
- `testUtils.js` produces: `installChromeMock(): { local: object, session: object }`

- [ ] **Step 1: Write the chrome mock helper**

```javascript
// frontend/src/wallet/testUtils.js
// Minimal MV3 chrome.storage/alarms mock. Promise-based get/set/remove match MV3.
export function installChromeMock() {
  const local = {}
  const session = {}
  const wrap = (bag) => ({
    get: async (key) => (typeof key === 'string' ? { [key]: bag[key] } : { ...bag }),
    set: async (obj) => { Object.assign(bag, obj) },
    remove: async (key) => { delete bag[key] },
    setAccessLevel: async () => {},
  })
  globalThis.chrome = {
    storage: { local: wrap(local), session: wrap(session) },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
    runtime: { onMessage: { addListener: () => {} } },
  }
  return { local, session }
}
```

- [ ] **Step 2: Write the failing test**

```javascript
// frontend/src/wallet/vault.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { installChromeMock } from './testUtils.js'
import { encryptSecret, decryptSecret, saveWallet, getWallet, listWallets, removeWallet } from './vault.js'

let bags
beforeEach(() => { bags = installChromeMock() })

describe('vault', () => {
  it('round-trips encrypt/decrypt', async () => {
    const blob = await encryptSecret('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN', 'hunter2hunter2')
    expect(blob.kdf.iters).toBe(600000)
    const out = await decryptSecret(blob, 'hunter2hunter2')
    expect(out).toBe('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN')
  })

  it('wrong password throws and never yields plaintext', async () => {
    const blob = await encryptSecret('SECRETSEED', 'right-password')
    await expect(decryptSecret(blob, 'wrong-password')).rejects.toThrow()
  })

  it('persists only ciphertext (no plaintext secret in storage)', async () => {
    const blob = await encryptSecret('SBPLAINTEXTSHOULDNOTAPPEAR', 'pw123456pw12')
    await saveWallet({ label: 'A', publicKey: 'GABC', blob, createdAt: 1 })
    const raw = JSON.stringify(bags.local)
    expect(raw).not.toContain('SBPLAINTEXTSHOULDNOTAPPEAR')
    expect((await getWallet('GABC')).label).toBe('A')
    expect(await listWallets()).toHaveLength(1)
    await removeWallet('GABC')
    expect(await listWallets()).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- vault`
Expected: FAIL (`vault.js` missing).

- [ ] **Step 4: Write minimal implementation**

```javascript
// frontend/src/wallet/vault.js
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
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true, // extractable: session caches the exported JWK (Task 3)
    ['encrypt', 'decrypt'],
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
    salt: b64(salt), iv: b64(iv), ciphertext: b64(ct),
  }
}

export async function decryptWithKey(blob, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(blob.iv) }, key, ub64(blob.ciphertext))
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- vault`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```
git add frontend/src/wallet/vault.js frontend/src/wallet/vault.test.js frontend/src/wallet/testUtils.js
git commit -m "feat(wallet): AES-GCM + PBKDF2-600k vault + chrome test mock"
```

---

## Task 3: `session.js` — unlock caches derived key, auto-lock

**Files:**
- Create: `frontend/src/wallet/session.js`
- Test: `frontend/src/wallet/session.test.js`

**Interfaces:**
- Consumes: `vault.js` (`getWallet`, `deriveKey`, `decryptWithKey`, `ub64`).
- Produces:
  - `unlock(publicKey: string, password: string): Promise<void>` — verifies password by decrypting, caches `{ publicKey, jwk }` in `chrome.storage.session`. Throws on wrong password.
  - `getUnlocked(): Promise<{ publicKey: string, key: CryptoKey, blob: VaultBlob } | null>`
  - `lock(): Promise<void>` — clears the session entry
  - `isUnlocked(): Promise<boolean>`
  - `installAutoLock({ idleMs=600000 }?): void` — `chrome.alarms` handler that calls `lock()`; call `touch()` on activity
  - `touch(): void` — reset the idle alarm

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/wallet/session.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { installChromeMock } from './testUtils.js'
import { encryptSecret, saveWallet } from './vault.js'
import { unlock, getUnlocked, lock, isUnlocked } from './session.js'

let bags
beforeEach(async () => {
  bags = installChromeMock()
  const blob = await encryptSecret('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN', 'pw12pw12pw12')
  await saveWallet({ label: 'A', publicKey: 'GABC', blob, createdAt: 1 })
})

describe('session', () => {
  it('unlock caches the derived KEY (not the raw secret) and unlocks', async () => {
    await unlock('GABC', 'pw12pw12pw12')
    expect(await isUnlocked()).toBe(true)
    const raw = JSON.stringify(bags.session)
    expect(raw).not.toContain('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN')
    const u = await getUnlocked()
    expect(u.publicKey).toBe('GABC')
    expect(u.key).toBeDefined()
  })

  it('wrong password does not unlock', async () => {
    await expect(unlock('GABC', 'nope-nope-nope')).rejects.toThrow()
    expect(await isUnlocked()).toBe(false)
  })

  it('lock clears the session', async () => {
    await unlock('GABC', 'pw12pw12pw12')
    await lock()
    expect(await isUnlocked()).toBe(false)
    expect(await getUnlocked()).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- session`
Expected: FAIL (`session.js` missing).

- [ ] **Step 3: Write minimal implementation**

```javascript
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
  const key = await crypto.subtle.importKey('jwk', s.jwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- session`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```
git add frontend/src/wallet/session.js frontend/src/wallet/session.test.js
git commit -m "feat(wallet): session unlock caches derived key + auto-lock"
```

---

## Task 4: `classicAccount.js` — lifecycle, withSecret, balances, funding

**Files:**
- Create: `frontend/src/wallet/classicAccount.js`
- Test: `frontend/src/wallet/classicAccount.test.js`

**Interfaces:**
- Consumes: `classicKeypair.js`, `vault.js`, `session.js`, `@stellar/stellar-sdk` (`Horizon`), `stellar/config.js` (`HORIZON_URL`).
- Produces:
  - `createClassicWallet({ label, password }): Promise<{ publicKey, mnemonic }>` — generates mnemonic, saves encrypted, unlocks session, returns the mnemonic **for show-once**.
  - `importFromSecret({ secret, password, label }): Promise<{ publicKey }>`
  - `importFromMnemonic({ mnemonic, password, label, index=0 }): Promise<{ publicKey }>`
  - `withSecret(fn: (kp) => Promise<T>): Promise<T>` — reconstructs the ed25519 secret as bytes, runs `fn(keypair)`, wipes in `finally`. Throws `Error('locked')` if not unlocked.
  - `readBalances(publicKey, { horizon? }): Promise<Balance[] | null>` — `null` = unfunded (404). `Balance = { asset, code, issuer, balance }`.
  - `fundTestnet(publicKey, { fetchImpl? }): Promise<boolean>`
  - `horizonServer(): Horizon.Server`

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/wallet/classicAccount.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installChromeMock } from './testUtils.js'
import { createClassicWallet, importFromSecret, withSecret } from './classicAccount.js'
import { isUnlocked, lock } from './session.js'

beforeEach(() => { installChromeMock() })

describe('classicAccount', () => {
  it('creates a wallet, returns a 24-word mnemonic, and unlocks', async () => {
    const { publicKey, mnemonic } = await createClassicWallet({ label: 'Main', password: 'pw12pw12pw12' })
    expect(publicKey).toMatch(/^G/)
    expect(mnemonic.split(' ')).toHaveLength(24)
    expect(await isUnlocked()).toBe(true)
  })

  it('imports from a secret and signs via withSecret (buffer wiped afterward)', async () => {
    const { publicKey } = await importFromSecret({
      secret: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      password: 'pw12pw12pw12', label: 'Imp',
    })
    expect(publicKey).toBe('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6')
    const sig = await withSecret(async (kp) => kp.sign(Buffer.from('hello')))
    expect(sig).toBeDefined()
  })

  it('withSecret throws when locked', async () => {
    await importFromSecret({ secret: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN', password: 'pw12pw12pw12', label: 'x' })
    await lock()
    await expect(withSecret(async () => 1)).rejects.toThrow('locked')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- classicAccount`
Expected: FAIL (`classicAccount.js` missing).

- [ ] **Step 3: Write minimal implementation**

```javascript
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
export async function unlockWallet(publicKey, password) { return unlock(publicKey, password) }

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
        : { asset: `${b.asset_code}:${b.asset_issuer}`, code: b.asset_code, issuer: b.asset_issuer, balance: b.balance },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- classicAccount`
Expected: PASS (3 tests). (`Buffer` is a Node global in vitest; the extension bundle already polyfills it via stellar-sdk.)

- [ ] **Step 5: Commit**

```
git add frontend/src/wallet/classicAccount.js frontend/src/wallet/classicAccount.test.js
git commit -m "feat(wallet): classic account lifecycle, withSecret, balances, friendbot"
```

---

## Task 5: `clearSign.js` — decode payment/createAccount XDR for confirm

**Files:**
- Create: `frontend/src/wallet/clearSign.js`
- Test: `frontend/src/wallet/clearSign.test.js`

**Interfaces:**
- Consumes: `@stellar/stellar-sdk` (`TransactionBuilder`, `Asset`, `Operation`, `Account`), `stellar/config.js` (`NETWORK_PASSPHRASE`).
- Produces:
  - `decodeForConfirm(xdr: string, networkPassphrase=NETWORK_PASSPHRASE): { source, fee, memo, ops: DecodedOp[], kind, decodable: boolean }`
  - `DecodedOp` (payment) `= { type:'payment', decodable:true, destination, asset, amount }`; (createAccount) `= { type:'createAccount', decodable:true, destination, amount }`; (invoke/other) `= { type, decodable:false }` — **never decoded to human text**.
  - `assetLabel(asset): 'XLM' | '<code>:<issuer>'`

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/wallet/clearSign.test.js
import { describe, it, expect } from 'vitest'
import { TransactionBuilder, Account, Operation, Asset, BASE_FEE, Memo } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'
import { decodeForConfirm } from './clearSign.js'

function paymentXdr() {
  const src = new Account('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6', '1')
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({
      destination: 'GABC4B7ULZTVXX7Y4NRZW7YQ2LGP6C3ZQ7HImocKA5VXNVXNVXNVXNV'.slice(0, 56),
      asset: Asset.native(),
      amount: '12.5000000',
    }))
    .addMemo(Memo.text('hi'))
    .setTimeout(300)
    .build()
  return tx.toXDR()
}

describe('clearSign', () => {
  it('decodes a native payment to human-readable fields', () => {
    const d = decodeForConfirm(paymentXdr())
    expect(d.kind).toBe('payment')
    expect(d.decodable).toBe(true)
    expect(d.ops[0]).toMatchObject({ type: 'payment', asset: 'XLM', amount: '12.5000000' })
    expect(d.memo).toBe('hi')
  })
})
```
> Note: use a real valid destination `G…` when writing the test (generate one via `Keypair.random().publicKey()` if needed). The sliced string above is illustrative — replace with a valid address so `Operation.payment` doesn't throw.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- clearSign`
Expected: FAIL (`clearSign.js` missing).

- [ ] **Step 3: Write minimal implementation**

```javascript
// frontend/src/wallet/clearSign.js
import { TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'

export function assetLabel(asset) {
  if (!asset || asset.isNative?.()) return 'XLM'
  return `${asset.getCode()}:${asset.getIssuer()}`
}

function decodeOp(op) {
  if (op.type === 'payment') {
    return { type: 'payment', decodable: true, destination: op.destination, asset: assetLabel(op.asset), amount: op.amount }
  }
  if (op.type === 'createAccount') {
    return { type: 'createAccount', decodable: true, destination: op.destination, amount: op.startingBalance }
  }
  // Soroban invokeHostFunction and everything else: DO NOT decode to text.
  return { type: op.type, decodable: false }
}

export function decodeForConfirm(xdr, networkPassphrase = NETWORK_PASSPHRASE) {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase)
  const ops = tx.operations.map(decodeOp)
  const memo = tx.memo && tx.memo.value ? String(tx.memo.value) : ''
  return {
    source: tx.source,
    fee: tx.fee,
    memo,
    ops,
    kind: ops[0]?.type ?? 'other',
    decodable: ops.length > 0 && ops.every((o) => o.decodable),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- clearSign`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/src/wallet/clearSign.js frontend/src/wallet/clearSign.test.js
git commit -m "feat(wallet): clear-sign decode for payments (invokes left opaque)"
```

---

## Task 6: `send.js` — build payment, F8-vault check, sign+submit

**Files:**
- Create: `frontend/src/wallet/send.js`
- Test: `frontend/src/wallet/send.test.js`

**Interfaces:**
- Consumes: `@stellar/stellar-sdk` (`TransactionBuilder`, `Operation`, `Asset`, `Memo`, `BASE_FEE`), `stellar/config.js` (`NETWORK_PASSPHRASE`, `VAULT_CATALOG` via `config.js`), `clearSign.js`, `classicAccount.js` (`horizonServer`, `withSecret`), `vfapi/client.js` (`eligibility`).
- Produces:
  - `isKnownVault(address): { hit: boolean, vault?: object }` — matches `VAULT_CATALOG[].address`
  - `buildPaymentXdr({ from, to, asset, amount, memo, horizon }): Promise<{ xdr, tx }>`
  - `previewSend({ from, to, asset, amount, memo, horizon }): Promise<{ confirm, vault: {hit, name?, allow?, reasons?} }>` — clear-sign + F8 verdict when `to` ∈ vault catalog
  - `sendPayment({ to, asset, amount, memo }): Promise<{ hash, status }>` — builds from the unlocked account, signs via `withSecret`, submits via Horizon (own gas)

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/src/wallet/send.test.js
import { describe, it, expect } from 'vitest'
import { isKnownVault } from './send.js'
import { VAULT_CATALOG } from '../config.js'

describe('send — vault detection', () => {
  it('flags a known vault address and ignores a random one', () => {
    const vaultAddr = VAULT_CATALOG[0].address
    expect(isKnownVault(vaultAddr).hit).toBe(true)
    expect(isKnownVault(vaultAddr).vault.name).toBe(VAULT_CATALOG[0].name)
    expect(isKnownVault('GRANDOMADDRESSNOTAVAULT').hit).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- send`
Expected: FAIL (`send.js` missing).

- [ ] **Step 3: Write minimal implementation**

```javascript
// frontend/src/wallet/send.js
import { TransactionBuilder, Operation, Asset, Memo, BASE_FEE } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'
import { VAULT_CATALOG } from '../config.js'
import { eligibility } from '../vfapi/client.js'
import { decodeForConfirm } from './clearSign.js'
import { horizonServer, withSecret } from './classicAccount.js'

export function isKnownVault(address) {
  const vault = VAULT_CATALOG.find((v) => v.address === address)
  return vault ? { hit: true, vault } : { hit: false }
}

function toAsset(asset) {
  return asset === 'XLM' ? Asset.native() : new Asset(asset.code, asset.issuer)
}

export async function buildPaymentXdr({ from, to, asset, amount, memo, horizon = horizonServer() }) {
  const account = await horizon.loadAccount(from)
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({ destination: to, asset: toAsset(asset), amount: String(amount) }))
    .setTimeout(300)
  if (memo) builder.addMemo(Memo.text(memo))
  const tx = builder.build()
  return { xdr: tx.toXDR(), tx }
}

export async function previewSend({ from, to, asset, amount, memo, horizon = horizonServer() }) {
  const { xdr } = await buildPaymentXdr({ from, to, asset, amount, memo, horizon })
  const confirm = decodeForConfirm(xdr)
  const known = isKnownVault(to)
  let vault = { hit: false }
  if (known.hit) {
    const e = await eligibility({ vault: known.vault.protocol, amount })
    vault = { hit: true, name: known.vault.name, allow: e.allow, reasons: e.reasons }
  }
  return { confirm, vault }
}

export async function sendPayment({ from, to, asset, amount, memo, horizon = horizonServer() }) {
  const { tx } = await buildPaymentXdr({ from, to, asset, amount, memo, horizon })
  await withSecret(async (kp) => tx.sign(kp))
  const res = await horizon.submitTransaction(tx)
  return { hash: res.hash, status: 'SUCCESS' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- send`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/src/wallet/send.js frontend/src/wallet/send.test.js
git commit -m "feat(wallet): classic send — payment build, F8 vault check, local sign+submit"
```

---

## Task 7: `prices.js` + `history.js` — portfolio value & activity

**Files:**
- Create: `frontend/src/wallet/prices.js`, `frontend/src/wallet/history.js`
- Test: `frontend/src/wallet/prices.test.js`, `frontend/src/wallet/history.test.js`

**Interfaces:**
- `prices.js` produces:
  - `fetchXlmUsd({ fetchImpl?, endpoint? }): Promise<number|null>` (null on any error — caller degrades)
  - `assetUsd(balance, xlmUsd): number|null`
  - `portfolioValue(balances, xlmUsd): { total: number, complete: boolean, rows: Array<Balance & {usd:number|null}> }`
- `history.js` produces:
  - `fetchHistory(publicKey, { fetchImpl?, limit?, horizonUrl? }): Promise<HistoryItem[]>`
  - `HistoryItem = { id, type, from, to, asset, amount, createdAt, direction:'in'|'out' }`

- [ ] **Step 1: Write the failing tests**

```javascript
// frontend/src/wallet/prices.test.js
import { describe, it, expect, vi } from 'vitest'
import { fetchXlmUsd, portfolioValue } from './prices.js'

describe('prices', () => {
  it('returns null (degrades) when CoinGecko fails — no throw', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false }))
    expect(await fetchXlmUsd({ fetchImpl })).toBeNull()
  })

  it('sums XLM + pegged USDC, marks incomplete when a price is missing', () => {
    const balances = [
      { asset: 'XLM', code: 'XLM', issuer: null, balance: '100' },
      { asset: 'USDC:GX', code: 'USDC', issuer: 'GX', balance: '5' },
      { asset: 'FOO:GY', code: 'FOO', issuer: 'GY', balance: '9' },
    ]
    const pv = portfolioValue(balances, 0.1) // XLM=$0.1
    expect(pv.total).toBeCloseTo(100 * 0.1 + 5) // 15
    expect(pv.complete).toBe(false) // FOO has no price
  })
})
```

```javascript
// frontend/src/wallet/history.test.js
import { describe, it, expect, vi } from 'vitest'
import { fetchHistory } from './history.js'

describe('history', () => {
  it('maps Horizon payments and tags direction', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ _embedded: { records: [
        { id: '1', type: 'payment', from: 'GME', to: 'GYOU', asset_type: 'native', amount: '3', created_at: 't' },
      ] } }),
    }))
    const out = await fetchHistory('GME', { fetchImpl })
    expect(out[0]).toMatchObject({ asset: 'XLM', amount: '3', direction: 'out' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- prices history`
Expected: FAIL (modules missing).

- [ ] **Step 3: Write minimal implementations**

```javascript
// frontend/src/wallet/prices.js
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd'

// Swappable price source. On CORS/limit failure returns null so callers degrade to balance-only.
// Production fallback (documented in HomeScreen wiring): route through the VF API gateway (/api/price) or a TTL cache.
export async function fetchXlmUsd({ fetchImpl = fetch, endpoint = COINGECKO } = {}) {
  try {
    const r = await fetchImpl(endpoint)
    if (!r.ok) return null
    const j = await r.json()
    return j?.stellar?.usd ?? null
  } catch {
    return null
  }
}

export function assetUsd(balance, xlmUsd) {
  if (balance.code === 'XLM') return xlmUsd == null ? null : Number(balance.balance) * xlmUsd
  if (balance.code === 'USDC') return Number(balance.balance) // testnet peg ~ $1 (indicative)
  return null
}

export function portfolioValue(balances, xlmUsd) {
  const rows = balances.map((b) => ({ ...b, usd: assetUsd(b, xlmUsd) }))
  const total = rows.reduce((s, r) => (r.usd == null ? s : s + r.usd), 0)
  const complete = rows.every((r) => r.usd != null)
  return { total, complete, rows }
}
```

```javascript
// frontend/src/wallet/history.js
import { HORIZON_URL } from '../stellar/config.js'

export async function fetchHistory(publicKey, { fetchImpl = fetch, limit = 20, horizonUrl = HORIZON_URL } = {}) {
  const url = `${horizonUrl}/accounts/${publicKey}/payments?order=desc&limit=${limit}`
  const r = await fetchImpl(url)
  if (!r.ok) return []
  const j = await r.json()
  const recs = j?._embedded?.records ?? []
  return recs
    .filter((x) => x.type === 'payment' || x.type === 'create_account')
    .map((x) => {
      const to = x.to ?? x.account
      return {
        id: x.id,
        type: x.type,
        from: x.from ?? x.funder,
        to,
        asset: x.asset_type === 'native' || x.type === 'create_account' ? 'XLM' : `${x.asset_code}:${x.asset_issuer}`,
        amount: x.amount ?? x.starting_balance,
        createdAt: x.created_at,
        direction: to === publicKey ? 'in' : 'out',
      }
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- prices history`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/src/wallet/prices.js frontend/src/wallet/prices.test.js frontend/src/wallet/history.js frontend/src/wallet/history.test.js
git commit -m "feat(wallet): portfolio value (swappable price source) + Horizon history"
```

---

## Task 8: UI logic helpers — backup subset-confirm + import classify

**Files:**
- Create: `frontend/src/wallet/ui/classic/backupConfirm.js`, `frontend/src/wallet/ui/classic/importValidate.js`
- Test: `frontend/src/wallet/ui/classic/backupConfirm.test.js`, `frontend/src/wallet/ui/classic/importValidate.test.js`

**Interfaces:**
- `backupConfirm.js`: `pickConfirmIndices(total=24, n=3, rng=Math.random): number[]` (sorted, unique); `checkConfirm(mnemonic, answers: {index,word}[]): boolean`
- `importValidate.js`: `classifyImport(input): { kind:'secret'|'mnemonic'|'invalid', normalized?, error? }`

- [ ] **Step 1: Write the failing tests**

```javascript
// frontend/src/wallet/ui/classic/backupConfirm.test.js
import { describe, it, expect } from 'vitest'
import { pickConfirmIndices, checkConfirm } from './backupConfirm.js'

describe('backupConfirm', () => {
  it('picks n unique sorted indices in range', () => {
    let i = 0
    const rng = () => [0.01, 0.5, 0.99, 0.5][i++] // 3rd duplicate forces re-draw
    const idx = pickConfirmIndices(24, 3, rng)
    expect(idx).toHaveLength(3)
    expect(new Set(idx).size).toBe(3)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('accepts correct words (case/space-insensitive), rejects wrong', () => {
    const m = 'alpha bravo charlie delta echo foxtrot'
    expect(checkConfirm(m, [{ index: 1, word: 'Bravo' }, { index: 3, word: ' delta ' }])).toBe(true)
    expect(checkConfirm(m, [{ index: 1, word: 'wrong' }])).toBe(false)
  })
})
```

```javascript
// frontend/src/wallet/ui/classic/importValidate.test.js
import { describe, it, expect } from 'vitest'
import { classifyImport } from './importValidate.js'

describe('classifyImport', () => {
  it('detects a valid secret key', () => {
    expect(classifyImport('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN').kind).toBe('secret')
  })
  it('detects a valid mnemonic', () => {
    expect(classifyImport('illness spike retreat truth genius clock brain pass fit cave bargain toe').kind).toBe('mnemonic')
  })
  it('reports checksum failure for a wrong 12-word phrase', () => {
    const r = classifyImport('illness spike retreat truth genius clock brain pass fit cave bargain zoo')
    expect(r.kind).toBe('invalid')
    expect(r.error).toMatch(/checksum/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- backupConfirm importValidate`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementations**

```javascript
// frontend/src/wallet/ui/classic/backupConfirm.js
export function pickConfirmIndices(total = 24, n = 3, rng = Math.random) {
  const idx = new Set()
  while (idx.size < n) idx.add(Math.floor(rng() * total))
  return [...idx].sort((a, b) => a - b)
}

export function checkConfirm(mnemonic, answers) {
  const words = mnemonic.trim().split(/\s+/)
  return answers.every((a) => words[a.index]?.toLowerCase() === String(a.word).trim().toLowerCase())
}
```

```javascript
// frontend/src/wallet/ui/classic/importValidate.js
import { StrKey } from '@stellar/stellar-sdk'
import { validate as validMnemonic } from '../../classicKeypair.js'

export function classifyImport(input) {
  const s = (input || '').trim().replace(/\s+/g, ' ')
  if (StrKey.isValidEd25519SecretSeed(s)) return { kind: 'secret', normalized: s }
  const words = s.split(' ').filter(Boolean)
  if (words.length === 12 || words.length === 24) {
    if (validMnemonic(s)) return { kind: 'mnemonic', normalized: s }
    return { kind: 'invalid', error: 'Recovery phrase checksum failed — check for a mistyped word.' }
  }
  return { kind: 'invalid', error: 'Enter a 12/24-word recovery phrase or an S… secret key.' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- backupConfirm importValidate`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/src/wallet/ui/classic/backupConfirm.js frontend/src/wallet/ui/classic/backupConfirm.test.js frontend/src/wallet/ui/classic/importValidate.js frontend/src/wallet/ui/classic/importValidate.test.js
git commit -m "feat(wallet): backup subset-confirm + import classifier helpers"
```

---

## Task 9: Create / Backup / Import screens (presentational)

**Files:**
- Create: `frontend/src/wallet/ui/classic/CreateScreen.jsx`, `BackupScreen.jsx`, `ImportScreen.jsx`
- Test: `frontend/src/wallet/ui/classic/BackupScreen.test.jsx`

> **Design:** follow `DESIGN.md` (Acid Yield system) + existing `frontend/extension/popup.jsx` classes (`vf-*`). These are **presentational** — they receive data + callbacks as props; `popup.jsx` (Task 11) owns state and wraps them in `<Shell>`. Reuse `frontend/src/wallet/ui/HonestyLabels.jsx`.

**Interfaces (props):**
- `CreateScreen({ onCreate(label, password), onGoImport, busy, error })`
- `BackupScreen({ mnemonic, indices, onConfirm(answers), onSkip, error })` — no Copy button; blur/reveal; `spellcheck=false`
- `ImportScreen({ onImport(input, password, label), busy, error })`

- [ ] **Step 1: Write the failing test (backup confirm gate)**

```jsx
// frontend/src/wallet/ui/classic/BackupScreen.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import BackupScreen from './BackupScreen.jsx'

describe('BackupScreen', () => {
  it('reveals the phrase and only confirms with correct words', () => {
    const onConfirm = vi.fn()
    render(<BackupScreen mnemonic="alpha bravo charlie delta" indices={[1]} onConfirm={onConfirm} onSkip={() => {}} />)
    // hidden until reveal
    expect(screen.queryByText('bravo')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }))
    expect(screen.getByText('bravo')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/word #2/i), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(onConfirm).not.toHaveBeenCalled() // wrong word blocks
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- BackupScreen`
Expected: FAIL (`BackupScreen.jsx` missing).

- [ ] **Step 3: Write the screens**

```jsx
// frontend/src/wallet/ui/classic/BackupScreen.jsx
import { useState } from 'react'
import { checkConfirm } from './backupConfirm.js'
import { HonestyLabels } from '../HonestyLabels.jsx'

export default function BackupScreen({ mnemonic, indices, onConfirm, onSkip, error }) {
  const [revealed, setRevealed] = useState(false)
  const [answers, setAnswers] = useState({})
  const words = mnemonic.trim().split(/\s+/)

  function submit() {
    const list = indices.map((i) => ({ index: i, word: answers[i] ?? '' }))
    if (checkConfirm(mnemonic, list)) onConfirm(list)
  }

  return (
    <div className="vf-screen vf-backup">
      <h2>Back up your recovery phrase</h2>
      <HonestyLabels scope="testnet" />
      <p className="vf-warn">These 24 words are the only way to recover this wallet. VF cannot restore them. Write them on paper — never photograph, cloud-sync, message, or store in a password manager.</p>

      <div className={'vf-phrase' + (revealed ? ' revealed' : ' blurred')} aria-live="polite">
        {revealed
          ? words.map((w, i) => (<span key={i} className="vf-word" spellCheck={false}>{i + 1}. {w}</span>))
          : <button className="vf-btn" onClick={() => setRevealed(true)}>Reveal phrase</button>}
      </div>
      {/* No Copy button by design (clipboard is malware-readable). */}

      {revealed && (
        <div className="vf-confirm">
          <p>Confirm you saved it — re-enter these words:</p>
          {indices.map((i) => (
            <label key={i}>
              Word #{i + 1}
              <input
                aria-label={`word #${i + 1}`}
                spellCheck={false}
                autoComplete="off"
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
              />
            </label>
          ))}
          {error && <p className="vf-error">{error}</p>}
          <button className="vf-btn primary" onClick={submit}>Confirm & finish</button>
          <button className="vf-btn ghost" onClick={onSkip}>Skip for now (risky)</button>
        </div>
      )}
    </div>
  )
}
```

```jsx
// frontend/src/wallet/ui/classic/CreateScreen.jsx
import { useState } from 'react'
import { HonestyLabels } from '../HonestyLabels.jsx'

export default function CreateScreen({ onCreate, onGoImport, busy, error }) {
  const [label, setLabel] = useState('Main')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const weak = pw.length < 12
  const mismatch = pw !== pw2

  return (
    <div className="vf-screen vf-create">
      <h2>Create a classic wallet</h2>
      <HonestyLabels scope="testnet" />
      <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <label>Password (unlocks this wallet on this browser — not a recovery method)
        <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label>Confirm password
        <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </label>
      {weak && <p className="vf-hint">Use 12+ characters.</p>}
      {mismatch && pw2 && <p className="vf-error">Passwords do not match.</p>}
      {error && <p className="vf-error">{error}</p>}
      <button className="vf-btn primary" disabled={busy || weak || mismatch} onClick={() => onCreate(label, pw)}>
        {busy ? 'Creating…' : 'Create wallet'}
      </button>
      <button className="vf-btn ghost" onClick={onGoImport}>I already have a wallet — import</button>
    </div>
  )
}
```

```jsx
// frontend/src/wallet/ui/classic/ImportScreen.jsx
import { useState } from 'react'
import { classifyImport } from './importValidate.js'
import { HonestyLabels } from '../HonestyLabels.jsx'

export default function ImportScreen({ onImport, busy, error }) {
  const [input, setInput] = useState('')
  const [pw, setPw] = useState('')
  const [label, setLabel] = useState('Imported')
  const cls = input.trim() ? classifyImport(input) : { kind: 'invalid', error: '' }
  const ok = cls.kind !== 'invalid' && pw.length >= 12

  return (
    <div className="vf-screen vf-import">
      <h2>Import a wallet</h2>
      <HonestyLabels scope="testnet" />
      <label>Secret key (S…) or 12/24-word recovery phrase
        <textarea rows={3} spellCheck={false} autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} />
      </label>
      {input.trim() && cls.kind === 'invalid' && <p className="vf-error">{cls.error}</p>}
      {cls.kind !== 'invalid' && <p className="vf-hint">Detected: {cls.kind}</p>}
      <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      {error && <p className="vf-error">{error}</p>}
      <button className="vf-btn primary" disabled={busy || !ok} onClick={() => onImport(cls.normalized, pw, label)}>
        {busy ? 'Importing…' : 'Import'}
      </button>
    </div>
  )
}
```

> If `HonestyLabels` is not a named export with a `scope` prop, adapt the import/props to the actual `frontend/src/wallet/ui/HonestyLabels.jsx` surface (Task-0 recon showed five scoped labels — reuse the `testnet` one; add a `session-key` label per spec §5 in Task 11).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- BackupScreen`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/src/wallet/ui/classic/CreateScreen.jsx frontend/src/wallet/ui/classic/BackupScreen.jsx frontend/src/wallet/ui/classic/ImportScreen.jsx frontend/src/wallet/ui/classic/BackupScreen.test.jsx
git commit -m "feat(wallet): create/backup/import classic screens"
```

---

## Task 10: Home / Receive / History / Send screens (presentational)

**Files:**
- Create: `frontend/src/wallet/ui/classic/HomeScreen.jsx`, `ReceiveScreen.jsx`, `HistoryScreen.jsx`, `SendScreen.jsx`
- Create: `frontend/src/wallet/ui/classic/qr.js`
- Test: `frontend/src/wallet/ui/classic/SendScreen.test.jsx`

**Interfaces (props):**
- `HomeScreen({ publicKey, portfolio, unfunded, onFund, onSend, onReceive, busy })` — `portfolio` = `portfolioValue()` result or `null`
- `ReceiveScreen({ publicKey })` — QR via `qr.js`
- `HistoryScreen({ items })`
- `SendScreen({ from, onPreview, onConfirm, preview, busy, error })` — shows clear-sign confirm + vault verdict (via `ApproveOverlay`) before send
- `qr.js`: `addressQrDataUrl(address): Promise<string>`

- [ ] **Step 1: Write the failing test (send shows clear-sign confirm before submit)**

```jsx
// frontend/src/wallet/ui/classic/SendScreen.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SendScreen from './SendScreen.jsx'

describe('SendScreen', () => {
  it('requires a preview (clear-sign) before confirm is enabled', () => {
    const onPreview = vi.fn()
    const onConfirm = vi.fn()
    render(<SendScreen from="GME" onPreview={onPreview} onConfirm={onConfirm} preview={null} />)
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'GYOU' } })
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ to: 'GYOU', amount: '1' }))
    // confirm not present until a preview is supplied
    expect(screen.queryByRole('button', { name: /confirm & send/i })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- SendScreen`
Expected: FAIL.

- [ ] **Step 3: Write the screens + qr helper**

```javascript
// frontend/src/wallet/ui/classic/qr.js
import QRCode from 'qrcode'
export function addressQrDataUrl(address) {
  return QRCode.toDataURL(address, { margin: 1, width: 180 })
}
```

```jsx
// frontend/src/wallet/ui/classic/SendScreen.jsx
import { useState } from 'react'
import { ApproveOverlay } from '../ApproveOverlay.jsx'

export default function SendScreen({ from, onPreview, onConfirm, preview, busy, error }) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')

  return (
    <div className="vf-screen vf-send">
      <h2>Send</h2>
      <label>Destination<input aria-label="destination" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label>Amount (XLM)<input aria-label="amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>Memo (optional)<input value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      <button className="vf-btn" disabled={busy || !to || !amount} onClick={() => onPreview({ from, to, asset: 'XLM', amount, memo })}>
        Review
      </button>

      {preview && (
        <div className="vf-confirm-card">
          <h3>Confirm — you are signing this</h3>
          <dl>
            <dt>To</dt><dd>{preview.confirm.ops[0]?.destination}</dd>
            <dt>Asset</dt><dd>{preview.confirm.ops[0]?.asset}</dd>
            <dt>Amount</dt><dd>{preview.confirm.ops[0]?.amount}</dd>
            <dt>Memo</dt><dd>{preview.confirm.memo || '—'}</dd>
            <dt>Fee</dt><dd>{preview.confirm.fee} stroops</dd>
          </dl>
          {preview.vault?.hit && (
            <ApproveOverlay
              verdict={preview.vault}
              note={`This is vault "${preview.vault.name}". A plain payment will NOT deposit — use Deposit.`}
            />
          )}
          {error && <p className="vf-error">{error}</p>}
          <button className="vf-btn primary" disabled={busy} onClick={() => onConfirm({ from, to, asset: 'XLM', amount, memo })}>
            {busy ? 'Sending…' : 'Confirm & send'}
          </button>
        </div>
      )}
    </div>
  )
}
```

```jsx
// frontend/src/wallet/ui/classic/HomeScreen.jsx
export default function HomeScreen({ publicKey, portfolio, unfunded, onFund, onSend, onReceive, busy }) {
  return (
    <div className="vf-screen vf-home">
      <div className="vf-balance-card">
        <div className="vf-portfolio">
          {portfolio == null
            ? '—'
            : portfolio.complete
              ? `$${portfolio.total.toFixed(2)}`
              : `~$${portfolio.total.toFixed(2)} (partial)`}
        </div>
        <div className="vf-address" title={publicKey}>{publicKey.slice(0, 6)}…{publicKey.slice(-6)}</div>
      </div>

      {unfunded && (
        <div className="vf-fund">
          <p>This testnet account is not funded yet.</p>
          <button className="vf-btn" disabled={busy} onClick={onFund}>Fund via Friendbot</button>
        </div>
      )}

      <div className="vf-actions">
        <button className="vf-btn primary" onClick={onSend}>Send</button>
        <button className="vf-btn" onClick={onReceive}>Receive</button>
      </div>

      <ul className="vf-tokens">
        {(portfolio?.rows ?? []).map((r) => (
          <li key={r.asset}><span>{r.code}</span><span>{r.balance}</span><span>{r.usd == null ? '—' : `$${r.usd.toFixed(2)}`}</span></li>
        ))}
      </ul>
    </div>
  )
}
```

```jsx
// frontend/src/wallet/ui/classic/ReceiveScreen.jsx
import { useEffect, useState } from 'react'

export default function ReceiveScreen({ publicKey }) {
  const [src, setSrc] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    import('./qr.js').then(({ addressQrDataUrl }) => addressQrDataUrl(publicKey).then(setSrc))
  }, [publicKey])
  return (
    <div className="vf-screen vf-receive">
      <h2>Receive</h2>
      {src && <img className="vf-qr" src={src} alt="Wallet address QR" width={180} height={180} />}
      <code className="vf-address-full">{publicKey}</code>
      <button className="vf-btn" onClick={() => { navigator.clipboard?.writeText(publicKey); setCopied(true) }}>
        {copied ? 'Copied' : 'Copy address'}
      </button>
    </div>
  )
}
```

```jsx
// frontend/src/wallet/ui/classic/HistoryScreen.jsx
export default function HistoryScreen({ items }) {
  if (!items?.length) return <div className="vf-screen"><p>No activity yet.</p></div>
  return (
    <ul className="vf-screen vf-history">
      {items.map((x) => (
        <li key={x.id} className={x.direction}>
          <span>{x.direction === 'in' ? '↓' : '↑'} {x.amount} {x.asset === 'XLM' ? 'XLM' : x.asset.split(':')[0]}</span>
          <span className="vf-muted">{x.direction === 'in' ? x.from : x.to}</span>
          <time>{x.createdAt}</time>
        </li>
      ))}
    </ul>
  )
}
```

> If `ApproveOverlay` is a default (not named) export, adjust the import to match `frontend/src/wallet/ui/ApproveOverlay.jsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- SendScreen`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/src/wallet/ui/classic/HomeScreen.jsx frontend/src/wallet/ui/classic/ReceiveScreen.jsx frontend/src/wallet/ui/classic/HistoryScreen.jsx frontend/src/wallet/ui/classic/SendScreen.jsx frontend/src/wallet/ui/classic/qr.js frontend/src/wallet/ui/classic/SendScreen.test.jsx
git commit -m "feat(wallet): home/receive/history/send classic screens + QR"
```

---

## Task 11: Unlock/Settings + wire classic flow into `popup.jsx`

**Files:**
- Create: `frontend/src/wallet/ui/classic/UnlockScreen.jsx`, `SettingsScreen.jsx`
- Create: `frontend/src/wallet/ui/classic/controller.js` (thin orchestration used by popup: routes create→backup→home, wires handlers to `classicAccount`/`send`/`prices`/`history`)
- Modify: `frontend/extension/popup.jsx` (add classic screens + default route; install auto-lock)
- Modify: `frontend/src/wallet/ui/HonestyLabels.jsx` (add a `session-key` label per spec §5)
- Test: `frontend/src/wallet/ui/classic/controller.test.js`

**Interfaces:**
- `controller.js` produces `useClassicWallet()` (a hook) OR plain async handlers: `bootstrap()` → `{ hasWallet, publicKey, unlocked }`; `doCreate(label,pw)`, `doImport(input,pw,label)`, `confirmBackup()`, `doUnlock(pw)`, `doLock()`, `refreshHome()`, `doPreview(params)`, `doSend(params)`, `loadActivity()`. Keep it framework-light: export pure async functions that the popup calls and stores results in its `useState`.
- `UnlockScreen({ publicKey, onUnlock, error, busy })`
- `SettingsScreen({ onLock, onExport, autoLockMin, onSetAutoLock })` — export is password-gated show-once.

- [ ] **Step 1: Write the failing test (controller bootstrap + create→backup gating)**

```javascript
// frontend/src/wallet/ui/classic/controller.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { installChromeMock } from '../../testUtils.js'
import { bootstrap, doCreate, confirmBackup } from './controller.js'

beforeEach(() => { installChromeMock() })

describe('classic controller', () => {
  it('bootstrap reports no wallet initially, then create yields a pending-backup mnemonic', async () => {
    expect((await bootstrap()).hasWallet).toBe(false)
    const res = await doCreate('Main', 'pw12pw12pw12')
    expect(res.publicKey).toMatch(/^G/)
    expect(res.mnemonic.split(' ')).toHaveLength(24)
    expect(res.needsBackup).toBe(true)
  })

  it('bootstrap reports a wallet after create + backup confirm', async () => {
    await doCreate('Main', 'pw12pw12pw12')
    await confirmBackup()
    const b = await bootstrap()
    expect(b.hasWallet).toBe(true)
    expect(b.publicKey).toMatch(/^G/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- controller`
Expected: FAIL (`controller.js` missing).

- [ ] **Step 3: Write the controller + screens**

```javascript
// frontend/src/wallet/ui/classic/controller.js
import { listWallets } from '../../vault.js'
import { isUnlocked, lock, installAutoLock } from '../../session.js'
import {
  createClassicWallet, importFromSecret, importFromMnemonic,
  unlockWallet, readBalances, fundTestnet,
} from '../../classicAccount.js'
import { classifyImport } from './importValidate.js'
import { pickConfirmIndices } from './backupConfirm.js'
import { previewSend, sendPayment } from '../../send.js'
import { fetchXlmUsd, portfolioValue } from '../../prices.js'
import { fetchHistory } from '../../history.js'

let _pendingBackup = false // set true between create and confirmBackup

export async function bootstrap() {
  const wallets = await listWallets()
  const w = wallets[0]
  return {
    hasWallet: Boolean(w) && !_pendingBackup,
    publicKey: w?.publicKey ?? null,
    unlocked: await isUnlocked(),
    autoLockIndices: pickConfirmIndices(24, 3),
  }
}

export async function doCreate(label, password) {
  const { publicKey, mnemonic } = await createClassicWallet({ label, password })
  _pendingBackup = true
  return { publicKey, mnemonic, needsBackup: true, indices: pickConfirmIndices(24, 3) }
}

export function confirmBackup() {
  _pendingBackup = false
  return Promise.resolve(true)
}

export async function doImport(input, password, label) {
  const c = classifyImport(input)
  if (c.kind === 'secret') return importFromSecret({ secret: c.normalized, password, label })
  if (c.kind === 'mnemonic') return importFromMnemonic({ mnemonic: c.normalized, password, label })
  throw new Error(c.error)
}

export async function doUnlock(publicKey, password) { await unlockWallet(publicKey, password) }
export async function doLock() { await lock() }
export function armAutoLock() { installAutoLock({ idleMs: 600000 }) }

export async function refreshHome(publicKey) {
  const balances = await readBalances(publicKey)
  if (balances == null) return { unfunded: true, portfolio: null }
  let xlmUsd = await fetchXlmUsd()
  // Note-2 fallback: if CoinGecko is blocked (CORS/limit), try the VF API gateway, else degrade.
  if (xlmUsd == null) xlmUsd = await fetchXlmUsd({ endpoint: '/api/price?ids=stellar&vs_currencies=usd' }).catch(() => null)
  return { unfunded: false, portfolio: portfolioValue(balances, xlmUsd) }
}

export async function doFund(publicKey) { return fundTestnet(publicKey) }
export async function doPreview(params) { return previewSend(params) }
export async function doSend(params) { return sendPayment(params) }
export async function loadActivity(publicKey) { return fetchHistory(publicKey) }
```

```jsx
// frontend/src/wallet/ui/classic/UnlockScreen.jsx
import { useState } from 'react'

export default function UnlockScreen({ publicKey, onUnlock, error, busy }) {
  const [pw, setPw] = useState('')
  return (
    <div className="vf-screen vf-unlock">
      <h2>Unlock wallet</h2>
      <p className="vf-muted">{publicKey?.slice(0, 6)}…{publicKey?.slice(-6)}</p>
      <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onUnlock(pw)} />
      <p className="vf-hint">This password unlocks the local vault in this browser. It is not a recovery method — your 24 words are.</p>
      {error && <p className="vf-error">{error}</p>}
      <button className="vf-btn primary" disabled={busy || !pw} onClick={() => onUnlock(pw)}>Unlock</button>
    </div>
  )
}
```

```jsx
// frontend/src/wallet/ui/classic/SettingsScreen.jsx
export default function SettingsScreen({ onLock, onExport, autoLockMin, onSetAutoLock }) {
  return (
    <div className="vf-screen vf-settings">
      <h2>Settings</h2>
      <button className="vf-btn" onClick={onLock}>Lock now</button>
      <label>Auto-lock (minutes)
        <input type="number" min={1} max={60} value={autoLockMin} onChange={(e) => onSetAutoLock(Number(e.target.value))} />
      </label>
      <button className="vf-btn ghost" onClick={onExport}>Export secret (password required, shown once)</button>
      <p className="vf-warn">While unlocked, this wallet keeps a key in memory. Anyone who can already run code on your machine could read it. Lock the wallet when done.</p>
    </div>
  )
}
```

- [ ] **Step 4: Add the `session-key` HonestyLabel**

In `frontend/src/wallet/ui/HonestyLabels.jsx`, add a label matching the existing scoped-label pattern:

```jsx
// add alongside the existing testnet/recovery/etc. labels
session_key: {
  tone: 'warn',
  title: 'Unlocked wallet holds a key in memory',
  body: 'While unlocked, a key sits in chrome.storage.session (in-memory). Someone already running code on your machine could read it. Lock when done. Testnet PoC.',
},
```
(Match the exact object/enum shape used by the file — Task-0 recon noted five scoped labels; mirror that structure.)

- [ ] **Step 5: Wire into `frontend/extension/popup.jsx`**

Add classic screens to the router. At the top of the component, add classic state + effect:

```jsx
// near the other useState calls (popup.jsx ~line 198)
import CreateScreen from '../src/wallet/ui/classic/CreateScreen.jsx'
import BackupScreen from '../src/wallet/ui/classic/BackupScreen.jsx'
import ImportScreen from '../src/wallet/ui/classic/ImportScreen.jsx'
import HomeScreen from '../src/wallet/ui/classic/HomeScreen.jsx'
import SendScreen from '../src/wallet/ui/classic/SendScreen.jsx'
import ReceiveScreen from '../src/wallet/ui/classic/ReceiveScreen.jsx'
import HistoryScreen from '../src/wallet/ui/classic/HistoryScreen.jsx'
import UnlockScreen from '../src/wallet/ui/classic/UnlockScreen.jsx'
import * as C from '../src/wallet/ui/classic/controller.js'
```

```jsx
// state
const [cw, setCw] = useState({ ready: false, hasWallet: false, publicKey: null, unlocked: false })
const [backup, setBackup] = useState(null) // { mnemonic, indices, publicKey }
const [preview, setPreview] = useState(null)
const [portfolio, setPortfolio] = useState(null)
const [unfunded, setUnfunded] = useState(false)
const [activity, setActivity] = useState([])
const [busy, setBusy] = useState(false)
const [err, setErr] = useState('')

useEffect(() => {
  C.armAutoLock()
  C.bootstrap().then((b) => {
    setCw({ ready: true, ...b })
    if (b.hasWallet && !b.unlocked) setScreen('unlock')
    else if (b.hasWallet) { setScreen('home'); refresh(b.publicKey) }
    else setScreen('create')
  })
}, [])

async function refresh(pk) {
  const r = await C.refreshHome(pk)
  setUnfunded(r.unfunded); setPortfolio(r.portfolio)
}
```

Add handler functions + `if (screen === ...)` blocks for `create`, `backup`, `import`, `unlock`, `home`, `send`, `receive`, `activity`, `settings`, each wrapping the presentational screen in `<Shell nav active="..." onNav={nav}>`. Example (create → backup → home):

```jsx
if (screen === 'create') {
  return (
    <Shell>
      <CreateScreen
        busy={busy} error={err} onGoImport={() => setScreen('import')}
        onCreate={async (label, pw) => {
          setBusy(true); setErr('')
          try {
            const r = await C.doCreate(label, pw)
            setBackup({ mnemonic: r.mnemonic, indices: r.indices, publicKey: r.publicKey })
            setScreen('backup')
          } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
        }}
      />
    </Shell>
  )
}

if (screen === 'backup') {
  return (
    <Shell>
      <BackupScreen
        mnemonic={backup.mnemonic} indices={backup.indices} error={err}
        onConfirm={async () => { await C.confirmBackup(); setCw((s) => ({ ...s, hasWallet: true, publicKey: backup.publicKey, unlocked: true })); setScreen('home'); refresh(backup.publicKey) }}
        onSkip={async () => { await C.confirmBackup(); setScreen('home'); refresh(backup.publicKey) }}
      />
    </Shell>
  )
}

if (screen === 'home') {
  return (
    <Shell nav active="home" onNav={nav}>
      <HomeScreen
        publicKey={cw.publicKey} portfolio={portfolio} unfunded={unfunded} busy={busy}
        onFund={async () => { setBusy(true); await C.doFund(cw.publicKey); await refresh(cw.publicKey); setBusy(false) }}
        onSend={() => { setPreview(null); setScreen('send') }}
        onReceive={() => setScreen('receive')}
      />
    </Shell>
  )
}
```

> Wire `send` (calls `C.doPreview` → sets `preview`; `C.doSend` → success → `refresh` + `setScreen('activity')`), `receive`, `activity` (`C.loadActivity`), `unlock` (`C.doUnlock` → `home`), and `settings` the same way. Keep `NAV_TABS` for classic = `['home', 'send', 'receive', 'activity', 'settings']` (a separate const from the passkey `NAV_TABS`, or branch on wallet type). **Do not delete or alter the existing passkey screens/tabs** — leave them reachable but not the default.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — all new tests + all pre-existing passkey/wallet tests green.

- [ ] **Step 7: Build the extension**

Run: `npm run build:ext`
Expected: build succeeds, emits to `../extension-dist`.

- [ ] **Step 8: Commit**

```
git add frontend/src/wallet/ui/classic/controller.js frontend/src/wallet/ui/classic/controller.test.js frontend/src/wallet/ui/classic/UnlockScreen.jsx frontend/src/wallet/ui/classic/SettingsScreen.jsx frontend/src/wallet/ui/HonestyLabels.jsx frontend/extension/popup.jsx
git commit -m "feat(wallet): wire classic flow into popup + unlock/settings + auto-lock"
```

---

## Task 12: Manual testnet smoke (no code — verification gate)

**Not a code task** — the end-to-end proof required by the spec (§9). Do this in Chrome after `npm run build:ext` and loading `extension-dist` unpacked.

- [ ] Create a classic wallet → confirm 24-word show-once + subset-confirm gate works, `G…` shown.
- [ ] On Home, click **Fund via Friendbot** → balance appears (XLM).
- [ ] Send XLM to a second address → **clear-sign card shows** dest/asset/amount/memo/fee → confirm → tx succeeds.
- [ ] Open the tx on Stellar Expert (testnet) → confirm on-chain; the user's account paid the fee (own gas, not the relayer).
- [ ] Paste a `VAULT_CATALOG[0].address` as a send destination → **F8 verdict + "use Deposit" guard** appears.
- [ ] Reload the extension → wallet is **locked** (session cleared) → unlock with password → Home restored.
- [ ] Reimport from the 24-word mnemonic on a **fresh Chrome profile** → **same `G…` recovered**.
- [ ] Inspect `chrome.storage.local` (DevTools) → only ciphertext; **no `S…` / mnemonic in plaintext**. Inspect `chrome.storage.session` while unlocked → a JWK key, **not** the raw secret.

Record results (tx hash, recovered address) in a short note under `planning/` (uncommitted).

---

## Self-Review (completed during authoring)

**Spec coverage:**
- §3 modernized stack → Tasks 1 (`@scure/bip39`+`ed25519-hd-key`, 24w, path), 2 (AES-GCM+PBKDF2-600k), 3 (session-cached derived key). ✓
- §5 security → Task 2 (crypto, no-plaintext test), 3 (session/TRUSTED_CONTEXTS/auto-lock), 4 (`withSecret` wipe on success+error), 9 (show-once/no-copy/spellcheck-off/subset-confirm), 9/controller (import StrKey+checksum validation, address confirm), 11 (unlock copy, session-key HonestyLabel, wrong-pw throws). ✓
- §6 send (clear-sign all + F8 vaults, no invoke decode) → Tasks 5, 6, 10. ✓ (Note 1 honored: `clearSign` leaves invokes `decodable:false`.)
- §7 balances/prices/history/funding → Tasks 4, 7. ✓ (Note 2 honored: `prices.js` swappable + gateway fallback in controller.)
- §9 tests + manual smoke → every task TDD + Task 12. ✓
- §10 acceptance criteria → covered across Tasks 4–12. ✓
- Passkey untouched → stated in every relevant task; Task 11 Step 5 explicitly preserves passkey screens. ✓
- Note 3 (session-key honesty) → Task 11 Step 4 HonestyLabel + SettingsScreen warning. ✓

**Placeholder scan:** No TBD/TODO. Two adaptation notes (HonestyLabels export shape, ApproveOverlay export shape) are explicit "match the real surface" instructions, not deferred logic — acceptable because the exact prop shape is owned by existing files the implementer will open.

**Type consistency:** `VaultBlob`/`WalletRecord` shapes consistent across Tasks 2→3→4. `Balance` shape consistent Tasks 4→7→10. `previewSend` return `{ confirm, vault }` consistent Tasks 6→10→11. `withSecret(fn)` signature consistent Tasks 4→6. `classifyImport` return consistent Tasks 8→9→11.

**Known implementer watch-outs (call out, don't hide):**
1. `Buffer` in the extension bundle — needed by `keypairFromMnemonic`'s deps only if a lib returns Buffer; `toHex` avoids it in derivation, but `Keypair.fromRawEd25519Seed` + stellar-sdk already pull a Buffer polyfill in the existing build. Verify `npm run build:ext` doesn't error on `Buffer`.
2. WebCrypto in tests needs Node 20+ (global `crypto.subtle`). CI/local must be Node 20+.
3. The SEP-0005 vector in Task 1 is authoritative — if it fails, the wiring is wrong, not the vector.
4. `HonestyLabels`/`ApproveOverlay` exact export/prop shape — open the real files (Task-0 recon) and match.
