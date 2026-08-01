// Authenticated transport for the execution-receipt challenge -> sign -> write handshake against
// the already-live server contract in frontend/api/agent-index/executionReceipts.js (Task 3).
// This module owns nothing about the wire shape -- every endpoint, field name, and byte format
// below is the server's contract, confirmed by reading executionReceipts.js, models.js, handler.js,
// and agent-index.js end to end, not invented here.
//
// The security property this module upholds: authorization is proven by possession of the
// ed25519 private key CURRENTLY registered on-chain as the agent's signer, over a single-use
// expiring challenge, verified by the server against a FRESHLY re-read on-chain key (never a
// cached snapshot -- executionReceipts.js:250-252). This module signs with `sessionKey.sign`
// only. It never reads `sessionKey.secret`, and never places it in the request body, query
// string, or headers of this receipt-evidence exchange. That is narrower than "never persisted
// anywhere": `sessionKey.secret` IS deliberately persisted to localStorage elsewhere in this repo
// (orchestrator.js's saveCachedAgent call sites, via agentCache.js) for agent reuse across runs --
// a separate, accepted, at-rest risk this module's wire guarantee does not speak to.
//
// canonicalJson/receiptRequestDigest/receiptProofMessage are MIRRORED here, not imported, because:
//   1. The server's receiptRequestDigest (executionReceipts.js:77-84) hashes via node:crypto's
//      createHash, which is not available to a browser bundle without a polyfill this project does
//      not carry -- a browser-safe digest has to be reimplemented regardless of the JSON step.
//   2. This repo's existing dependency direction is api/ -> src/ (e.g. handler.js imports
//      agentCreatorManifest.js from src/stellar/, never the reverse); importing an api/ module into
//      src/ production code would invert that convention.
// The sha256 primitive below reuses `@stellar/stellar-sdk`'s `hash()` -- the same synchronous,
// browser-safe sha256 already used elsewhere in src/ (see attestation.js) -- confirmed byte-
// identical to node:crypto's sha256 for the same input. The canonicalize/digest/proof-message
// mirrors are pinned byte-for-byte against the server's real receiptRequestDigest/
// receiptProofMessage in agentIndexReceiptClient.test.js (imported there, not here), across
// fixtures with nested objects, arrays, unicode, and non-default key order.
//
// canonicalJson's mirror also reproduces models.js:114-124's assertNoSensitiveProperties guard
// (same key-name check, same WeakSet circular-reference check) so a caller-supplied body carrying
// a secret/private/session-key-named field is rejected client-side, before this module ever calls
// fetch -- not merely relying on the server running the identical guard after the request has
// already been serialized and sent (executionReceipts.js:79,203). It deliberately does NOT mirror
// assertExactUnits (models.js:126-140): that is a data-shape validation over Chunk A's receipt/
// attempt content, not a transport-security guard, and the server enforces it unconditionally
// regardless of what this client does.
//
// Read-path note: a GET receipt-read client is deliberately not implemented here. This module's
// job is posting evidence, not reading it back; a read-side client (mirroring agentIndexClient.js's
// existing GET-only pattern) is a separate concern outside postReceiptEvidence's contract.
import { hash } from '@stellar/stellar-sdk'
// Explicit import rather than the ambient `Buffer` global src/main.jsx installs at bootstrap
// (same package main.jsx itself imports from) -- this module has no other reason to depend on
// app bootstrap order, and eslint.config.js's Buffer-global allowlist is an explicit per-file list
// this new file is out of scope to add itself to.
import { Buffer } from 'buffer'

const AGENT_INDEX_PATH = '/api/agent-index'
// executionReceipts.js:12 -- the exact domain-separation prefix the server signs/verifies against.
const PROOF_PREFIX = 'vf-agent-index/receipt-proof/v1'

/**
 * The single failure type this module throws. `code` is a stable, caller-facing classification
 * derived only from what the server's (status, body) pair actually distinguishes -- never a finer
 * split than the wire itself carries. See postReceiptEvidence's docblock for the full code table;
 * in particular 'proof-rejected' covers BOTH an invalid signature and an expired challenge, because
 * the server intentionally reports both identically (handler.js:56-58) and this client cannot
 * un-collapse a distinction the server does not expose.
 */
export class ReceiptEvidenceError extends Error {
  constructor(message, { step, status = null, code, body = null, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = 'ReceiptEvidenceError'
    this.step = step // 'challenge' | 'write'
    this.status = status // HTTP status, or null for a transport-level (network) failure
    this.code = code
    this.body = body // raw parsed server response body, when one was received
  }
}

// --- canonicalJson mirror (api/agent-index/models.js:142-160) --------------------------------
// Same canonicalization semantics: recursively sort object keys, pass through null/string/
// boolean, reject non-finite numbers and unsupported value types, recurse arrays in place. See
// the file header for what is and isn't mirrored and why.
function canonicalize(entry) {
  if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry
  if (typeof entry === 'number') {
    if (!Number.isFinite(entry)) throw new Error('non-finite numbers are not serializable')
    return entry
  }
  if (Array.isArray(entry)) return entry.map(canonicalize)
  if (!entry || typeof entry !== 'object') throw new Error('unsupported JSON value')
  return Object.fromEntries(
    Object.keys(entry)
      .sort()
      .map((key) => [key, canonicalize(entry[key])])
  )
}

// Mirrors models.js:100-109's sensitiveKey exactly: same normalization, same three substrings.
function sensitiveKey(key) {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return (
    normalized.includes('secret') ||
    normalized.includes('private') ||
    normalized.includes('sessionkey')
  )
}

// Mirrors models.js:114-124's assertNoSensitiveProperties exactly: same recursive key-name walk,
// same WeakSet cycle guard (so circular input throws a clear Error here instead of a bare
// RangeError from unbounded recursion).
function assertNoSensitiveProperties(value, path = '$', seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return
  if (seen.has(value)) throw new Error(`circular data is not serializable at ${path}`)
  seen.add(value)
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKey(key)) {
      throw new Error(`secret/private/session-key property rejected at ${path}.${key}`)
    }
    assertNoSensitiveProperties(entry, `${path}.${key}`, seen)
  }
  seen.delete(value)
}

function canonicalJson(value) {
  assertNoSensitiveProperties(value)
  return JSON.stringify(canonicalize(value))
}

/** Mirrors executionReceipts.js:77-84's receiptRequestDigest = sha256(canonicalJson(body)),
 * hex-encoded. Pinned against the real server function in the test file. */
function computeRequestDigest(body) {
  const digestBytes = hash(Buffer.from(canonicalJson(body), 'utf8'))
  return Buffer.from(digestBytes).toString('hex')
}

/** Mirrors executionReceipts.js:96-113's receiptProofMessage -- the exact '|'-joined byte string
 * both the client signs and the server verifies against. Field order and separator are
 * load-bearing: changing either produces a signature the server will reject. */
function computeProofMessage({ networkId, owner, agent, challengeId, expiresAt, requestDigest }) {
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

/** Classifies a failed (status, body) pair into a stable code, using only distinctions the wire
 * itself makes (see handler.js's agentIndexFailure + handleReceiptChallenge/handleReceiptWrite). */
function classifyFailure(step, status, errorText) {
  if (step === 'challenge') {
    if (status === 400) return 'invalid-request'
    if (status === 403) return 'authority-mismatch'
    if (status === 503) return 'unavailable'
    return 'server-error'
  }
  if (status === 400) return 'invalid-mutation'
  if (status === 401) return 'proof-rejected'
  if (status === 403) return 'authority-mismatch'
  if (status === 409) {
    return errorText === 'Receipt proof was already used'
      ? 'challenge-consumed'
      : 'version-conflict'
  }
  if (status === 503) return 'unavailable'
  return 'server-error'
}

async function postJson({ apiBase, action, step, payload, fetchImpl }) {
  let res
  try {
    res = await fetchImpl(`${apiBase}${AGENT_INDEX_PATH}?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (cause) {
    throw new ReceiptEvidenceError(`Receipt ${step} request could not reach the server`, {
      step,
      code: 'network-error',
      cause,
    })
  }
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null // a non-JSON body must not be guessed at -- the ok-checks below still fail closed
  }
  return { res, body }
}

function requireField(value, message) {
  if (!value)
    throw new ReceiptEvidenceError(message, { step: 'challenge', code: 'invalid-request' })
}

/**
 * Perform the full challenge -> sign -> write exchange for one execution-receipt mutation.
 *
 * Step 1 (executionReceipts.js:77-84): digest `body` exactly as the server will reproduce it --
 *   sha256(canonicalJson(body)) -- so the challenge requested in step 2 is bound to the exact
 *   bytes step 4 posts.
 * Step 2 (executionReceipts.js:115-145, handler.js:111-143): POST {networkId, owner, agent,
 *   requestDigest} to `?action=receipt-challenge`. The server reads CURRENT on-chain authority and
 *   only issues a challenge if it matches `owner`.
 * Step 3 (executionReceipts.js:96-113,147-162): sign the '|'-joined receiptProofMessage string
 *   with `sessionKey.sign` -- never `sessionKey.secret` -- and base64url-encode the 64-byte
 *   signature (confirmed by reading verifySignature's `Buffer.from(proof.signature, 'base64url')`
 *   at executionReceipts.js:153; this is not assumed, it is read from source).
 * Step 4 (executionReceipts.js:194-268, handler.js:145-180, api/agent-index.js:269-274): POST
 *   {mutation: body, proof: {challengeId, expiresAt, signature}} to `?action=receipt-write`. The
 *   literal top-level key is `mutation` (api/agent-index.js:270: `body: req.body?.mutation`) --
 *   not `body`, which is only the internal parameter name handleReceiptWrite destructures it into.
 *   The server re-reads on-chain authority FRESH here, never reusing step 2's snapshot
 *   (executionReceipts.js:250).
 *
 * On failure this throws ReceiptEvidenceError. `code` distinguishes, as far as the wire itself
 * distinguishes:
 *   'version-conflict'   - optimistic-concurrency loss (stale expectedVersion), HTTP 409
 *   'challenge-consumed' - the same challenge/proof was already used (replay), HTTP 409
 *   'proof-rejected'     - invalid signature OR expired challenge, HTTP 401 (the server reports
 *                          both identically -- see the class docblock)
 *   'authority-mismatch' - on-chain routerOwner/scope.owner no longer match `owner`, HTTP 403
 *   'invalid-request' / 'invalid-mutation' - malformed input, HTTP 400
 *   'unavailable'         - store or on-chain authority reader not configured, HTTP 503
 *   'network-error'       - the fetch itself failed (offline, DNS, CORS, ...)
 *   'server-error'        - anything else, including a 200/201 response whose body.ok !== true
 *
 * This function never reports a write as succeeded on HTTP acceptance alone: both steps require
 * the server's own `body.ok === true` in addition to a 2xx status, since an HTTP 200 is not by
 * itself the server's word that the mutation committed.
 *
 * @param {{
 *   activeAccount: string,
 *   agentAddress: string,
 *   sessionKey: {sign: (payload: Uint8Array) => Uint8Array, publicKey: string},
 *   body: {expectedVersion: number, receipt: object, attempt: object},
 *   fetchImpl?: typeof fetch,
 *   apiBase?: string,
 * }} params
 * @returns {Promise<{requestDigest: string, challengeId: string, expiresAt: number, written: number, duplicates: number, version: number}>}
 */
export async function postReceiptEvidence({
  activeAccount,
  agentAddress,
  sessionKey,
  body,
  fetchImpl = fetch,
  apiBase = '',
}) {
  requireField(activeAccount, 'activeAccount is required')
  requireField(agentAddress, 'agentAddress is required')
  if (typeof sessionKey?.sign !== 'function') {
    throw new ReceiptEvidenceError('sessionKey.sign is required', {
      step: 'challenge',
      code: 'invalid-request',
    })
  }
  const networkId = body?.receipt?.networkId
  requireField(networkId, 'body.receipt.networkId is required')
  if (body.receipt.owner !== activeAccount) {
    throw new ReceiptEvidenceError('body.receipt.owner must match activeAccount', {
      step: 'challenge',
      code: 'invalid-request',
    })
  }
  if (body.receipt.agent !== agentAddress) {
    throw new ReceiptEvidenceError('body.receipt.agent must match agentAddress', {
      step: 'challenge',
      code: 'invalid-request',
    })
  }

  let requestDigest
  try {
    requestDigest = computeRequestDigest(body)
  } catch (cause) {
    // Most commonly assertNoSensitiveProperties rejecting a secret/private/session-key-named
    // field, or a circular/non-finite-number body -- fails here, before any fetch, not after.
    throw new ReceiptEvidenceError(cause.message, {
      step: 'challenge',
      code: 'invalid-request',
      cause,
    })
  }

  const { res: challengeRes, body: challengeBody } = await postJson({
    apiBase,
    action: 'receipt-challenge',
    step: 'challenge',
    payload: { networkId, owner: activeAccount, agent: agentAddress, requestDigest },
    fetchImpl,
  })
  if (!challengeRes.ok || challengeBody?.ok !== true || !challengeBody?.challenge) {
    throw new ReceiptEvidenceError(
      challengeBody?.error || `Receipt challenge request failed (HTTP ${challengeRes.status})`,
      {
        step: 'challenge',
        status: challengeRes.status,
        code: classifyFailure('challenge', challengeRes.status, challengeBody?.error),
        body: challengeBody,
      }
    )
  }
  const challenge = challengeBody.challenge

  // Step 3: sign the challenge -- never the secret. sessionKey.sign is a closure over the
  // Keypair (sessionKey.js:25); `.secret` is never referenced anywhere in this module.
  const proofMessage = computeProofMessage({
    networkId,
    owner: activeAccount,
    agent: agentAddress,
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    requestDigest,
  })
  const signatureBytes = sessionKey.sign(Buffer.from(proofMessage, 'utf8'))
  const signature = Buffer.from(signatureBytes).toString('base64url')

  const { res: writeRes, body: writeBody } = await postJson({
    apiBase,
    action: 'receipt-write',
    step: 'write',
    payload: {
      mutation: body,
      proof: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, signature },
    },
    fetchImpl,
  })
  if (!writeRes.ok || writeBody?.ok !== true) {
    throw new ReceiptEvidenceError(
      writeBody?.error || `Receipt write failed (HTTP ${writeRes.status})`,
      {
        step: 'write',
        status: writeRes.status,
        code: classifyFailure('write', writeRes.status, writeBody?.error),
        body: writeBody,
      }
    )
  }

  return {
    requestDigest,
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    written: writeBody.written,
    duplicates: writeBody.duplicates,
    version: writeBody.version,
  }
}
