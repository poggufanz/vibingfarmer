/**
 * WebAuthn PRF → secp256k1 Ethereum private key derivation.
 *
 * Derives a valid secp256k1 private key from a WebAuthn PRF output using HKDF-SHA-256.
 * Iterates a counter byte in the HKDF `info` parameter until a valid key is found
 * (within the curve order and non-zero). With uniform 256-bit output the probability
 * of needing more than one iteration is ~2^-128; the loop exists for correctness.
 *
 * This file is browser-safe and uses only the Web Crypto API (crypto.subtle) and
 * the BigInt type. It has no external dependencies.
 *
 * Usage:
 *   const infoLabel = new TextEncoder().encode("com.example.eth-key-v1");
 *   // IMPORTANT: normalize provider output to ArrayBuffer first.
 *   // Some provider/library combinations may surface PRF data as non-binary values.
 *   const prfOutput = credential.clientExtensionResults.prf.results.first; // then normalize
 *   const privateKey = await prfToValidEthPrivKey(prfOutput, infoLabel);
 *   const wallet = new ethers.Wallet(privateKey);
 */

/** secp256k1 curve order N */
export const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);

/**
 * Convert an ArrayBuffer to lowercase hex (no 0x prefix).
 */
export function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a valid Ethereum private key from a WebAuthn PRF output.
 *
 * @param prfOutput  The 32-byte PRF output (ArrayBuffer) from
 *                   `credential.clientExtensionResults.prf.results.first`.
 * @param infoLabel  Your application's stable, versioned derivation label
 *                   (e.g. `TextEncoder().encode("com.example.eth-key-v1")`).
 *                   CHANGING THIS AFTER USERS REGISTER BREAKS THEIR WALLETS.
 * @returns          A hex string with `0x` prefix, suitable for `new ethers.Wallet(key)`
 *                   or viem's `privateKeyToAccount`.
 * @throws           Error if no valid key could be derived after 16 iterations.
 */
export async function prfToValidEthPrivKey(
  prfOutput: ArrayBuffer,
  infoLabel: Uint8Array,
): Promise<`0x${string}`> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    prfOutput,
    "HKDF",
    false,
    ["deriveBits"],
  );

  const salt = new Uint8Array(32); // 32 zero bytes — PRF output already has full entropy

  for (let counter = 0; counter < 16; counter++) {
    const info = new Uint8Array(infoLabel.byteLength + 1);
    info.set(infoLabel, 0);
    info[infoLabel.byteLength] = counter;

    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      baseKey,
      8 * 32, // 256 bits
    );
    const privBytes = new Uint8Array(bits);

    // Interpret the 32 bytes as a big-endian integer and check range.
    let n = 0n;
    for (const b of privBytes) n = (n << 8n) + BigInt(b);
    if (n === 0n) continue;
    if (n >= SECP256K1_N) continue;

    return `0x${bufToHex(privBytes.buffer)}` as `0x${string}`;
  }

  throw new Error(
    "Failed to derive valid secp256k1 private key after 16 attempts",
  );
}
