const HASH_32 = /^0x[0-9a-fA-F]{64}$/

export function requireCanonicalUserOperationHash(userOpHash, { label = 'user operation' } = {}) {
  if (!HASH_32.test(String(userOpHash || ''))) {
    throw new Error(`${label} has no canonical user operation hash`)
  }
  return userOpHash.toLowerCase()
}

export function requireSuccessfulUserOperation(receipt, { label = 'user operation' } = {}) {
  if (receipt?.success !== true) throw new Error(`${label} outer result was not successful`)
  if (receipt?.receipt?.status !== 'success') throw new Error(`${label} transaction reverted`)
  const transactionHash = receipt.receipt.transactionHash
  if (!HASH_32.test(String(transactionHash || ''))) {
    throw new Error(`${label} has no canonical transaction hash`)
  }
  return transactionHash.toLowerCase()
}
