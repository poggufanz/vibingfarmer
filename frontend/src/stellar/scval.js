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
 * Decode any ScVal to its native JS value (i128 → BigInt, address → strkey, symbol → string…).
 * @param {import('@stellar/stellar-sdk').xdr.ScVal} sv
 * @returns {unknown}
 */
export function fromScVal(sv) {
  return scValToNative(sv)
}
