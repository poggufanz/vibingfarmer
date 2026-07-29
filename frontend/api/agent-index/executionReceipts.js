import { createHash, randomUUID } from 'node:crypto'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import {
  assertNoSensitiveProperties,
  canonicalJson,
  toExecutionReceiptRow,
  toPhaseAttemptRow,
} from './models.js'

const PROOF_PREFIX = 'vf-agent-index/receipt-proof/v1'
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60_000
const SUPPORTED_NETWORKS = new Set(['stellar-testnet'])

export class ReceiptAuthError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReceiptAuthError'
    this.code = code
  }
}

function authError(code, message) {
  throw new ReceiptAuthError(code, message)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validOwner(address) {
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address)
}

function assertIdentity({ networkId, owner, agent, requestDigest }) {
  if (!SUPPORTED_NETWORKS.has(networkId)) authError('invalid', 'Unsupported receipt network')
  if (!validOwner(owner)) authError('invalid', 'Invalid receipt owner address')
  if (!StrKey.isValidContract(agent)) authError('invalid', 'Invalid receipt agent address')
  if (!/^[0-9a-f]{64}$/i.test(requestDigest ?? '')) {
    authError('invalid', 'Invalid receipt request digest')
  }
}

function signerPublicKey(value) {
  if (typeof value === 'string' && StrKey.isValidEd25519PublicKey(value)) return value
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const raw = Buffer.from(value)
    if (raw.length === 32) return StrKey.encodeEd25519PublicKey(raw)
  }
  authError('authority', 'Agent signer authority is invalid')
}

function validateAuthority({ facts, owner }) {
  if (!facts || typeof facts !== 'object') authError('authority', 'Agent authority is unavailable')
  if (facts.routerOwner !== owner) authError('authority', 'Router owner authority mismatch')
  if (facts.scope?.owner !== owner) authError('authority', 'Scope owner authority mismatch')
  return { ...facts, signerPublicKey: signerPublicKey(facts.signer) }
}

export function receiptRequestDigest(body) {
  assertNoSensitiveProperties(body)
  return sha256(canonicalJson(body))
}

export function receiptIntentDigest(intent) {
  assertNoSensitiveProperties(intent)
  return sha256(canonicalJson(intent))
}

/** The byte string signed by both G-owned and C-owned agent session keys. */
export function receiptProofMessage({
  networkId,
  owner,
  agent,
  challengeId,
  expiresAt,
  requestDigest,
}) {
  return [
    PROOF_PREFIX,
    networkId,
    owner,
    agent,
    challengeId,
    String(expiresAt),
    requestDigest,
  ].join('|')
}

export async function issueReceiptChallenge({
  request,
  store,
  authorityReader,
  now = Date.now(),
  ttlMs = DEFAULT_CHALLENGE_TTL_MS,
  challengeId = randomUUID(),
}) {
  const { networkId, owner, agent, requestDigest } = request ?? {}
  assertIdentity({ networkId, owner, agent, requestDigest })
  if (!store?.issueReceiptChallenge) authError('unavailable', 'Receipt store is unavailable')
  if (typeof authorityReader !== 'function')
    authError('misconfigured', 'Authority reader unavailable')
  if (!Number.isInteger(now) || !Number.isInteger(ttlMs) || ttlMs <= 0) {
    authError('invalid', 'Challenge time is invalid')
  }
  const facts = await authorityReader({ networkId, owner, agent })
  validateAuthority({ facts, owner })
  const challenge = {
    networkId,
    owner,
    agent,
    challengeId,
    expiresAt: now + ttlMs,
    requestDigest,
    createdAt: now,
  }
  await store.issueReceiptChallenge(challenge)
  return challenge
}

function verifySignature({ challenge, proof, publicKey }) {
  if (proof?.expiresAt !== challenge.expiresAt) {
    authError('proof', 'Challenge expiry does not match the signed proof')
  }
  let signature
  try {
    signature = Buffer.from(proof.signature, 'base64url')
  } catch {
    authError('proof', 'Receipt proof signature is malformed')
  }
  if (signature.length !== 64) authError('proof', 'Receipt proof signature is malformed')
  const message = Buffer.from(receiptProofMessage(challenge), 'utf8')
  if (!Keypair.fromPublicKey(publicKey).verify(message, signature)) {
    authError('proof', 'Receipt proof signature does not match the current agent signer')
  }
}

function reconciliationAttempt({ receipt, attempt, authority, now }) {
  const revoked = authority.scope?.revoked === true
  if (!revoked) return attempt
  if (attempt.kind !== 'revoked-scope-reconciliation') {
    authError('authority', 'Revoked scope requires evidence-bearing reconciliation')
  }
  if (
    receipt.custody?.confirmed !== true ||
    attempt.evidence?.custodyRead?.confirmed !== true ||
    !Number.isInteger(authority.scopeLedger)
  ) {
    authError('authority', 'Revoked-scope reconciliation evidence is incomplete')
  }
  return {
    ...attempt,
    evidence: {
      ...attempt.evidence,
      authority: {
        source: 'on-chain-router-and-agent',
        routerOwner: authority.routerOwner,
        scopeOwner: authority.scope.owner,
        signer: authority.signerPublicKey,
        revoked: true,
        scopeLedger: authority.scopeLedger,
        checkedAt: now,
      },
    },
  }
}

export async function applyAuthenticatedReceiptMutation({
  body,
  proof,
  store,
  authorityReader,
  now = Date.now(),
  consumeToken = randomUUID(),
}) {
  assertNoSensitiveProperties(body)
  if (!store?.readReceiptChallenge || !store?.commitAuthenticatedReceiptMutation) {
    authError('unavailable', 'Receipt store is unavailable')
  }
  if (typeof authorityReader !== 'function')
    authError('misconfigured', 'Authority reader unavailable')
  if (!Number.isInteger(body?.expectedVersion) || body.expectedVersion < 0) {
    authError('invalid', 'expectedVersion must be a non-negative integer')
  }
  const intentDigest = receiptIntentDigest(body?.receipt?.intent)
  toExecutionReceiptRow(body?.receipt, intentDigest)
  toPhaseAttemptRow(body?.attempt)
  const networkId = body.receipt.networkId
  const owner = body.receipt.owner
  const agent = body.receipt.agent
  assertIdentity({ networkId, owner, agent, requestDigest: receiptRequestDigest(body) })
  if (body.receipt.phases?.[body.attempt.phase] !== body.attempt.status) {
    authError('invalid', 'Attempt status must match the receipt phase projection')
  }

  const challenge = await store.readReceiptChallenge({ challengeId: proof?.challengeId })
  if (!challenge) authError('proof', 'Receipt proof challenge does not exist')
  if (challenge.consumedAt != null)
    authError('replay', 'Receipt proof challenge was already consumed')
  if (now >= challenge.expiresAt) authError('expired', 'Receipt proof challenge expired')
  const digest = receiptRequestDigest(body)
  if (
    challenge.networkId !== networkId ||
    challenge.owner !== owner ||
    challenge.agent !== agent ||
    challenge.requestDigest !== digest
  ) {
    authError('proof', 'Receipt proof challenge identity or request digest mismatch')
  }

  const facts = await authorityReader({ networkId, owner, agent })
  const currentAuthority = validateAuthority({ facts, owner })
  verifySignature({ challenge, proof, publicKey: currentAuthority.signerPublicKey })
  const attempt = reconciliationAttempt({
    receipt: body.receipt,
    attempt: body.attempt,
    authority: currentAuthority,
    now,
  })
  return store.commitAuthenticatedReceiptMutation({
    challenge,
    consumeToken,
    now,
    expectedVersion: body.expectedVersion,
    receipt: body.receipt,
    intentDigest,
    attempt,
  })
}
