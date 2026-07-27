// Consent UI for dapp-originated requests (opened by background.js as a small popup window,
// approve.html?rid=<rid>). Two jobs a normal wallet does that VF Wallet didn't:
//   connect variant — "this site wants to connect" (once per origin; background persists the
//     allowlist on ok:true, so this screen never reappears for the same site), and
//   sign variant — decoded tx/auth-entry summary + Confirm/Cancel BEFORE the passkey ceremony.
// Reading the wallet address needs no passkey (contractId is public, already in storage.local);
// only Confirm on a sign request triggers Face ID. Runs at the extension origin because
// WebAuthn credentials are origin-bound — same constraint as ceremony.js.
//
// VF Wallet Task 12 -- this file is now pure orchestration (chrome messaging, the sign/unlock
// ceremonies, and the pre-sign snapshot re-check). Every view-model and DOM-rendering concern
// (screen ordering, the decoded-grant breakdown, the submission-state vocabulary) moved to
// approvalView.js, a pure vanilla module with no chrome/DOM dependency of its own — see that
// file's header for the security rules it enforces (verified-origin-only rendering, fail-closed
// grant degrade, no coerced-empty values).
import './shims.js' // must stay first: installs process/Buffer before the classic-wallet chunk evaluates (see shims.js)
import { makeKit, connectPasskeyWallet } from '../src/wallet/account.js'
import { signTransactionForContract, signAuthEntryString } from '../src/wallet/signGeneric.js'
import { unlockWallet, withSecret } from '../src/wallet/classicAccount.js'
import { isUnlocked } from '../src/wallet/session.js'
import { rpcServer } from '../src/stellar/client.js'
import { NETWORK_PASSPHRASE } from '../src/stellar/config.js'
import { resolveActiveAccount } from '../src/wallet/activeAccount.js'
import { validateRequestSnapshot } from '../src/wallet/consentStore.js'
import { summarizeTransaction, summarizeAuthEntry } from './txSummary.js'
import {
  buildApprovalView,
  renderApprovalView,
  submissionStatusText,
  SUBMISSION_STATE,
} from './approvalView.js'

// How many ledgers a dapp-requested auth-entry signature stays valid — mirrors
// stellar/agentDeposit.js's AUTH_TTL_LEDGERS (same "session-length" signing idiom).
const AUTH_TTL_LEDGERS = 360

/** ActiveAccountV1's 'G'|'C' kind -> this screen's 'classic'|'passkey' vocabulary (copy/behavior
 *  below is keyed on the latter). */
export function screenKind(accountKind) {
  return accountKind === 'G' ? 'classic' : accountKind === 'C' ? 'passkey' : null
}

/** Re-resolves the CURRENT active account (never the snapshot's own, and never a locally
 *  re-derived "passkey wins" guess — resolveActiveAccount is the one authoritative resolver,
 *  same as background.js/popup.jsx) and checks it still matches the snapshot this approval
 *  screen was opened for. Fails closed on any account switch/ambiguity/expiry/mismatch, BEFORE
 *  Face ID or the wallet password prompt ever runs. `storageLocal` is injectable for testing —
 *  defaults to the real chrome.storage.local. */
export async function verifyStillValid(req, storageLocal = chrome.storage.local) {
  const fresh = await resolveActiveAccount({ storageLocal, migrate: false })
  const activeAccount = fresh.status === 'ready' ? fresh.account : null
  return validateRequestSnapshot(req, { activeAccount, now: Date.now() })
}

/** Exact CEREMONY_RESULT for a user rejection (SEP-43 -4). */
export function rejectionResult(rid) {
  return { type: 'CEREMONY_RESULT', rid, ok: false, code: -4, error: 'User rejected the request' }
}

async function approveSign(req, rid, address) {
  const kit = await makeKit()
  const contractId = req.params?.opts?.address ?? address
  await connectPasskeyWallet({ contractId, kit })
  if (req.method === 'signTransaction') {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk')
    const tx = TransactionBuilder.fromXDR(req.params.xdr, NETWORK_PASSPHRASE)
    const signedTxXdr = await signTransactionForContract({ tx, contractId, kit })
    return { type: 'CEREMONY_RESULT', rid, ok: true, signedTxXdr, address: contractId }
  }
  const signedAuthEntry = await signAuthEntryString({
    authEntry: req.params.authEntry,
    contractId,
    kit,
  })
  return { type: 'CEREMONY_RESULT', rid, ok: true, signedAuthEntry, address: contractId }
}

/** Classic (password/mnemonic) wallet counterpart of approveSign — assumes the session is
 *  already unlocked (caller handles the password prompt / wrong-password retry). Exported for
 *  direct testing of the expectedPublicKey fail-closed wiring below. */
export async function approveSignClassic(req, rid, address) {
  // expectedPublicKey: an unlocked session left over from a DIFFERENT G-address (multiple
  // vf_classic_wallets entries) must never sign on behalf of the snapshot's account — fail closed
  // (withSecret throws 'locked: unlocked session does not match the active account') rather than
  // silently sign with whoever happens to be unlocked.
  return withSecret(
    async (kp) => {
      const sdkMod = await import('@stellar/stellar-sdk')
      if (req.method === 'signTransaction') {
        const tx = sdkMod.TransactionBuilder.fromXDR(req.params.xdr, NETWORK_PASSPHRASE)
        tx.sign(kp)
        return { type: 'CEREMONY_RESULT', rid, ok: true, signedTxXdr: tx.toXDR(), address }
      }
      const entry = sdkMod.xdr.SorobanAuthorizationEntry.fromXDR(req.params.authEntry, 'base64')
      const server = await rpcServer()
      const latest = await server.getLatestLedger()
      const signed = await sdkMod.authorizeEntry(
        entry,
        kp,
        latest.sequence + AUTH_TTL_LEDGERS,
        NETWORK_PASSPHRASE
      )
      return {
        type: 'CEREMONY_RESULT',
        rid,
        ok: true,
        signedAuthEntry: signed.toXDR('base64'),
        address,
      }
    },
    { expectedPublicKey: address }
  )
}

// ---- real wiring below (no-op under vitest: chrome/storage absent) ----

const setStatus = (t) => {
  const el = document.getElementById('status')
  if (el) el.textContent = t
}

/** Renders `view` (approvalView.buildApprovalView's output) into the page: the ordered content
 *  goes into #approval-main (approvalView.js owns all of that), while the footer's Cancel/
 *  Confirm buttons stay static HTML (approve.html) whose LABEL text this function sets — the
 *  small Pocket Crew logo in the static header is untouched by either. */
function render(view) {
  const main = document.getElementById('approval-main')
  if (main) renderApprovalView(main, view)
  const rejectBtn = document.getElementById('reject')
  const approveBtn = document.getElementById('approve')
  if (rejectBtn) rejectBtn.textContent = view.rejectLabel
  if (approveBtn) {
    approveBtn.textContent = view.approveLabel ?? ''
    // blocked-origin carries no confirming action at all — never render a clickable Confirm for
    // a request this screen could not verify.
    approveBtn.hidden = view.approveLabel == null
  }
}

/** I1 fix: a schema-mismatch (fail-closed, VFW3) consequence sets `view.needsAcknowledgment` --
 *  Confirm must stay disabled until the user has actually opened the raw technical-details
 *  disclosure approvalView.js renders (`#raw-details`), never offering the friendly primary action
 *  for free on a request VF Wallet could not decode. Exported and takes plain injected elements
 *  (not `document.getElementById` itself) so this is testable with bare fake objects, no jsdom or
 *  chrome mock required. */
export function wireAcknowledgmentGate(view, { approveBtn, detailsEl }) {
  if (!view.needsAcknowledgment || !approveBtn) return
  approveBtn.disabled = true
  if (!detailsEl) return
  detailsEl.addEventListener('toggle', () => {
    if (detailsEl.open) approveBtn.disabled = false
  })
}

if (typeof window !== 'undefined' && globalThis.chrome?.storage?.session) {
  ;(async () => {
    try {
      // URL only ever carries the rid — an identifier, never authority. Every fact this screen
      // acts on (origin, method, params, account) comes from the snapshot background.js stashed
      // against that rid from Chrome-verified sender + the resolved active account.
      const rid = new URLSearchParams(location.search).get('rid')
      const got = await chrome.storage.session.get(`vf_req_${rid}`)
      const req = got[`vf_req_${rid}`]
      if (!req || Date.now() > req.expiresAt) {
        setStatus('Request expired: close this window and retry from the site.')
        return
      }
      const account = req.account ?? null
      const address = account?.address ?? null
      const kind = screenKind(account?.kind)
      // Expected address pinned: a session unlocked for a DIFFERENT G-address must read as
      // locked for THIS snapshot, not "unlocked" off a lingering foreign session.
      const unlocked = kind === 'classic' ? await isUnlocked(address) : false
      const summary =
        req.method === 'signTransaction'
          ? summarizeTransaction(req.params?.xdr)
          : req.method === 'signAuthEntry'
            ? summarizeAuthEntry(req.params?.authEntry)
            : null
      const view = buildApprovalView(
        { method: req.method, params: req.params, origin: req.requester?.origin },
        { address, summary, kind, unlocked, submissionState: SUBMISSION_STATE.REVIEWING }
      )
      render(view)
      // I1 fix: gate Confirm on the raw technical-details disclosure for a schema-mismatch.
      wireAcknowledgmentGate(view, {
        approveBtn: document.getElementById('approve'),
        detailsEl: document.getElementById('raw-details'),
      })

      document.getElementById('reject').onclick = () => {
        chrome.runtime.sendMessage(rejectionResult(rid))
        setStatus(submissionStatusText(SUBMISSION_STATE.REJECTED))
        window.close()
      }

      if (view.approveLabel == null) return // blocked-origin: no confirming action to wire up

      document.getElementById('approve').onclick = async () => {
        try {
          if (view.variant === 'no-wallet') {
            chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') })
            chrome.runtime.sendMessage({
              type: 'CEREMONY_RESULT',
              rid,
              ok: false,
              code: -1,
              error: 'No wallet created in VF Wallet yet; create one, then retry.',
            })
            window.close()
            return
          }

          // Fail closed BEFORE signing on any account switch/ambiguity/expiry/mismatch — never
          // re-derived locally (that was the "passkey wins" bug); always the one authoritative
          // resolver, re-checked fresh against this exact snapshot.
          const check = await verifyStillValid(req)
          if (!check.ok) {
            chrome.runtime.sendMessage({
              type: 'CEREMONY_RESULT',
              rid,
              ok: false,
              code: check.code,
              error: check.error,
            })
            setStatus(submissionStatusText(SUBMISSION_STATE.FAILED, { detail: check.error }))
            setTimeout(() => window.close(), 800)
            return
          }

          if (view.variant === 'connect') {
            chrome.runtime.sendMessage({ type: 'CEREMONY_RESULT', rid, ok: true, address })
            // Connect has no SUBMISSION_STATE of its own -- the vocabulary models the sign/submit
            // ceremony only (see approvalView.js's module doc); this is a literal, not a divergence.
            setStatus('Connected.')
            setTimeout(() => window.close(), 400)
            return
          }
          setStatus(
            submissionStatusText(
              kind === 'classic'
                ? SUBMISSION_STATE.WAITING_PASSWORD
                : SUBMISSION_STATE.WAITING_PASSKEY
            )
          )
          if (kind === 'classic' && !(await isUnlocked(address))) {
            try {
              await unlockWallet(address, document.getElementById('pw')?.value ?? '')
            } catch {
              const pw = document.getElementById('pw')
              if (pw) pw.value = ''
              setStatus(
                submissionStatusText(SUBMISSION_STATE.WAITING_PASSWORD, {
                  detail: 'Wrong password.',
                })
              )
              return // no CEREMONY_RESULT — window stays open so the user can retry
            }
          }
          const result =
            kind === 'classic'
              ? await approveSignClassic(req, rid, address)
              : await approveSign(req, rid, address)
          if (kind === 'classic') {
            const pw = document.getElementById('pw')
            if (pw) pw.value = ''
          }
          chrome.runtime.sendMessage(result)
          // Signed and returned to the requesting origin — this extension never submits a
          // generic dapp signTransaction/signAuthEntry request itself, so the ceremony ends
          // here. "Submitted"/"Confirmed" are reserved for a future internal flow that owns
          // real submission + a transaction hash + reconciliation (see approvalView.js). I2 fix:
          // sourced from submissionStatusText, not a hand-duplicated string (the module's own copy
          // and this call site had already drifted -- a trailing period here, none there).
          setStatus(
            submissionStatusText(SUBMISSION_STATE.SIGNED_RETURNED, {
              origin: req.requester?.origin,
            })
          )
          setTimeout(() => window.close(), 800)
        } catch (e) {
          setStatus(submissionStatusText(SUBMISSION_STATE.FAILED, { detail: e.message }))
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
      setStatus(submissionStatusText(SUBMISSION_STATE.FAILED, { detail: String(e?.message || e) }))
    }
  })()
}
