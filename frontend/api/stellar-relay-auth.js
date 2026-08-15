import {
  Address,
  FeeBumpTransaction,
  Keypair,
  StrKey,
  TransactionBuilder,
  scValToNative,
} from '@stellar/stellar-sdk'
import { agentCapabilityFor } from './agentCapabilities.js'

export class OwnerWithdrawAuthorizationError extends Error {}

function fail(message) {
  throw new OwnerWithdrawAuthorizationError(message)
}

function invokeFacts(invocation) {
  const fn = invocation.function()
  if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') {
    fail('owner withdraw auth root must be a contract invocation')
  }
  const contractFn = fn.contractFn()
  return {
    contract: Address.fromScAddress(contractFn.contractAddress()).toString(),
    functionName: contractFn.functionName().toString(),
    args: contractFn.args().map((arg) => scValToNative(arg)),
  }
}

function operationFacts(operation) {
  if (operation?.type !== 'invokeHostFunction') fail('owner withdraw must be one host invocation')
  if (operation.source) fail('owner withdraw operation source override is forbidden')
  const hostFunction = operation.func
  if (hostFunction.switch().name !== 'hostFunctionTypeInvokeContract') {
    fail('owner withdraw operation must invoke a contract')
  }
  const contractFn = hostFunction.invokeContract()
  return {
    contract: Address.fromScAddress(contractFn.contractAddress()).toString(),
    functionName: contractFn.functionName().toString(),
    args: contractFn.args().map((arg) => scValToNative(arg)),
  }
}

function sameInvocation(a, b) {
  return (
    a.contract === b.contract &&
    a.functionName === b.functionName &&
    a.args.length === b.args.length &&
    a.args.every((arg, index) => arg === b.args[index])
  )
}

function byte(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) fail(`${label} is malformed`)
  return value
}

function normalizedAuthorization(facts, source) {
  if (!facts || typeof facts !== 'object') fail('current account authorization is unavailable')
  if (facts.account !== source) fail('current account authorization belongs to another account')
  const masterWeight = byte(facts.masterWeight, 'master signer weight')
  const mediumThreshold = byte(facts.mediumThreshold, 'medium threshold')
  if (!Array.isArray(facts.signers)) fail('current signer set is malformed')
  const signers = [{ key: source, weight: masterWeight }]
  const seen = new Set([source])
  for (const signer of facts.signers) {
    if (!signer || !StrKey.isValidEd25519PublicKey(signer.key)) {
      fail('current signer set contains a malformed ed25519 signer')
    }
    if (seen.has(signer.key)) fail('current signer set contains a duplicate signer')
    seen.add(signer.key)
    signers.push({ key: signer.key, weight: byte(signer.weight, 'signer weight') })
  }
  return { masterWeight, mediumThreshold, signers }
}

/** Decode the current ledger AccountEntry into the narrow immutable facts used by the gate. */
export function accountAuthorizationFromEntry(entry) {
  try {
    const account = StrKey.encodeEd25519PublicKey(entry.accountId().ed25519())
    const thresholds = Buffer.from(entry.thresholds())
    if (thresholds.length !== 4) fail('current account thresholds are malformed')
    const signers = []
    for (const signer of entry.signers()) {
      const key = signer.key()
      if (key.switch().name !== 'signerKeyTypeEd25519') continue
      signers.push({
        key: StrKey.encodeEd25519PublicKey(key.ed25519()),
        weight: signer.weight(),
      })
    }
    return Object.freeze({
      account,
      masterWeight: thresholds[0],
      mediumThreshold: thresholds[2],
      signers: Object.freeze(signers.map((signer) => Object.freeze(signer))),
    })
  } catch (error) {
    if (error instanceof OwnerWithdrawAuthorizationError) throw error
    fail('current account authorization entry is malformed')
  }
}

/**
 * Authenticate the inner transaction source before simulation or sponsorship. Relayer-sourced
 * inners are signed by the relay itself. Every other accepted source is a current classic
 * account whose valid, correctly hinted envelope signatures reach its medium threshold.
 */
export async function assertTransactionSourceAuthorization(
  transaction,
  { expectedRelayer, readAccountAuthorization } = {}
) {
  const source = transaction?.source
  if (!StrKey.isValidEd25519PublicKey(String(source || ''))) {
    fail('inner transaction source is not a valid classic account')
  }
  if ((transaction.operations || []).some((operation) => operation.source)) {
    fail('operation source overrides are forbidden')
  }
  if (source === expectedRelayer) return Object.freeze({ kind: 'relayer', source })
  if (typeof readAccountAuthorization !== 'function') {
    fail('current-account authorization reader is unavailable')
  }
  let current
  try {
    current = await readAccountAuthorization(source)
  } catch {
    fail('current account authorization could not be read')
  }
  const { mediumThreshold, signers } = normalizedAuthorization(current, source)
  const candidates = signers.filter((signer) => signer.weight > 0)
  const signatures = transaction.signatures || []
  if (signatures.length === 0) fail('classic source transaction signature is missing')
  const signedKeys = new Set()
  let weight = 0
  for (const decorated of signatures) {
    const hint = Buffer.from(decorated.hint?.() || [])
    const signature = Buffer.from(decorated.signature?.() || [])
    if (hint.length !== 4 || signature.length !== 64) fail('decorated signature is malformed')
    const hinted = candidates.filter((candidate) => {
      const raw = StrKey.decodeEd25519PublicKey(candidate.key)
      return raw.subarray(raw.length - 4).equals(hint)
    })
    const verified = hinted.filter((candidate) =>
      Keypair.fromPublicKey(candidate.key).verify(transaction.hash(), signature)
    )
    if (verified.length !== 1) fail('decorated signature hint/signature is invalid or stale')
    const signer = verified[0]
    if (signedKeys.has(signer.key)) fail('duplicate envelope signer does not add weight')
    signedKeys.add(signer.key)
    weight += signer.weight
  }
  if (weight < mediumThreshold) fail('classic source signatures do not meet medium threshold')
  return Object.freeze({ kind: 'classic', source, weight, mediumThreshold })
}

function assertAddressCredentials(credentials, owner, transaction, expectedRelayer, currentLedger) {
  const addressCredentials = credentials.address()
  const authorizer = Address.fromScAddress(addressCredentials.address()).toString()
  if (authorizer !== owner) fail('auth-entry authorizer does not equal the stored owner')
  if (!expectedRelayer || transaction.source !== expectedRelayer) {
    fail('sponsored owner authorization must use the configured relayer source')
  }
  const expiration = Number(addressCredentials.signatureExpirationLedger())
  if (!Number.isSafeInteger(expiration) || expiration <= Number(currentLedger)) {
    fail('owner authorization is expired')
  }
}

function scopeOwnerFacts(scope, capability) {
  if (!scope || typeof scope !== 'object') fail('scope_of returned no decodable scope')
  if (capability.scopeOfOwnerAbi === 'scope_of:owner-vault-token-v1') {
    return { owner: scope.owner, vault: scope.vault, token: scope.token }
  }
  if (capability.scopeOfOwnerAbi === 'scope_of:owner-target-token-kind-v2') {
    if (Number(scope.kind) !== 0) fail('ordinary owner withdraw requires a Deposit-kind scope')
    return { owner: scope.owner, vault: scope.target, token: scope.token }
  }
  fail('agent hash has no proven scope_of owner ABI')
}

/**
 * Parse and validate a direct agent.owner_withdraw transaction. This is an authorizer gate, not
 * a source-account shortcut: C is accepted only as an address-credential authorizer on a G
 * relayer-sourced transaction. The caller must still run enforcing simulation after all
 * signatures are attached.
 */
export async function assertOwnerWithdrawAuthorization({
  xdr,
  transaction,
  networkPassphrase,
  expectedNetworkPassphrase,
  expectedAgent,
  expectedRelayer,
  expectedToken,
  expectedVault,
  wasmHash,
  currentLedger,
  readScope,
  readAccountAuthorization,
  sourceAuthorization,
}) {
  if (!networkPassphrase || networkPassphrase !== expectedNetworkPassphrase) {
    fail('owner withdraw network does not match the configured network')
  }
  const capability = agentCapabilityFor(wasmHash, 'owner_withdraw')
  if (!capability?.scopeOfOwnerAbi) fail('agent hash has no proven direct-withdraw capability')
  if (typeof readScope !== 'function') fail('scope_of reader is unavailable')

  let parsed = transaction
  if (!parsed) {
    try {
      parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase)
    } catch {
      fail('owner withdraw XDR is malformed')
    }
  }
  if (parsed instanceof FeeBumpTransaction) fail('owner withdraw inner transaction is fee-bumped')
  if ((parsed.operations || []).length !== 1) fail('owner withdraw requires exactly one operation')

  const operation = parsed.operations[0]
  const operationCall = operationFacts(operation)
  if (operationCall.contract !== expectedAgent) fail('owner withdraw targets the wrong agent')
  if (operationCall.functionName !== 'owner_withdraw') fail('owner withdraw function mismatch')
  if (operationCall.args.length !== 1 || typeof operationCall.args[0] !== 'string') {
    fail('owner withdraw recipient argument mismatch')
  }

  const auth = operation.auth || []
  if (auth.length !== 1) fail('owner withdraw requires exactly one authorization entry')
  const entry = auth[0]
  const root = entry.rootInvocation()
  if ((root.subInvocations() || []).length !== 0) {
    fail('owner withdraw authorization must not contain sibling invocations')
  }
  const authCall = invokeFacts(root)
  if (!sameInvocation(operationCall, authCall)) {
    fail('owner withdraw auth root does not exactly match the operation')
  }

  const credentials = entry.credentials()
  let sourceProof = sourceAuthorization
  if (credentials.switch().name === 'sorobanCredentialsSourceAccount') {
    sourceProof ??= await assertTransactionSourceAuthorization(parsed, {
      expectedRelayer,
      readAccountAuthorization,
    })
    if (sourceProof.kind !== 'classic') {
      fail('source-account credentials require a fully signed owner source')
    }
  }

  const scope = await readScope(expectedAgent, capability.scopeOfOwnerAbi)
  const stored = scopeOwnerFacts(scope, capability)
  if (stored.owner !== operationCall.args[0])
    fail('owner withdraw recipient must equal stored owner')
  if (stored.token !== expectedToken) fail('agent scope token does not match the configured token')
  if (stored.vault !== expectedVault) fail('agent scope vault does not match the configured vault')
  if (scope.revoked === true) fail('agent scope is revoked')

  switch (credentials.switch().name) {
    case 'sorobanCredentialsSourceAccount':
      if (parsed.source !== stored.owner || sourceProof?.source !== stored.owner) {
        fail('source-account authorization must be sourced by owner')
      }
      break
    case 'sorobanCredentialsAddress':
      assertAddressCredentials(credentials, stored.owner, parsed, expectedRelayer, currentLedger)
      break
    default:
      fail('unsupported owner authorization credentials')
  }
  return Object.freeze({
    owner: stored.owner,
    recipient: operationCall.args[0],
    token: stored.token,
    vault: stored.vault,
    generation: capability.generation,
  })
}
