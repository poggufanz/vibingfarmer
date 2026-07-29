// Pure decode helpers for the approve page's sign screen: turn a raw tx envelope / Soroban auth
// entry into { network, contract, contractLabel, fn, args } for display. Bundled into the
// approve.html entry (this file may import; the classic scripts background/provider* may not).
// Decode failure returns null — the approval screen then falls back to raw XDR; a decoder bug
// must never block the consent gate.
import { Address, TransactionBuilder, hash, scValToNative, xdr } from '@stellar/stellar-sdk'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_VAULT_ADDRESS,
  STELLAR_NETWORK_LABEL,
} from '../src/stellar/config.js'
import { decodeFundingRouterGrant } from './grantDecoder.js'

const CONTRACT_LABELS = {
  [SOROBAN_FUNDING_ROUTER_ADDRESS]: 'funding router',
  [SOROBAN_AUTOFARM_VAULT_ADDRESS]: 'autofarm vault',
  [SOROBAN_TOKEN_ADDRESS]: 'USDC token',
  [SOROBAN_VAULT_ADDRESS]: 'legacy vault',
}

export function labelForContract(contractId) {
  return CONTRACT_LABELS[contractId] ?? null
}

export function shortAddr(s) {
  if (!s) return ''
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s
}

export function formatArg(v) {
  if (typeof v === 'bigint') return `${v} (${Number(v) / 1e7})` // 7dp hint; raw stays authoritative
  if (typeof v === 'string') return /^[CG][A-Z2-7]{55}$/.test(v) ? shortAddr(v) : v
  if (v === null || v === undefined) return 'void'
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)).slice(0, 80)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

function digestParts(parts) {
  return hash(new TextEncoder().encode(JSON.stringify(parts))).toString('hex')
}

function authorizationDigests(op) {
  return (op?.auth ?? []).map((entry) => hash(entry.toXDR()).toString('hex'))
}

function sameScVals(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value.toXDR().equals(right[index].toXDR()))
  )
}

function verifiedOperationAuthorizer(op, invocation, txSource) {
  const entries = op?.auth ?? []
  if (entries.length !== 1) return null
  const entry = entries[0]
  const root = entry.rootInvocation()
  const fn = root.function()
  if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') return null
  const rootFn = fn.contractFn()
  if (
    !rootFn.contractAddress().toXDR().equals(invocation.contractAddress().toXDR()) ||
    rootFn.functionName().toString() !== invocation.functionName().toString() ||
    !sameScVals(rootFn.args(), invocation.args())
  ) {
    return null
  }
  const credentials = entry.credentials()
  if (credentials.switch().name === 'sorobanCredentialsSourceAccount') return txSource || null
  if (credentials.switch().name === 'sorobanCredentialsAddress') {
    return Address.fromScAddress(credentials.address().address()).toString()
  }
  return null
}

function consentOwnership(invocation, authorizer) {
  const fn = invocation.functionName().toString()
  const args = invocation.args().map((arg) => scValToNative(arg))
  if (fn === 'owner_withdraw') {
    const recipient = args[0]
    return {
      owner: authorizer && recipient === authorizer ? authorizer : null,
      token: SOROBAN_TOKEN_ADDRESS,
      recipient,
      allFunds: true,
    }
  }
  if (fn === 'sweep') {
    const owner = args[0]
    const recipient = args[2]
    return {
      owner: authorizer && owner === authorizer && recipient === owner ? authorizer : null,
      token: SOROBAN_TOKEN_ADDRESS,
      recipient,
      allFunds: true,
    }
  }
  if (fn === 'grant') {
    return { owner: authorizer && args[0] === authorizer ? authorizer : null }
  }
  return { owner: authorizer }
}

function summarizeInvokeArgs(inv, exact = {}) {
  const contract = Address.fromScAddress(inv.contractAddress()).toString()
  const fn = inv.functionName().toString()
  const rawArgs = inv.args()
  const nativeArgs = rawArgs.map((arg) => scValToNative(arg))
  // Always attempted, never fabricated: decodeFundingRouterGrant itself fails closed to
  // kind:'unknown' for anything that isn't a pinned router schema, so this is safe on every
  // invocation — only a real funding_router.grant call ever surfaces a `grant` summary.
  const grant = decodeFundingRouterGrant({ contractId: contract, functionName: fn, args: rawArgs })
  return {
    network: STELLAR_NETWORK_LABEL,
    networkPassphrase: exact.networkPassphrase ?? NETWORK_PASSPHRASE,
    contract,
    contractLabel: labelForContract(contract),
    fn,
    args: nativeArgs.map((a) => formatArg(a)),
    grant: grant.kind === 'unknown' ? null : grant,
    owner: Object.hasOwn(exact, 'owner') ? exact.owner : fn === 'grant' ? nativeArgs[0] : null,
    token: Object.hasOwn(exact, 'token')
      ? exact.token
      : fn === 'owner_withdraw' || fn === 'sweep'
        ? SOROBAN_TOKEN_ADDRESS
        : null,
    recipient:
      exact.recipient ??
      (fn === 'owner_withdraw' ? nativeArgs[0] : fn === 'sweep' ? nativeArgs[2] : null),
    bodyDigest: exact.bodyDigest ?? null,
    authDigest: exact.authDigest ?? null,
    authorizationDigests: exact.authorizationDigests ?? [],
    consentDigest: exact.consentDigest ?? null,
    allFunds: exact.allFunds ?? (fn === 'owner_withdraw' || fn === 'sweep'),
  }
}

/**
 * @param {string} xdrB64 unsigned transaction envelope
 * @returns {{network:string,contract:string|null,contractLabel:string|null,fn:string|null,args:string[],signer:string|null}|null}
 */
export function summarizeTransaction(xdrB64, passphrase = NETWORK_PASSPHRASE) {
  try {
    const parsed = TransactionBuilder.fromXDR(xdrB64, passphrase)
    const tx = parsed.innerTransaction ?? parsed // fee-bump envelopes wrap the real tx
    const op = tx.operations?.[0]
    if (
      op?.type === 'invokeHostFunction' &&
      op.func.switch().name === 'hostFunctionTypeInvokeContract'
    ) {
      const bodyDigest = tx.hash().toString('hex')
      const authDigests = authorizationDigests(op)
      const authDigest =
        authDigests.length === 0
          ? null
          : authDigests.length === 1
            ? authDigests[0]
            : digestParts(authDigests)
      const invocation = op.func.invokeContract()
      const authorizer = verifiedOperationAuthorizer(op, invocation, tx.source)
      const ownership = consentOwnership(invocation, authorizer)
      return {
        ...summarizeInvokeArgs(invocation, {
          networkPassphrase: passphrase,
          ...ownership,
          bodyDigest,
          authDigest,
          authorizationDigests: authDigests,
          consentDigest: digestParts([passphrase, bodyDigest, ...authDigests]),
        }),
        signer: null,
      }
    }
    // Non-Soroban fallback: still give the user the op types rather than nothing.
    return {
      network: STELLAR_NETWORK_LABEL,
      contract: null,
      contractLabel: null,
      fn: (tx.operations ?? []).map((o) => o.type).join(', ') || null,
      args: [],
      signer: null,
      grant: null,
      networkPassphrase: passphrase,
      owner: tx.source || null,
      token: null,
      recipient: null,
      bodyDigest: tx.hash().toString('hex'),
      authDigest: null,
      authorizationDigests: [],
      consentDigest: digestParts([passphrase, tx.hash().toString('hex')]),
      allFunds: false,
    }
  } catch {
    return null
  }
}

/**
 * @param {string} authEntryB64 SorobanAuthorizationEntry XDR
 * @returns same shape as summarizeTransaction, signer = the address whose auth is required
 */
export function summarizeAuthEntry(authEntryB64) {
  try {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryB64, 'base64')
    const fn = entry.rootInvocation().function()
    if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') return null
    let signer = null
    if (entry.credentials().switch().name === 'sorobanCredentialsAddress') {
      signer = Address.fromScAddress(entry.credentials().address().address()).toString()
    }
    const authDigest = hash(entry.toXDR()).toString('hex')
    const ownership = consentOwnership(fn.contractFn(), signer)
    return {
      ...summarizeInvokeArgs(fn.contractFn(), {
        ...ownership,
        authDigest,
        authorizationDigests: [authDigest],
        consentDigest: authDigest,
      }),
      signer,
    }
  } catch {
    return null
  }
}
