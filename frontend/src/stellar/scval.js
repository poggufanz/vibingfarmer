// JS ⇄ ScVal codec. Every contract arg is encoded here and every return value decoded here,
// so the rest of the chain layer never hand-rolls XDR type guesses.
import { Address, nativeToScVal, scValToNative } from '@stellar/stellar-sdk'

/**
 * Encode a Stellar address (G... account or C... contract strkey) as an Address ScVal.
 * @param {string} strkey
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function addrScVal(strkey) {
  return new Address(strkey).toScVal()
}

/**
 * Encode an i128 amount. Accepts BigInt or Number (Number is coerced to BigInt — pass whole
 * base units, never fractional). Money on Soroban is always i128.
 * @param {bigint | number} amount
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function i128ScVal(amount) {
  return nativeToScVal(BigInt(amount), { type: 'i128' })
}

/**
 * Encode a u64 (period duration / expiry / ledger time). Accepts BigInt or Number.
 * @param {bigint | number} n
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function u64ScVal(n) {
  return nativeToScVal(BigInt(n), { type: 'u64' })
}

/**
 * Encode a fixed 32-byte value (e.g. a strategy hash) as ScVal::Bytes. Accepts a 0x-prefixed
 * hex string or raw bytes; rejects anything that isn't exactly 32 bytes.
 * @param {string | Buffer | Uint8Array} v
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function bytes32ScVal(v) {
  const buf = typeof v === 'string' ? Buffer.from(v.replace(/^0x/, ''), 'hex') : Buffer.from(v)
  if (buf.length !== 32) throw new Error(`bytes32 must be 32 bytes, got ${buf.length}`)
  return nativeToScVal(buf, { type: 'bytes' })
}

/**
 * Encode a string as ScVal::Symbol (provider label / topic). Caller must keep it ≤ 9 chars
 * for symbol_short! compatibility.
 * @param {string} s
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function symbolScVal(s) {
  return nativeToScVal(String(s), { type: 'symbol' })
}

/**
 * Decode any ScVal to its native JS value (i128 → BigInt, address → strkey, symbol → string…).
 * @param {import('@stellar/stellar-sdk').xdr.ScVal} sv
 * @returns {unknown}
 */
export function fromScVal(sv) {
  return scValToNative(sv)
}
