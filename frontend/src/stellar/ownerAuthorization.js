// frontend/src/stellar/ownerAuthorization.js
// OwnerAuthorizationV1 — the sole adapter every owner action (grant, revoke, full exit,
// exit-signer registration, partial-withdraw registration) routes through to pick HOW the owner
// authorizes a transaction:
//
//   G (classic keypair) — signs a classic transaction ENVELOPE, sourced by itself. Direct submit
//   always works (the owner pays its own fee); the relay is an optional gasless convenience.
//
//   C (VF Wallet / passkey smart account) — can NEVER be a classic transaction source: a contract
//   address has no sequence number and cannot pay fees (see wallet/signGeneric.js's header note).
//   It signs a Soroban AUTH ENTRY instead, on a transaction sourced by a funded relayer G. The
//   relay is not optional here — a C account holds no XLM, so there is no user-funded fallback.
//
// This module owns the model choice (resolveOwnerTxModel) and the submission-channel policy
// (submitOwnerAuthorizedTx). The actual per-action transaction shape (which contract/method/args)
// stays in each action's own file — this adapter only decides WHO signs, sourced by WHAT, and
// WHERE the signed transaction is allowed to land.
import { submitViaRelay, RelayRejectedError } from './relay.js'
import { submitUserTx, rpcServer } from './client.js'
import { NETWORK_PASSPHRASE } from './config.js'
import { activeAccountChanged, assertActiveAccountBoundary } from './activeAccount.js'
import { assertSelectedWalletSnapshot, getActiveAccount, readSelectedWallet } from './walletKit.js'

// Legacy/versionless callers never need the current V1 record. Keeping this binding lazy means
// their older injected wallet mocks need not expose an unused getter; every V1 boundary invokes
// it immediately and still fails closed.
const readCurrentActiveAccount = () => getActiveAccount()

// Dynamically imported (like wallet/account.js's own makeKit) so that G-only callers — the
// overwhelming majority of owner actions — never pull wallet/account.js's SAK-adjacent module
// graph into their bundle/module evaluation just by importing this adapter.
let _signGeneric = null
async function signGeneric() {
  if (!_signGeneric) _signGeneric = await import('../wallet/signGeneric.js')
  return _signGeneric
}

let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk')
  return _sdk
}

/**
 * A submission-CHANNEL failure — distinct from "the transaction failed on-chain" (callers still
 * throw a plain Error for that, unchanged). Three shapes only:
 *   VF_FEE_PAYER_UNAVAILABLE — a C action found no funded relayer G. Thrown BEFORE any ceremony
 *                              (WebAuthn) runs, so nothing was ever asked of the user.
 *   VF_RELAY_REFUSED         — the relay was reached and explicitly said no (policy, guard, bad
 *                              fee-bump). Definite: nothing was submitted.
 *   VF_SUBMISSION_UNKNOWN    — contact with the relay was lost AFTER the owner already signed.
 *                              We cannot prove the request never landed, so this must not be
 *                              treated as "not submitted" (retry) or "submitted" (mark done) —
 *                              only chain/explorer reconciliation is safe.
 */
export class OwnerActionSubmissionError extends Error {
  constructor(message, code, submission, cause) {
    super(message)
    this.name = 'OwnerActionSubmissionError'
    this.code = code
    this.submission = submission
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Pick the owner's transaction model from VFW1's authoritative active-account record. Fails
 * closed on any mismatch — a stale/foreign active account must never sign as an owner it does not
 * match, and a C account must never be handed back as a classic envelope source.
 * @param {{owner:string, activeAccount:{kind:'G'|'C', address:string}, getRelayerAddress:() => Promise<string|null>}} p
 * @returns {Promise<{kind:'G', source:string, owner:string}
 *                   |{kind:'C', source:string, owner:string, contractId:string}>}
 */
export async function resolveOwnerTxModel({
  owner,
  activeAccount,
  getRelayerAddress,
  getCurrentActiveAccount = readCurrentActiveAccount,
  signal,
}) {
  const check = () =>
    assertActiveAccountBoundary({
      captured: activeAccount,
      getCurrent: getCurrentActiveAccount,
      signal,
    })
  check()
  if (!activeAccount || (activeAccount.kind !== 'G' && activeAccount.kind !== 'C')) {
    throw new Error('resolveOwnerTxModel: no active account to authorize this owner action.')
  }
  if (activeAccount.address !== owner) {
    throw new Error('resolveOwnerTxModel: the active account does not match the owner.')
  }
  if (activeAccount.kind === 'G') {
    // Classic envelope, source = the owner itself. A C address can never reach this branch.
    return {
      kind: 'G',
      source: owner,
      owner,
      ...(activeAccount.version === 1 ? { activeAccount, getCurrentActiveAccount, signal } : {}),
    }
  }
  // C: resolve + validate the funded relayer G BEFORE any ceremony — a missing fee payer must
  // never prompt Face ID for a signature that could not be submitted anyway.
  const relayer = await getRelayerAddress()
  check()
  if (!relayer) {
    throw new OwnerActionSubmissionError(
      'The gasless relay has no funded fee payer available right now.',
      'VF_FEE_PAYER_UNAVAILABLE',
      'not-submitted'
    )
  }
  return {
    kind: 'C',
    source: relayer,
    owner,
    contractId: owner,
    ...(activeAccount.version === 1 ? { activeAccount, getCurrentActiveAccount, signal } : {}),
  }
}

/**
 * Build → sign → submit an owner-authorized transaction, per the model `resolveOwnerTxModel`
 * picked. `build`/`sign` are the caller's own ceremony (the transaction shape differs per action,
 * and the signing ceremony differs per model); this function owns only which channel(s) the
 * signed transaction is allowed to reach:
 *
 *   - G + classicSubmission:'direct'       user-paid submit only — the relay is NEVER consulted.
 *     The kill-switch actions (revoke / full exit / exit-signer registration) must keep working
 *     even when the relay is down.
 *   - G + classicSubmission:'prefer-relay'  the relay is tried first (gasless). An explicit
 *     refusal is NOT permission to bill the user (mirrors relay.js's own contract), so it throws
 *     rather than falling back — but an UNREACHABLE relay (no answer at all) safely falls back to
 *     the direct, user-paid submit.
 *   - C                                     relay-only, always — `classicSubmission` is not
 *     consulted. A C account holds no XLM and has no user-funded submission to fall back to.
 * @param {{model:object, build:(model:object)=>Promise<{tx?:object, xdr:string}>,
 *          sign:(built:object, model:object, label?:string)=>Promise<string>, server?:object,
 *          label?:string, classicSubmission?:'direct'|'prefer-relay', pollTries?:number,
 *          pollIntervalMs?:number}} p pollTries/pollIntervalMs pass straight through to the
 *          direct-submit channel's confirmation poll (client.js's submitUserTx) — some actions
 *          (a multi-agent sweep) need a longer confirmation budget than the default.
 * @returns {Promise<object>} whatever the winning channel returns (`{hash, status, ...}`), plus
 *          `channel: 'relay'|'direct'` so callers can word a non-SUCCESS error per channel.
 */
export async function submitOwnerAuthorizedTx({
  model,
  build,
  sign,
  server,
  label,
  classicSubmission = 'direct',
  pollTries,
  pollIntervalMs,
  activeAccount = model?.activeAccount,
  getCurrentActiveAccount = model?.getCurrentActiveAccount || readCurrentActiveAccount,
  signal = model?.signal,
}) {
  const check = () =>
    assertActiveAccountBoundary({
      captured: activeAccount,
      getCurrent: getCurrentActiveAccount,
      signal,
    })
  check()
  const built = await build(model)
  check()
  check()
  const signed = await sign(built, model, label)
  check()

  if (model.kind === 'C') return relayOnly(signed, label, check, signal)

  if (classicSubmission === 'prefer-relay') {
    let relayed
    try {
      check()
      relayed = await submitViaRelay({ xdr: signed, ...(signal ? { signal } : {}) })
      checkAfterDispatch(check, label)
    } catch (e) {
      throw dispatchError(e, label, signal)
    }
    if (relayed) {
      check()
      return { ...relayed, channel: 'relay' }
    }
    // null = relay unreachable (never refused) -> the owner falls back to paying its own fee.
  }
  check()
  let res
  try {
    res = await submitUserTx({
      signedXdr: signed,
      server,
      ...(signal ? { signal } : {}),
      ...(pollTries != null ? { pollTries } : {}),
      ...(pollIntervalMs != null ? { pollIntervalMs } : {}),
    })
    checkAfterDispatch(check, label)
  } catch (error) {
    throw dispatchError(error, label, signal)
  }
  return { ...res, channel: 'direct' }
}

async function relayOnly(signedXdr, label, check = () => {}, signal) {
  let relayed
  try {
    check()
    relayed = await submitViaRelay({ xdr: signedXdr, ...(signal ? { signal } : {}) })
    checkAfterDispatch(check, label)
  } catch (e) {
    throw dispatchError(e, label, signal)
  }
  if (!relayed) {
    // The ceremony (WebAuthn) already ran; a C account has no direct fallback to reach for. We
    // cannot prove the relay never saw the request, so this is neither "not submitted" (unsafe to
    // assume) nor "submitted" (unsafe to mark done) — only chain reconciliation is honest here.
    throw new OwnerActionSubmissionError(
      `Lost contact with the relay after signing${label ? ` (${label})` : ''}. Check the chain before retrying.`,
      'VF_SUBMISSION_UNKNOWN',
      'unknown'
    )
  }
  check()
  return { ...relayed, channel: 'relay' }
}

function submissionUnknown(label, cause) {
  return new OwnerActionSubmissionError(
    `The active account changed after dispatch${label ? ` (${label})` : ''}. Check the chain before retrying.`,
    'VF_SUBMISSION_UNKNOWN',
    'unknown',
    cause
  )
}

function checkAfterDispatch(check, label) {
  try {
    check()
  } catch (error) {
    throw submissionUnknown(label, error)
  }
}

function dispatchError(error, label, signal) {
  if (
    error?.code === 'VF_SUBMISSION_UNKNOWN' ||
    error?.code === 'ACTIVE_ACCOUNT_CHANGED' ||
    error?.name === 'AbortError' ||
    signal?.aborted
  )
    return error?.code === 'VF_SUBMISSION_UNKNOWN' ? error : submissionUnknown(label, error)
  return refusalError(error, label)
}

function refusalError(e, label) {
  if (e instanceof RelayRejectedError) {
    return new OwnerActionSubmissionError(
      `The relay refused this ${label || 'owner'} transaction: ${e.message}`,
      'VF_RELAY_REFUSED',
      'not-submitted'
    )
  }
  return e
}

/**
 * The C-account signing ceremony shared by every owner action: sign the Soroban auth entry
 * credentialed to the owner's passkey contract (signGeneric.js's kit.signAuthEntry ceremony —
 * already unit-tested there), then re-simulate from a FRESH TransactionBuilder parse.
 *
 * The re-simulate is not optional: the first (recording-mode) simulation that produced `tx` ran
 * BEFORE any credentials were attached, so its footprint can miss entries the signed credentials'
 * larger payload now needs — the exact footprint-miss agentDeposit.js's buildAgentAuthedInvoke
 * documents for the agent's ed25519 auth path. Re-parsing from the signed XDR (rather than
 * re-preparing `tx` in place) mirrors that proven fix exactly.
 * @param {{tx:object, contractId:string, server?:object, kit?:object}} p
 * @returns {Promise<string>} base64 XDR, source = the relayer, ready to relay-submit
 */
export async function signOwnerAuthEntry({
  tx,
  contractId,
  server,
  kit,
  activeAccount,
  getCurrentActiveAccount = readCurrentActiveAccount,
  signal,
}) {
  const check = () =>
    assertActiveAccountBoundary({
      captured: activeAccount,
      getCurrent: getCurrentActiveAccount,
      signal,
    })
  check()
  const { signTransactionForContract } = await signGeneric()
  check()
  let signedXdr
  if (activeAccount?.version === 1) {
    const before = await readSelectedWallet({ kit })
    check()
    assertSelectedWalletSnapshot({ activeAccount, snapshot: before })
    const { Address, xdr: sdkXdr } = await sdk()
    check()
    const wanted = Address.fromString(contractId).toScAddress().toXDR('base64')
    let signedAny = false
    for (const op of tx.operations) {
      const entries = op.auth || []
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') continue
        if (entry.credentials().address().address().toXDR('base64') !== wanted) continue
        check()
        const freshBefore = await readSelectedWallet({ kit: before.binding })
        check()
        assertSelectedWalletSnapshot({
          activeAccount,
          snapshot: freshBefore,
          module: before.module,
        })
        check()
        const signed = await before.module.signAuthEntry(entry.toXDR('base64'), {
          address: activeAccount.address,
          networkPassphrase: activeAccount.networkPassphrase,
        })
        check()
        if (signed?.signerAddress != null && signed.signerAddress !== activeAccount.address)
          throw activeAccountChanged()
        const freshAfter = await readSelectedWallet({ kit: before.binding })
        check()
        assertSelectedWalletSnapshot({
          activeAccount,
          snapshot: freshAfter,
          module: before.module,
        })
        entries[index] = sdkXdr.SorobanAuthorizationEntry.fromXDR(signed?.signedAuthEntry, 'base64')
        signedAny = true
      }
    }
    if (!signedAny)
      throw new Error('VF Wallet found no auth entry in this transaction for its own account')
    signedXdr = tx.toEnvelope().toXDR('base64')
  } else {
    signedXdr = await signTransactionForContract({ tx, contractId, kit })
    check()
  }
  const { TransactionBuilder } = await sdk()
  check()
  const s = server || (await rpcServer())
  check()
  const rebuilt = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  check()
  const prepared = await s.prepareTransaction(rebuilt)
  check()
  return prepared.toEnvelope().toXDR('base64')
}
