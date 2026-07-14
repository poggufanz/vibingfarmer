// Consent UI for dapp-originated requests (opened by background.js as a small popup window,
// approve.html?rid=<rid>). Two jobs a normal wallet does that VF Wallet didn't:
//   connect variant — "this site wants to connect" (once per origin; background persists the
//     allowlist on ok:true, so this screen never reappears for the same site), and
//   sign variant — decoded tx/auth-entry summary + Approve/Reject BEFORE the passkey ceremony.
// Reading the wallet address needs no passkey (contractId is public, already in storage.local);
// only Approve on a sign request triggers Face ID. Runs at the extension origin because
// WebAuthn credentials are origin-bound — same constraint as ceremony.js.
import { makeKit, connectPasskeyWallet } from '../src/wallet/account.js'
import { signTransactionForContract, signAuthEntryString } from '../src/wallet/signGeneric.js'
import { NETWORK_PASSPHRASE, STELLAR_NETWORK_LABEL } from '../src/stellar/config.js'
import { summarizeTransaction, summarizeAuthEntry, shortAddr } from './txSummary.js'

/** Exact CEREMONY_RESULT for a user rejection (SEP-43 -4). */
export function rejectionResult(rid) {
  return { type: 'CEREMONY_RESULT', rid, ok: false, code: -4, error: 'User rejected the request' }
}

/**
 * Pure view-model: decides which screen to show and what rows it lists.
 * @param {{method:string, params:object, origin:string}} req  the stashed vf_req_<rid>
 * @param {{address:string|null, summary?:object|null}} ctx
 */
export function screenModel(req, { address, summary } = {}) {
  if (!address) {
    return {
      variant: 'no-wallet',
      origin: req.origin,
      title: 'No wallet yet',
      note: 'Create a wallet in VF Wallet first, then retry from the site.',
      approveLabel: 'Open VF Wallet',
      rows: [],
      raw: null,
    }
  }
  if (req.method === 'getAddress') {
    return {
      variant: 'connect',
      origin: req.origin,
      title: 'Connection request',
      note: 'This site will see your address and may request signatures.',
      approveLabel: 'Connect',
      rows: [
        ['Account', shortAddr(address)],
        ['Network', STELLAR_NETWORK_LABEL],
      ],
      raw: null,
    }
  }
  const rows = [
    ['Network', summary?.network ?? STELLAR_NETWORK_LABEL],
    ['Signer', shortAddr(summary?.signer ?? address)],
  ]
  if (summary?.contract) {
    rows.push([
      'Contract',
      `${shortAddr(summary.contract)}${summary.contractLabel ? ` (${summary.contractLabel})` : ''}`,
    ])
  }
  if (summary?.fn) rows.push(['Function', summary.fn])
  ;(summary?.args ?? []).forEach((a, i) => rows.push([i === 0 ? 'Args' : '', a]))
  return {
    variant: 'sign',
    origin: req.origin,
    title: 'Signature request',
    note: 'Approving opens the passkey (Face ID) prompt.',
    approveLabel: 'Approve',
    rows,
    raw: req.method === 'signTransaction' ? (req.params?.xdr ?? null) : (req.params?.authEntry ?? null),
  }
}

// ---- real wiring below (no-op under vitest: chrome/storage absent) ----

const setStatus = (t) => {
  const el = document.getElementById('status')
  if (el) el.textContent = t
}

function render(model) {
  document.getElementById('origin').textContent = model.origin
  document.getElementById('title').textContent = model.title
  document.getElementById('note').textContent = model.note
  document.getElementById('approve').textContent = model.approveLabel
  const rows = document.getElementById('rows')
  rows.innerHTML = ''
  for (const [k, v] of model.rows) {
    const tr = document.createElement('tr')
    const th = document.createElement('th')
    th.textContent = k
    const td = document.createElement('td')
    td.textContent = v
    tr.append(th, td)
    rows.append(tr)
  }
  const rawWrap = document.getElementById('raw-wrap')
  if (model.raw) {
    rawWrap.style.display = ''
    document.getElementById('raw').textContent = model.raw
  } else {
    rawWrap.style.display = 'none'
  }
}

async function approveSign(req, rid, address) {
  setStatus('Awaiting Face ID…')
  const kit = await makeKit()
  const contractId = req.params?.opts?.address ?? address
  await connectPasskeyWallet({ contractId, kit })
  if (req.method === 'signTransaction') {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk')
    const tx = TransactionBuilder.fromXDR(req.params.xdr, NETWORK_PASSPHRASE)
    const signedTxXdr = await signTransactionForContract({ tx, contractId, kit })
    return { type: 'CEREMONY_RESULT', rid, ok: true, signedTxXdr, address: contractId }
  }
  const signedAuthEntry = await signAuthEntryString({ authEntry: req.params.authEntry, kit })
  return { type: 'CEREMONY_RESULT', rid, ok: true, signedAuthEntry, address: contractId }
}

if (typeof window !== 'undefined' && globalThis.chrome?.storage?.session) {
  ;(async () => {
    try {
      const rid = new URLSearchParams(location.search).get('rid')
      const got = await chrome.storage.session.get(`vf_req_${rid}`)
      const req = got[`vf_req_${rid}`]
      if (!req) {
        setStatus('Request expired — close this window and retry from the site.')
        return
      }
      const store = await chrome.storage.local.get('vf_wallet_contract')
      const address = store.vf_wallet_contract || null
      const summary =
        req.method === 'signTransaction'
          ? summarizeTransaction(req.params?.xdr)
          : req.method === 'signAuthEntry'
            ? summarizeAuthEntry(req.params?.authEntry)
            : null
      const model = screenModel(req, { address, summary })
      render(model)

      document.getElementById('reject').onclick = () => {
        chrome.runtime.sendMessage(rejectionResult(rid))
        window.close()
      }
      document.getElementById('approve').onclick = async () => {
        try {
          if (model.variant === 'no-wallet') {
            chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') })
            chrome.runtime.sendMessage({
              type: 'CEREMONY_RESULT',
              rid,
              ok: false,
              code: -1,
              error: 'No wallet created in VF Wallet yet — create one, then retry.',
            })
            window.close()
            return
          }
          if (model.variant === 'connect') {
            chrome.runtime.sendMessage({ type: 'CEREMONY_RESULT', rid, ok: true, address })
            setStatus('Connected.')
            setTimeout(() => window.close(), 400)
            return
          }
          const result = await approveSign(req, rid, address)
          chrome.runtime.sendMessage(result)
          setStatus('Signed.')
          setTimeout(() => window.close(), 800)
        } catch (e) {
          setStatus(`Failed: ${e.message}`)
          chrome.runtime.sendMessage({
            type: 'CEREMONY_RESULT',
            rid,
            ok: false,
            code: -1,
            error: String(e.message || e),
          })
          // window stays open so the user can read the error; closing is a no-op for the
          // already-settled request (background ignores onRemoved for settled rids).
        }
      }
    } catch (e) {
      setStatus(`Failed: ${String(e?.message || e)}`)
    }
  })()
}
