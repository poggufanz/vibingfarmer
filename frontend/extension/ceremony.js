import { makeKit, createPasskeyWallet, connectPasskeyWallet, readBalance } from '../src/wallet/account.js'
import { submitDeposit, submitApprove } from '../src/wallet/submit.js'
import { signTransactionForContract, signAuthEntryString } from '../src/wallet/signGeneric.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'
import { FAUCET_PROXY_URL, NETWORK_PASSPHRASE } from '../src/stellar/config.js'

const params = new URLSearchParams(location.search)
const action = params.get('action')
const setStatus = (t) => {
  const el = document.getElementById('status')
  if (el) el.textContent = t
}

async function loadParams() {
  const tabId = (await chrome.tabs.getCurrent())?.id
  const got = await chrome.storage.session.get(`vf_params_${tabId}`)
  return { tabId, p: got[`vf_params_${tabId}`] ?? {} }
}

// NOTE (Task 4 Step 4 deferred check): connectPasskeyWallet returns only
// { contractId } — no default credentialId. We run the default signing path:
// submit.js calls kit.signAuthEntry WITHOUT an explicit credentialId. The
// manual Chrome E2E (Task 7) MUST confirm Face-ID signing succeeds on this
// default path; if SAK needs an explicit credentialId, thread one through
// account.js connectPasskeyWallet → submitDeposit/submitApprove.
;(async () => {
  let tabId
  let p = {}
  try {
    const loaded = await loadParams()
    tabId = loaded.tabId
    p = loaded.p
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
      setStatus('Awaiting Face ID…')
      // Default = the live deposit vault's protocol (autofarm → Blend USDC), not aave-v3.
      const { facts } = vaultFacts(p.protocol || 'blend-usdc')
      const eligibility = (q) => vfEligibility({ ...q, facts })
      out = await executeAgentDeposit({
        amount: p.amount,
        minAmount: p.minAmount || '0',
        minShares: p.minShares || '0',
        execId: p.execId,
        eligibility,
        kit,
      })
      setStatus('Deposit executed.')
      chrome.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        hash: out.hash,
        status: out.status,
      })
    } else if (action === 'approve') {
      setStatus('Awaiting Face ID…')
      out = await executeAgentApprove({
        amount: p.amount,
        execId: p.execId,
        kit,
      })
      setStatus(out.action === 'mint' ? 'Deposit completed.' : 'Approval completed.')
      chrome.runtime.sendMessage({
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
      setStatus('Connected.')
      chrome.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        address: connectedContractId,
      })
    } else if (action === 'signTransaction') {
      setStatus('Awaiting Face ID…')
      const { TransactionBuilder } = await import('@stellar/stellar-sdk')
      const tx = TransactionBuilder.fromXDR(p.xdr, NETWORK_PASSPHRASE)
      const signedTxXdr = await signTransactionForContract({
        tx,
        contractId: p.opts?.address || connectedContractId,
        kit,
      })
      setStatus('Transaction signed.')
      chrome.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        signedTxXdr,
        address: connectedContractId,
      })
    } else if (action === 'signAuthEntry') {
      setStatus('Awaiting Face ID…')
      const signedAuthEntry = await signAuthEntryString({ authEntry: p.authEntry, kit })
      setStatus('Authorization signed.')
      chrome.runtime.sendMessage({
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
    setTimeout(() => window.close(), 1200)
  } catch (e) {
    let debugInfo = ''
    try {
      const lsVal = localStorage.getItem('vf_wallet_contract')
      debugInfo = ` (LS: ${lsVal ? lsVal.slice(0, 6) + '...' : 'empty'}`
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const store = await chrome.storage.local.get('vf_wallet_contract')
        const csVal = store['vf_wallet_contract']
        debugInfo += `, CS: ${csVal ? csVal.slice(0, 6) + '...' : 'empty'}`
      } else {
        debugInfo += `, CS: no-chrome`
      }
      debugInfo += `)`
    } catch (err) {
      debugInfo = ` (debug err: ${err.message})`
    }
    setStatus(`Failed: ${e.message}${debugInfo}`)
    chrome.runtime.sendMessage({
      type: 'CEREMONY_RESULT',
      tabId,
      action,
      ok: false,
      error: String(e.message || e),
    })
  }
})()
