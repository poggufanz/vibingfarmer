// frontend/src/base/hookData.js
// Reverse-leg hookData: [zero x24][u32 version=0][u32 strkey-length][strkey UTF-8]. Ported
// verbatim from the PROVEN reference implementation spikes/cctp-corridor/reverse.mjs's
// `buildForwarderHookData`. A wrong version byte reverts the Stellar mint
// `Error(Contract,#7313) InvalidHookVersion` AND strands the burned USDC with no on-chain retry
// (SP0 lost 1 test USDC to exactly this — spikes/SP0-GATE.md). `assertHookData` exists so this
// mistake is structurally impossible here: withdrawBatch.js calls it before every real burn.
const HEADER_LEN = 32 // 24 zero bytes + 4-byte version + 4-byte length

/**
 * @param {string} strkey - Stellar G... address, as text (NOT decoded to raw bytes)
 * @returns {Uint8Array}
 */
export function buildForwarderHookData(strkey) {
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
  const bytes = hookData instanceof Uint8Array ? hookData : new Uint8Array(hookData)
  if (bytes.length < HEADER_LEN) {
    throw new Error(
      `hookData too short: expected at least ${HEADER_LEN} bytes, got ${bytes.length}`
    )
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
  if (declaredLen !== actualLen) {
    throw new Error(
      `hookData declared strkey length ${declaredLen} does not match actual ${actualLen} remaining bytes`
    )
  }
  const strkey = new TextDecoder().decode(bytes.slice(32))
  if (!/^[A-Z2-7]{2,}$/.test(strkey) || strkey.length < 56) {
    throw new Error(`hookData payload does not decode as a plausible Stellar strkey: "${strkey}"`)
  }
}
