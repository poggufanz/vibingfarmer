// Pure decode helpers for the approve page's sign screen: turn a raw tx envelope / Soroban auth
// entry into { network, contract, contractLabel, fn, args } for display. Bundled into the
// approve.html entry (this file may import; the classic scripts background/provider* may not).
// Decode failure returns null — the approval screen then falls back to raw XDR; a decoder bug
// must never block the consent gate.
import { Address, TransactionBuilder, scValToNative, xdr } from '@stellar/stellar-sdk'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_VAULT_ADDRESS,
  STELLAR_NETWORK_LABEL,
} from '../src/stellar/config.js'

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

function summarizeInvokeArgs(inv) {
  const contract = Address.fromScAddress(inv.contractAddress()).toString()
  return {
    network: STELLAR_NETWORK_LABEL,
    contract,
    contractLabel: labelForContract(contract),
    fn: inv.functionName().toString(),
    args: inv.args().map((a) => formatArg(scValToNative(a))),
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
      return { ...summarizeInvokeArgs(op.func.invokeContract()), signer: null }
    }
    // Non-Soroban fallback: still give the user the op types rather than nothing.
    return {
      network: STELLAR_NETWORK_LABEL,
      contract: null,
      contractLabel: null,
      fn: (tx.operations ?? []).map((o) => o.type).join(', ') || null,
      args: [],
      signer: null,
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
    return { ...summarizeInvokeArgs(fn.contractFn()), signer }
  } catch {
    return null
  }
}
