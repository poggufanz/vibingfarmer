import { connectPasskeyWallet, makeKit, readBalance } from '../src/wallet/account.js'
import { getTestUsdc } from '../src/wallet/faucet.js'
import { submitApprove, submitDeposit } from '../src/wallet/submit.js'
import { signAuthEntryString, signTransactionForContract } from '../src/wallet/signGeneric.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'
import { NETWORK_PASSPHRASE } from '../src/stellar/config.js'
import { BASE_UNIT, toBaseUnits } from '../src/stellar/format.js'
import { resolveActiveAccount } from '../src/wallet/activeAccount.js'
import { createRequestSnapshot, validateRequestSnapshot } from '../src/wallet/consentStore.js'
import { summarizeTransaction, summarizeAuthEntry } from './txSummary.js'
import { buildCeremonyView, renderCeremonyView } from './ceremonyView.js'

const ONE_TOKEN = BigInt(BASE_UNIT)
const APPROVE_CAP = 100n * ONE_TOKEN

// Synthetic requester.origin for createRequestSnapshot/validateRequestSnapshot (src/wallet/
// consentStore.js), whose module doc explicitly anticipates this reuse: "a later internal-action
// producer (VFW 13 -- popup-originated ceremonies like deposit/approve) can reuse it unchanged."
// Those two functions require a truthy requester.origin (they were built for the dapp path, where
// it is Chrome-verified sender.origin) -- this ceremony never has a dapp sender to verify at all
// (it is opened by this SAME extension's own popup, never a content script), so a fixed sentinel
// satisfies the shape without claiming a website origin that does not exist.
const INTERNAL_SENDER = { origin: 'vf-wallet-internal' }

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

// Consequence-first (Task 13, Step 2): renders the full disclosure (origin, active address,
// network, action/amount/contract consequence, why a passkey touch is requested) into
// ceremony.html's #ceremony-main BEFORE any WebAuthn call runs.
//
// Fix round 1, I1: this used to swallow a rendering failure (missing #ceremony-main, or any
// throw from buildCeremonyView/renderCeremonyView) and let the ceremony proceed to Face ID and
// submission anyway -- a ceremony that shows the user nothing must not be allowed to act on their
// behalf. It now THROWS instead, and is called (see runCeremony) before makeKit/WebAuthn, so a
// rendering failure is caught by runCeremony's own catch block and reported as an honest ok:false
// failure -- no kit, no connect, no submit ever runs without the disclosure having rendered first.
function renderConsequenceFirstView({
  documentRef,
  action,
  params,
  address,
  amountUnits,
  decodedSummary,
  submissionState,
}) {
  const mainEl = documentRef?.getElementById?.('ceremony-main')
  if (!mainEl || typeof mainEl.append !== 'function') {
    throw new Error(
      'VF Wallet: could not render the consequence disclosure — refusing to proceed to Face ID'
    )
  }
  const view = buildCeremonyView(
    { action, params },
    { address, amountUnits, decodedSummary, submissionState }
  )
  renderCeremonyView(mainEl, view)
}

function decodeForDisplay(action, p) {
  if (action === 'signTransaction') return summarizeTransaction(p.xdr)
  if (action === 'signAuthEntry') return summarizeAuthEntry(p.authEntry)
  return null
}

async function loadParams(chromeApi) {
  const tabId = (await chromeApi.tabs.getCurrent())?.id
  const got = await chromeApi.storage.session.get(`vf_params_${tabId}`)
  return { tabId, params: got[`vf_params_${tabId}`] ?? {} }
}

async function resolveSnapshotAccount(chromeApi) {
  try {
    const result = await resolveActiveAccount({
      storageLocal: chromeApi?.storage?.local,
      migrate: false,
    })
    return result.status === 'ready' ? result.account : null
  } catch {
    return null // an unreadable/corrupt store resolves to "no verified account", never a guess
  }
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
  now = Date.now,
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

    // Security (Task 13, Step 1/4): an immutable, expiring snapshot of the active account,
    // captured BEFORE any WebAuthn call, and revalidated once more right before the result is
    // delivered -- reusing src/wallet/consentStore.js's createRequestSnapshot/
    // validateRequestSnapshot exactly as that module's own doc anticipates for this task, and
    // src/wallet/activeAccount.js's resolveActiveAccount as the one authoritative resolver (same
    // convention as approve.js's own verifyStillValid). A mismatched, switching, or expired
    // request submits NOTHING: the throw below happens before makeKit/connectPasskeyWallet/
    // submitDeposit/submitApprove are ever called.
    //
    // Fix round 1, I3: the snapshot's clock is stamped from `p.requestedAt` (the real moment
    // popup.jsx's postSignRequest fired, threaded through background.js's SIGN_REQUEST params
    // verbatim) -- before this, the snapshot was stamped from ceremony.js's OWN now() at the top
    // of this function, so "expired" could only ever measure this function's own elapsed runtime,
    // never a genuinely stale request that was already past its TTL before the ceremony tab even
    // finished opening.
    //
    // Wave 6 carry (VF Wallet Task 13 re-review, Minor): the fallback to this ceremony's own
    // now() for a caller that omits requestedAt was a weak seam on the two actions that actually
    // move money -- a future edit that drops requestedAt from popup.jsx's postSignRequest would
    // silently revert to the pre-fix behaviour with no test catching it. deposit/approve fail
    // closed instead of guessing a timestamp; the other actions (connect/signTransaction/
    // signAuthEntry) are unaffected and keep the same fallback they always had.
    // Fix round 1 (reviewer M5): Number.isFinite, not `typeof x !== 'number'` -- the latter admits
    // NaN (typeof NaN === 'number'), reopening exactly the hole VF Wallet Task 13 closed: a NaN
    // requestedAt would sail past this guard and then make the expiry comparison in
    // validateRequestSnapshot silently always resolve "not expired" (NaN > x is always false).
    if ((action === 'deposit' || action === 'approve') && !Number.isFinite(p.requestedAt)) {
      throw new Error(
        'VF Wallet: missing requestedAt for a value-moving ceremony action — refusing to guess a timestamp'
      )
    }
    const requestedAddress = p.contractId ?? p.opts?.address ?? null
    const accountAtStart = await resolveSnapshotAccount(chromeApi)
    const snapshot = createRequestSnapshot({
      rid: `ceremony:${action}`,
      method: action,
      params: { opts: { address: requestedAddress } },
      sender: INTERNAL_SENDER,
      account: accountAtStart,
      now: typeof p.requestedAt === 'number' ? p.requestedAt : now(),
    })
    if (requestedAddress) {
      const preCheck = validateRequestSnapshot(snapshot, {
        activeAccount: accountAtStart,
        now: now(),
      })
      if (!preCheck.ok) throw new Error(preCheck.error)
    }

    // Revalidates the SAME snapshot captured above against a FRESHLY re-resolved active account —
    // never the account captured at the top, never a locally re-derived guess. Nothing to
    // reconfirm for an untargeted request (e.g. a fresh `connect` with no requestedAddress).
    async function revalidateAtDelivery() {
      if (!requestedAddress) return { ok: true }
      const fresh = await resolveSnapshotAccount(chromeApi)
      return validateRequestSnapshot(snapshot, { activeAccount: fresh, now: now() })
    }

    const decodedSummary = decodeForDisplay(action, p)
    renderConsequenceFirstView({
      documentRef,
      action,
      params: p,
      address: accountAtStart?.address ?? requestedAddress,
      amountUnits: action === 'deposit' ? depositAmount : action === 'approve' ? APPROVE_CAP : null,
      decodedSummary,
      submissionState: 'waiting-passkey',
    })

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
      // Security (Task 13, Step 3): a shares-delta "confirmed deposit" claim may appear only once
      // the transaction is actually confirmed (out.status === 'SUCCESS') -- the relay's own
      // pollResult can legitimately hand back 'PENDING' (submitted but not yet observed; see
      // api/stellar-relay.js's pollResult doc) while sharesAfter was still read right after
      // submission. A pending/unknown status must read as unknown, never as a minted-shares claim
      // and never as zero.
      const confirmed = out.status === 'SUCCESS'
      setStatus(
        documentRef,
        confirmed
          ? `Minted ${mintedShares} shares.`
          : `Submitted (${out.status || 'unknown'}). Not yet confirmed — check the shares balance before relying on this number.`
      )
      const postCheck = await revalidateAtDelivery()
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        hash: out.hash,
        status: out.status,
        sharesBefore,
        sharesAfter,
        accountSnapshotId: snapshot.account?.id ?? null,
        ...(postCheck.ok ? {} : { accountSnapshotStale: true }),
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
      const postCheck = await revalidateAtDelivery()
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        hash: out.hash,
        status: out.status,
        accountSnapshotId: snapshot.account?.id ?? null,
        ...(postCheck.ok ? {} : { accountSnapshotStale: true }),
      })
    } else if (action === 'connect') {
      // The kit's getAddress()/isConnected() — connectPasskeyWallet (above) already did the
      // work; this action just reports the resolved contractId back through the ceremony result.
      setStatus(documentRef, 'Connected.')
      const postCheck = await revalidateAtDelivery()
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        address: connectedContractId,
        accountSnapshotId: snapshot.account?.id ?? null,
        ...(postCheck.ok ? {} : { accountSnapshotStale: true }),
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
      // Security (Task 13, Step 1/4): this ceremony SIGNS ONLY — it never submits the result
      // anywhere itself. A built-but-not-submitted artifact must never be exposed as completed:
      // if the active account changed or the request went stale while Face ID was pending, the
      // signed XDR is discarded here and NEVER included in the CEREMONY_RESULT payload — the
      // caller sees an honest failure, never a false "signed" success for a context that no
      // longer holds.
      const postCheck = await revalidateAtDelivery()
      if (!postCheck.ok) {
        throw new Error(`not submitted: ${postCheck.error}`)
      }
      setStatus(documentRef, 'Transaction signed.')
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        signedTxXdr,
        address: connectedContractId,
        accountSnapshotId: snapshot.account?.id ?? null,
      })
    } else if (action === 'signAuthEntry') {
      setStatus(documentRef, 'Awaiting Face ID…')
      const signedAuthEntry = await signAuthEntryString({ authEntry: p.authEntry, kit })
      // Same discard-on-staleness rule as signTransaction above — see that branch's doc.
      const postCheck = await revalidateAtDelivery()
      if (!postCheck.ok) {
        throw new Error(`not submitted: ${postCheck.error}`)
      }
      setStatus(documentRef, 'Authorization signed.')
      chromeApi.runtime.sendMessage({
        type: 'CEREMONY_RESULT',
        tabId,
        action,
        ok: true,
        signedAuthEntry,
        address: connectedContractId,
        accountSnapshotId: snapshot.account?.id ?? null,
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
