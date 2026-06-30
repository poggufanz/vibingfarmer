import { makeKit, connectPasskeyWallet, readBalance } from '../src/wallet/account.js'
import { submitDeposit, submitApprove } from '../src/wallet/submit.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'
import { FAUCET_PROXY_URL } from '../src/stellar/config.js'

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
    await connectPasskeyWallet({ contractId: p.contractId, kit })
    let out
    if (action === 'deposit') {
      setStatus('Awaiting Face ID…')
      const { facts } = vaultFacts(p.protocol || 'aave-v3')
      const eligibility = (q) => vfEligibility({ ...q, facts })
      const amount = BigInt(Math.round(parseFloat(p.amount) * 1e7))
      out = await submitDeposit({ contractId: p.contractId, amount, eligibility, kit })
      setStatus(`Minted ${BigInt(out.sharesAfter) - BigInt(out.sharesBefore)} shares.`)
      chrome.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        hash: out.hash,
        status: out.status,
        sharesBefore: String(out.sharesBefore),
        sharesAfter: String(out.sharesAfter),
      })
    } else if (action === 'approve') {
      setStatus('Enabling deposits — funding + Face ID…')
      // Idempotent: mint only if the balance is low, then (re)issue the approve.
      const bal = await readBalance(p.contractId)
      let dispensed = true
      if (!bal || bal < 10n ** 7n) {
        const faucetRes = await fetch(FAUCET_PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'dispense', to: p.contractId }),
        })
        dispensed = faucetRes.ok
      }
      out = await submitApprove({ contractId: p.contractId, amount: 100n * 10n ** 7n, kit })
      setStatus(
        dispensed
          ? 'Deposits enabled.'
          : 'Approval set — but test tokens were not dispensed (faucet unavailable). Your balance may be 0; deposit may fail until funded.'
      )
      chrome.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        hash: out.hash,
        status: out.status,
      })
    } else {
      throw new Error(`unknown ceremony action: ${action}`)
    }
    setTimeout(() => window.close(), 1200)
  } catch (e) {
    setStatus(`Failed: ${e.message}`)
    chrome.runtime.sendMessage({
      type: 'CEREMONY_RESULT',
      tabId,
      action,
      ok: false,
      error: String(e.message || e),
    })
  }
})()
