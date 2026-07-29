import {
  Address,
  FeeBumpTransaction,
  Keypair,
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

function assertFullSignedSource(transaction, owner) {
  if (!owner.startsWith('G')) fail('a contract owner can never be a classic transaction source')
  if (transaction.source !== owner) fail('source-account authorization must be sourced by owner')
  let keypair
  try {
    keypair = Keypair.fromPublicKey(owner)
  } catch {
    fail('stored owner is not a valid classic account')
  }
  const signed = (transaction.signatures || []).some((decorated) =>
    keypair.verify(transaction.hash(), decorated.signature())
  )
  if (!signed) fail('owner transaction signature is missing or for the wrong network/body')
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

  const scope = await readScope(expectedAgent, capability.scopeOfOwnerAbi)
  const stored = scopeOwnerFacts(scope, capability)
  if (stored.owner !== operationCall.args[0])
    fail('owner withdraw recipient must equal stored owner')
  if (stored.token !== expectedToken) fail('agent scope token does not match the configured token')
  if (stored.vault !== expectedVault) fail('agent scope vault does not match the configured vault')
  if (scope.revoked === true) fail('agent scope is revoked')

  const credentials = entry.credentials()
  switch (credentials.switch().name) {
    case 'sorobanCredentialsSourceAccount':
      assertFullSignedSource(parsed, stored.owner)
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
