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
