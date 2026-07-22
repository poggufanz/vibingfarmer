import { connectPasskeyWallet, makeKit } from '../src/wallet/account.js'
import { submitApprove, submitDeposit } from '../src/wallet/submit.js'
import { signAuthEntryString, signTransactionForContract } from '../src/wallet/signGeneric.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'
import { NETWORK_PASSPHRASE } from '../src/stellar/config.js'

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
        amount: p.amount,
        eligibility,
        kit,
      })
      setStatus(documentRef, 'Deposit executed.')
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        hash: out.hash,
        status: out.status,
      })
    } else if (action === 'approve') {
      setStatus(documentRef, 'Awaiting Face ID…')
      out = await submitApprove({
        contractId: connectedContractId,
        amount: p.amount,
        kit,
      })
      setStatus(documentRef, out.action === 'mint' ? 'Deposit completed.' : 'Approval completed.')
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

if (typeof chrome !== 'undefined' && typeof document !== 'undefined') {
  void runCeremony()
}
