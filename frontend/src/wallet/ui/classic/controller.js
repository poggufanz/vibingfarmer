// frontend/src/wallet/ui/classic/controller.js
// Thin orchestration between the classic wallet modules (vault/session/classicAccount/send/
// prices/history) and the popup UI. Framework-light by design: plain async functions the popup
// calls, storing results in its own useState — this file owns no React state itself.
import { listWallets, getWallet, decryptSecret } from '../../vault.js'
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
