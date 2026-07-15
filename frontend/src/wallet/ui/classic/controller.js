// frontend/src/wallet/ui/classic/controller.js
// Thin orchestration between the classic wallet modules (vault/session/classicAccount/send/
// prices/history) and the popup UI. Framework-light by design: plain async functions the popup
// calls, storing results in its own useState — this file owns no React state itself.
import { listWallets, getWallet, saveWallet, decryptSecret } from '../../vault.js'
import { isUnlocked, lock, installAutoLock } from '../../session.js'
import {
  createClassicWallet,
  importFromSecret,
  importFromMnemonic,
  unlockWallet,
  readBalances,
  fundTestnet,
} from '../../classicAccount.js'
import { classifyImport } from './importValidate.js'
import { pickConfirmIndices } from './backupConfirm.js'
import { previewSend, sendPayment } from '../../send.js'
import { addTrustline } from '../../trustline.js'
import { fetchXlmUsd, portfolioValue } from '../../prices.js'
import { fetchHistory } from '../../history.js'

export async function bootstrap() {
  const wallets = await listWallets()
  const w = wallets[0]
  return {
    hasWallet: Boolean(w),
    publicKey: w?.publicKey ?? null,
    unlocked: await isUnlocked(),
    needsBackup: Boolean(w?.needsBackup),
  }
}

// The pending-backup gate is persisted in the vault record itself (needsBackup +
// an encrypted mnemonicBlob), NOT in module-scope state: MV3 popups are non-persistent
// and can close between create and "Confirm & finish", which would otherwise reset an
// in-memory flag and silently strand the 24 words with no way to see them again.
// storage.local only ever holds the AES-GCM ciphertext here, never the plaintext phrase.
// classicAccount writes the record + gate in ONE atomic saveWallet call (pendingBackup:
// true) — there is no second save here, so there is no window where a flagless record
// can be persisted while the mnemonic is lost.
export async function doCreate(label, password) {
  const { publicKey, mnemonic } = await createClassicWallet({
    label,
    password,
    pendingBackup: true,
  })
  return { publicKey, mnemonic, needsBackup: true, indices: pickConfirmIndices(24, 3) }
}

// Finalizes the backup: clears the gate and deletes the encrypted mnemonic blob outright
// (show-once semantics — no ciphertext lingers after the user has confirmed the backup).
export async function confirmBackup(publicKey) {
  const rec = await getWallet(publicKey)
  if (!rec) throw new Error('wallet not found')
  const { mnemonicBlob, ...rest } = rec
  await saveWallet({ ...rest, needsBackup: false })
  return true
}

// Re-derives the mnemonic from the persisted blob for the popup-reopen path (backup was
// pending when the popup closed). Wrong password throws via the AES-GCM auth tag — never
// caught-and-continued — and the decrypted string must only ever live in transient React
// state in the caller, never written back to storage.
export async function revealBackup(publicKey, password) {
  const rec = await getWallet(publicKey)
  if (!rec?.mnemonicBlob) throw new Error('no pending backup for this wallet')
  return decryptSecret(rec.mnemonicBlob, password)
}

export async function doImport(input, password, label) {
  const c = classifyImport(input)
  if (c.kind === 'secret') return importFromSecret({ secret: c.normalized, password, label })
  if (c.kind === 'mnemonic') return importFromMnemonic({ mnemonic: c.normalized, password, label })
  throw new Error(c.error)
}

export async function doUnlock(publicKey, password) {
  await unlockWallet(publicKey, password)
}
export async function doLock() {
  await lock()
}
export function armAutoLock() {
  installAutoLock({ idleMs: 600000 })
}

export async function refreshHome(publicKey) {
  const balances = await readBalances(publicKey)
  if (balances == null) return { unfunded: true, portfolio: null }
  let xlmUsd = await fetchXlmUsd()
  // Primary feed (CoinGecko) can be CORS/rate-limit blocked from an extension origin; degrade
  // through the VF API gateway before falling back to balance-only display.
  if (xlmUsd == null) {
    xlmUsd = await fetchXlmUsd({ endpoint: '/api/price?ids=stellar&vs_currencies=usd' }).catch(
      () => null
    )
  }
  return { unfunded: false, portfolio: portfolioValue(balances, xlmUsd) }
}

export async function doFund(publicKey) {
  return fundTestnet(publicKey)
}
export async function doPreview(params) {
  return previewSend(params)
}
export async function doSend(params) {
  return sendPayment(params)
}
export async function doAddAsset(code, issuer) {
  return addTrustline({ code, issuer })
}
export async function loadActivity(publicKey) {
  return fetchHistory(publicKey)
}

// Password-gated, show-once secret export. Reads straight from the encrypted vault record
// (never the in-memory session key) so a compromised session cache alone cannot export the
// secret, and a wrong password throws (AES-GCM auth tag) rather than silently failing.
export async function doExport(publicKey, password) {
  const rec = await getWallet(publicKey)
  if (!rec) throw new Error('wallet not found')
  return decryptSecret(rec.blob, password)
}
