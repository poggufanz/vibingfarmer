import { connectPasskeyWallet, makeKit, readBalance } from '../src/wallet/account.js'
import { getTestUsdc } from '../src/wallet/faucet.js'
import { submitApprove, submitDeposit } from '../src/wallet/submit.js'
import { signAuthEntryString, signTransactionForContract } from '../src/wallet/signGeneric.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'
import { NETWORK_PASSPHRASE } from '../src/stellar/config.js'
import { BASE_UNIT, toBaseUnits } from '../src/stellar/format.js'

const ONE_TOKEN = BigInt(BASE_UNIT)
const APPROVE_CAP = 100n * ONE_TOKEN

export function normalizeDepositAmount(amount) {
  const raw = typeof amount === 'string' ? amount.trim() : amount
  if (raw === undefined || raw === null || raw === '') {
    throw new Error('Deposit amount is required.')
  }

  const numeric = Number(raw)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('Deposit amount must be a finite positive number.')
  }
  if (numeric < 1 / BASE_UNIT) {
    throw new Error('Deposit amount must be at least one 7-decimal base unit.')
  }

  const scaled = Math.round(numeric * BASE_UNIT)
  if (!Number.isSafeInteger(scaled)) {
    throw new Error('Deposit amount exceeds the safe 7-decimal range.')
  }
  const units = toBaseUnits(raw)
  if (units <= 0n) {
    throw new Error('Deposit amount must be at least one 7-decimal base unit.')
  }
  return units
}

const setStatus = (documentRef, text) => {
  const el = documentRef?.getElementById?.('status')
  if (el) el.textContent = text
}

async function loadParams(chromeApi) {
  const tabId = (await chromeApi.tabs.getCurrent())?.id
  const got = await chromeApi.storage.session.get(`vf_params_${tabId}`)
  return { tabId, params: got[`vf_params_${tabId}`] ?? {} }
}

// NOTE (Task 4 Step 4 deferred check): connectPasskeyWallet returns only
// { contractId } — no default credentialId. We run the default signing path:
// submit.js calls kit.signAuthEntry WITHOUT an explicit credentialId. The
// manual Chrome E2E (Task 7) MUST confirm Face-ID signing succeeds on this
// default path; if SAK needs an explicit credentialId, thread one through
// account.js connectPasskeyWallet → submitDeposit/submitApprove.
export async function runCeremony({
  action = new URLSearchParams(globalThis.location?.search ?? '').get('action'),
  params: suppliedParams,
  tabId: suppliedTabId,
  chromeApi = globalThis.chrome,
  documentRef = globalThis.document,
  localStorageRef = globalThis.localStorage,
  windowRef = globalThis.window,
  scheduleClose = globalThis.setTimeout,
} = {}) {
  let tabId = suppliedTabId
  let p = suppliedParams ?? {}

  try {
    if (suppliedParams === undefined) {
      const loaded = await loadParams(chromeApi)
      tabId = loaded.tabId
      p = loaded.params
    }

    const depositAmount = action === 'deposit' ? normalizeDepositAmount(p.amount) : null
    const kit = await makeKit()

    // connect/signTransaction/signAuthEntry (the generic wallet-kit actions dispatched by
    // providerBridge.js) carry the contractId under opts.address instead of the top-level
    // p.contractId deposit/approve use — accept either so one connect covers every action.
    const { contractId: connectedContractId } = await connectPasskeyWallet({
      contractId: p.contractId ?? p.opts?.address,
      kit,
    })

    let out
    if (action === 'deposit') {
      setStatus(documentRef, 'Awaiting Face ID…')
      // Default = the live deposit vault's protocol (autofarm → Blend USDC), not aave-v3.
      const { facts } = vaultFacts(p.protocol || 'blend-usdc')
      const eligibility = (query) => vfEligibility({ ...query, facts })
      out = await submitDeposit({
        contractId: connectedContractId,
        amount: depositAmount,
        eligibility,
        kit,
      })
      const sharesBefore = BigInt(out.sharesBefore).toString()
      const sharesAfter = BigInt(out.sharesAfter).toString()
      const mintedShares = BigInt(sharesAfter) - BigInt(sharesBefore)
      setStatus(documentRef, `Minted ${mintedShares} shares.`)
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        hash: out.hash,
        status: out.status,
        sharesBefore,
        sharesAfter,
      })
    } else if (action === 'approve') {
      setStatus(documentRef, 'Enabling deposits: funding and Face ID…')
      const balance = await readBalance(connectedContractId)
      let faucetUnavailable = false
      if (balance === null || balance === undefined || BigInt(balance) < ONE_TOKEN) {
        try {
          const funding = await getTestUsdc({ to: connectedContractId, amount: APPROVE_CAP })
          faucetUnavailable = BigInt(funding?.dispensed ?? 0) <= 0n
        } catch {
          faucetUnavailable = true
        }
      }
      out = await submitApprove({
        contractId: connectedContractId,
        amount: APPROVE_CAP,
        kit,
      })
      setStatus(
        documentRef,
        faucetUnavailable
          ? 'Approval set, but test tokens were not dispensed because the faucet is unavailable. Your balance may be 0; deposit may fail until funded.'
          : 'Deposits enabled.'
      )
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        hash: out.hash,
        status: out.status,
      })
    } else if (action === 'connect') {
      // The kit's getAddress()/isConnected() — connectPasskeyWallet (above) already did the
      // work; this action just reports the resolved contractId back through the ceremony result.
      setStatus(documentRef, 'Connected.')
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        address: connectedContractId,
      })
    } else if (action === 'signTransaction') {
      setStatus(documentRef, 'Awaiting Face ID…')
      const { TransactionBuilder } = await import('@stellar/stellar-sdk')
      const tx = TransactionBuilder.fromXDR(p.xdr, NETWORK_PASSPHRASE)
      const signedTxXdr = await signTransactionForContract({
        tx,
        contractId: p.opts?.address || connectedContractId,
        kit,
      })
      setStatus(documentRef, 'Transaction signed.')
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        signedTxXdr,
        address: connectedContractId,
      })
    } else if (action === 'signAuthEntry') {
      setStatus(documentRef, 'Awaiting Face ID…')
      const signedAuthEntry = await signAuthEntryString({ authEntry: p.authEntry, kit })
      setStatus(documentRef, 'Authorization signed.')
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        signedAuthEntry,
        address: connectedContractId,
      })
    } else {
      throw new Error(`unknown ceremony action: ${action}`)
    }

    scheduleClose(() => windowRef?.close?.(), 1200)
    return out
  } catch (error) {
    let debugInfo = ''
    try {
      const lsVal = localStorageRef?.getItem?.('vf_wallet_contract')
      debugInfo = ` (LS: ${lsVal ? `${lsVal.slice(0, 6)}...` : 'empty'}`
      if (chromeApi?.storage?.local) {
        const store = await chromeApi.storage.local.get('vf_wallet_contract')
        const csVal = store.vf_wallet_contract
        debugInfo += `, CS: ${csVal ? `${csVal.slice(0, 6)}...` : 'empty'}`
      } else {
        debugInfo += ', CS: no-chrome'
      }
      debugInfo += ')'
    } catch (debugError) {
      debugInfo = ` (debug err: ${debugError.message})`
    }

    setStatus(documentRef, `Failed: ${error.message}${debugInfo}`)
    chromeApi.runtime.sendMessage({
      type: 'CEREMONY_RESULT',
      tabId,
      action,
      ok: false,
      error: String(error.message || error),
    })
    return null
  }
}

export function shouldAutoRunCeremony({
  chromeApi = globalThis.chrome,
  documentRef = globalThis.document,
  locationRef = globalThis.location,
} = {}) {
  return Boolean(
    locationRef?.protocol === 'chrome-extension:' &&
    chromeApi?.runtime?.id &&
    typeof chromeApi.runtime.sendMessage === 'function' &&
    typeof chromeApi.tabs?.getCurrent === 'function' &&
    typeof chromeApi.storage?.session?.get === 'function' &&
    typeof documentRef?.getElementById === 'function'
  )
}

if (shouldAutoRunCeremony()) {
  void runCeremony()
}
