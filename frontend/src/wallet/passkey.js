// secp256r1 (P-256) curve order.
const SECP256R1_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const HALF_N = SECP256R1_N >> 1n

function bytesToBig(b) {
  return BigInt('0x' + Buffer.from(b).toString('hex'))
}
function bigTo32(n) {
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'))
}

// DER ECDSA (SEQUENCE{ INTEGER r, INTEGER s }) → 64-byte r||s. Strips leading
// 0x00 sign-padding and left-pads each integer back to 32 bytes.
export function derToRaw(der) {
  let i = 0
  if (der[i++] !== 0x30) throw new Error('bad DER: no SEQUENCE')
  i++ // total length
  if (der[i++] !== 0x02) throw new Error('bad DER: no r INTEGER')
  let rLen = der[i++]
  let r = der.slice(i, i + rLen); i += rLen
  if (der[i++] !== 0x02) throw new Error('bad DER: no s INTEGER')
  let sLen = der[i++]
  let s = der.slice(i, i + sLen)
  const pad = (x) => {
    while (x.length > 32 && x[0] === 0x00) x = x.slice(1)
    const out = new Uint8Array(32)
    out.set(x, 32 - x.length)
    return out
  }
  const raw = new Uint8Array(64)
  raw.set(pad(r), 0)
  raw.set(pad(s), 32)
  return raw
}

// Soroban / OZ webauthn-verifier requires low-S: if s > n/2, replace with n - s.
export function normalizeLowS(raw) {
  const r = raw.slice(0, 32)
  let s = bytesToBig(raw.slice(32, 64))
  if (s > HALF_N) s = SECP256R1_N - s
  const out = new Uint8Array(64)
  out.set(r, 0)
  out.set(bigTo32(s), 32)
  return out
}

function base64urlNoPad(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256(bytes) {
  // Browser path: crypto.subtle. The hash IS the challenge input — the OZ
  // webauthn-verifier checks the assertion was made over sha256(authPreimage).
  if (globalThis.crypto?.subtle) {
    const d = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return new Uint8Array(d)
  }
  // Node/test path:
  const { createHash } = await import('crypto')
  return Uint8Array.from(createHash('sha256').update(Buffer.from(bytes)).digest())
}

// Caller passes the 32-byte HashIdPreimage::SorobanAuthorization sha256 (the
// same hash VF's ed25519 path already signs). We re-hash to bind the WebAuthn
// challenge, matching the OZ verifier's expectation.
export async function buildChallenge(authPreimageHash) {
  const h = await sha256(authPreimageHash)
  return base64urlNoPad(h)
}

export function assertChallengeMatches(clientDataJSON, expectedChallenge) {
  const parsed = typeof clientDataJSON === 'string' ? JSON.parse(clientDataJSON) : clientDataJSON
  if (parsed.challenge !== expectedChallenge) {
    throw new Error(`challenge mismatch: got ${parsed.challenge}, expected ${expectedChallenge}`)
  }
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(Buffer.from(s, 'base64'))
}

// In production, the popup posts {kind, challenge, rpId} to the ceremony TAB
// (the OS prompt closes the popup); the tab calls navigator.credentials and
// posts the assertion back. `provider` defaults to navigator.credentials so the
// same function runs in the tab and in tests (injected fake).
export async function runCeremony({ kind, challenge, rpId, allowCredentials, provider }) {
  const creds = provider ?? globalThis.navigator?.credentials
  if (!creds) throw new Error('no credentials provider (run inside the ceremony tab)')
  const challengeBytes = new TextEncoder().encode(challenge)
  let assertion
  if (kind === 'get') {
    assertion = await creds.get({
      publicKey: {
        challenge: challengeBytes,
        rpId,
        allowCredentials: allowCredentials ?? [],
        userVerification: 'required',
      },
    })
  } else {
    throw new Error(`create ceremony handled by SAK.createWallet, not runCeremony`)
  }
  const r = assertion.response
  const rawSig = normalizeLowS(derToRaw(new Uint8Array(r.signature)))
  return {
    authenticatorData: new Uint8Array(r.authenticatorData),
    clientDataJSON: new TextDecoder().decode(r.clientDataJSON),
    signature: rawSig,
  }
}

// Layout the OZ webauthn-verifier expects for sig_data: authenticatorData +
// clientDataJSON + the 64-byte low-S signature. Exact field packing is verified
// on-chain in Task 8; keep this the single place that assembles it.
export function assembleSecp256r1Signature({ authenticatorData, clientDataJSON, signature }) {
  return { authenticatorData, clientDataJSON: new TextEncoder().encode(clientDataJSON), signature }
}
