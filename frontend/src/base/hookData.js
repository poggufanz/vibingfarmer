// frontend/src/base/hookData.js
// Reverse-leg hookData: [zero x24][u32 version=0][u32 strkey-length][strkey UTF-8]. Ported
// verbatim from the PROVEN reference implementation spikes/cctp-corridor/reverse.mjs's
// `buildForwarderHookData`. A wrong version byte reverts the Stellar mint
// `Error(Contract,#7313) InvalidHookVersion` AND strands the burned USDC with no on-chain retry
// (SP0 lost 1 test USDC to exactly this — spikes/SP0-GATE.md). `assertHookData` exists so this
// mistake is structurally impossible here: withdrawBatch.js calls it before every real burn.
const HEADER_LEN = 32 // 24 zero bytes + 4-byte version + 4-byte length
const STRKEY_LEN = 56
const DECODED_STRKEY_LEN = 35
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const ALLOWED_VERSIONS = new Set([0x30, 0x10]) // G account, C contract

function decodeBase32(value) {
  if (typeof value !== 'string' || value.length !== STRKEY_LEN) {
    throw new Error(`Stellar strkey must be exactly ${STRKEY_LEN} uppercase Base32 characters`)
  }
  let accumulator = 0
  let bits = 0
  const output = []
  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character)
    if (digit < 0) throw new Error('Stellar strkey contains a noncanonical Base32 character')
    accumulator = accumulator * 32 + digit
    bits += 5
    while (bits >= 8) {
      bits -= 8
      output.push(Math.floor(accumulator / 2 ** bits) & 0xff)
      accumulator %= 2 ** bits
    }
  }
  if (bits !== 0 || output.length !== DECODED_STRKEY_LEN) {
    throw new Error('Stellar strkey does not decode to exactly 35 bytes')
  }
  return Uint8Array.from(output)
}

function crc16Xmodem(bytes) {
  let crc = 0
  for (const byte of bytes) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

export function assertStellarStrKey(strkey) {
  const decoded = decodeBase32(strkey)
  if (!ALLOWED_VERSIONS.has(decoded[0])) {
    throw new Error('Stellar strkey version must identify a G account or C contract')
  }
  const expected = crc16Xmodem(decoded.slice(0, 33))
  const actual = decoded[33] | (decoded[34] << 8)
  if (actual !== expected) throw new Error('Stellar strkey checksum is invalid')
  return strkey
}

/**
 * @param {string} strkey - Stellar G... address, as text (NOT decoded to raw bytes)
 * @returns {Uint8Array}
 */
export function buildForwarderHookData(strkey) {
  assertStellarStrKey(strkey)
  const strkeyBytes = new TextEncoder().encode(strkey)
  const buf = new Uint8Array(HEADER_LEN + strkeyBytes.length)
  const view = new DataView(buf.buffer)
  // bytes [0,24) are already zero from Uint8Array's default init
  view.setUint32(24, 0, false) // hook version = 0, big-endian
  view.setUint32(28, strkeyBytes.length, false) // recipient strkey length, big-endian
  buf.set(strkeyBytes, 32)
  return buf
}

/**
 * Validates a hookData buffer BEFORE it is ever used in a real burn call. Throws with a message
 * naming exactly what is wrong — never silently "fixes" or truncates.
 * @param {Uint8Array|Buffer} hookData
 */
export function assertHookData(hookData) {
  if (!(hookData instanceof Uint8Array)) {
    throw new Error('hookData must be a byte array')
  }
  const bytes = hookData
  if (bytes.length !== HEADER_LEN + STRKEY_LEN) {
    throw new Error(`hookData must be exactly ${HEADER_LEN + STRKEY_LEN} bytes`)
  }
  if (bytes.slice(0, 24).some((byte) => byte !== 0)) {
    throw new Error('hookData reserved header bytes must be zero')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(24, false)
  if (version !== 0) {
    throw new Error(
      `hookData version must be 0, but received ${version}. This reverts with Error(Contract,#7313) InvalidHookVersion and strands the burned USDC.`
    )
  }
  const declaredLen = view.getUint32(28, false)
  const actualLen = bytes.length - HEADER_LEN
  if (declaredLen !== STRKEY_LEN || declaredLen !== actualLen) {
    throw new Error(
      `hookData declared strkey length ${declaredLen} does not match actual ${actualLen} remaining bytes`
    )
  }
  const strkey = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(32))
  assertStellarStrKey(strkey)
  return strkey
}
