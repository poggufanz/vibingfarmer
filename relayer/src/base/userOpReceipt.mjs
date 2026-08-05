const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function requireCanonicalUserOperationHash(userOpHash, { label = 'user operation' } = {}) {
  if (!TX_HASH.test(String(userOpHash || ''))) {
    throw new Error(`${label} has no canonical user operation hash`);
  }
  return userOpHash;
}

export function requireSuccessfulUserOperation(receipt, { label = 'user operation' } = {}) {
  if (receipt?.success !== true) throw new Error(`${label} outer result was not successful`);
  if (receipt?.receipt?.status !== 'success') throw new Error(`${label} transaction reverted`);
  const txHash = receipt.receipt.transactionHash;
  if (!TX_HASH.test(String(txHash || ''))) throw new Error(`${label} has no canonical transaction hash`);
  return txHash;
}
