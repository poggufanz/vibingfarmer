# PRF → Ethereum Private Key Derivation

This document explains the full derivation pipeline: how a WebAuthn PRF output becomes a usable secp256k1 private key, why each step exists, and the ways you can get it subtly wrong.

## Pipeline Overview

```
passkey + PRF salt (infoLabel)
    │
    ▼  (authenticator HMAC-SHA-256, per credential)
32 bytes of PRF output
    │
    ▼  HKDF-SHA-256 with salt = 32 zero bytes, info = infoLabel || counter
32 bytes of candidate key material
    │
    ▼  reject if 0 or ≥ secp256k1 N, retry with counter++
32-byte secp256k1 private key
    │
    ▼  ethers.Wallet(privateKey) or privateKeyToAccount(privateKey)
Ethereum wallet (address + signing capability)
```

## Why HKDF after PRF?

The authenticator's PRF evaluation is itself HMAC-SHA-256, which is already a strong pseudorandom function. Isn't that enough? Not quite, for two reasons:

1. **Range validation.** secp256k1 requires private keys in `[1, N-1]` where `N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141`. A raw PRF output is uniformly random 256 bits, so with vanishingly small but non-zero probability it lands on 0 or above N. HKDF gives you a principled way to iterate (via the `info` byte) until you get a valid candidate, without having to re-run the user's passkey ceremony.

2. **Domain separation.** HKDF's `info` parameter lets you bind the derived key to your application and key version. If you later need a second, unrelated key from the same passkey, you can derive it with a different `info` label and be sure the keys are cryptographically independent. This matters for extensibility (and for not accidentally reusing a signing key as an encryption key).

## Inputs

### `prfOutput` — 32 bytes from the authenticator

Obtained from `clientExtensionResults.prf.results.first` after a successful `navigator.credentials.get()` call that included the PRF extension. In ideal browser implementations this arrives as an `ArrayBuffer`, but in practice some provider/library combinations may surface other shapes (typed views or serialized strings). Treat this field as `unknown`, normalize it to an `ArrayBuffer`, and if normalization fails treat it as "PRF not supported on this passkey" for wallet derivation purposes.

The authenticator computes this as (roughly) `HMAC-SHA-256(credential_prf_key, "WebAuthn PRF" || salt)`, where `salt` is your `eval.first` value. Two important properties:

- Different credentials have different PRF keys → same salt across credentials gives different outputs.
- The same credential + same salt always gives the same output.

### `infoLabel` — your per-purpose string constant

Example: `"com.example.eth-key-v1"`.

- **Declare it once** as a module-level constant in your key derivation code.
- **Use it in two places:** as the `eval.first` input to PRF (encoded as `Uint8Array`) AND as the `info` parameter to HKDF. In 1Shot's implementation they happen to be the same value, which is fine and keeps the derivation compact.
- **Version it.** The `-v1` suffix lets you intentionally roll keys in the future by introducing `-v2` — but only if you also have a migration plan, because existing users will still need their v1 key to access their wallet.

The label is not secret. An attacker who observes it learns nothing exploitable. It is, however, part of your protocol and changing it silently destroys wallets.

### HKDF parameters

- **Hash:** SHA-256.
- **Salt:** 32 zero bytes. HKDF's salt is for "stretching" low-entropy input; PRF output is already high-entropy, so a fixed zero salt is fine per RFC 5869 §3.1. Using a random salt would break determinism.
- **Info:** `infoLabel || counter`, where `counter` is a single byte `0x00`, `0x01`, … (see below).
- **Output length:** 32 bytes (256 bits) — exactly the secp256k1 private key size.

## The counter loop

```ts
for (let counter = 0; counter < 16; counter++) {
  const info = new Uint8Array(infoLabel.byteLength + 1);
  info.set(new Uint8Array(infoLabel), 0);
  info[infoLabel.byteLength] = counter;

  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: zeroSalt, info },
    baseKey,
    8 * 32,
  );
  const privBytes = new Uint8Array(bits);

  // Check for 0 and for ≥ N
  let n = 0n;
  for (const b of privBytes) n = (n << 8n) + BigInt(b);
  if (n === 0n) continue;
  if (n >= SECP256K1_N) continue;

  return `0x${bufToHex(privBytes.buffer)}`;
}
throw new Error("Failed to derive valid secp256k1 private key after retries");
```

With uniform 256-bit output and N very close to 2^256, the probability a single iteration is invalid is about `1 - N/2^256 ≈ 2^-128`. 16 retries is absurd overkill — 1 is almost always enough — but the loop exists so the derivation cannot fail deterministically in the astronomically unlikely bad case.

**Why `counter` is one byte, not, say, a 32-bit integer.** The `info` field of HKDF is just a byte string; any encoding works. A single byte keeps the implementation tiny and is more than enough for 16 attempts. If you expand beyond 16 (you don't need to), widen the counter encoding.

## `SECP256K1_N`

```ts
export const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);
```

This is a hard-coded constant. Do not fetch it from the network. Do not recompute it.

## Assembling the Ethereum wallet

Once you have the 32-byte key (hex, `0x`-prefixed), construct the wallet with whichever library you use:

```ts
// ethers v6
import { Wallet } from "ethers";
const wallet = new Wallet(privateKeyHex);
console.log(wallet.address); // 0x...

// viem
import { privateKeyToAccount } from "viem/accounts";
const account = privateKeyToAccount(privateKeyHex as `0x${string}`);
console.log(account.address); // 0x...
```

The address is deterministic from the private key: `address = keccak256(secp256k1_public_key(privKey))[12:]`. Different libraries agree.

## Subtle mistakes and how they manifest

| Mistake | Symptom |
| --- | --- |
| Sending the PRF salt as a string, not an `ArrayBuffer` | `clientExtensionResults.prf` is `undefined` after `navigator.credentials.create`. |
| Using base64 (with `+/`) instead of base64url (with `-_`) on the wire | Some browsers accept it, some don't; works in Chrome, breaks in Safari. |
| Passing `clientExtensionResults.prf.results.first` straight into `importKey("raw", ...)` without runtime normalization | Throws `TypeError: Key data must be a BufferSource for non-JWK formats` on providers that return serialized/non-binary values. |
| Different `infoLabel` between registration and authentication | Registration "works" but authentication produces a wallet with a different address. User's funds appear lost. |
| Fetching the `infoLabel` from the server instead of hard-coding it | Compromised server can redirect all users' derived keys to addresses it controls. |
| Forgetting the counter loop, just returning the first HKDF output | Works 99.99…% of the time. The one in 2^128 unlucky user has an invalid key and an unresolvable support ticket. |
| Skipping the zero-check | Same as above, even worse symptom (library accepts it, then signatures don't verify). |
| Caching the wallet to localStorage "for performance" | Defeats the entire point of iframe isolation. Don't. |
| Logging the private key, even once, in a `console.debug` | The key persists in the browser's DevTools history; anyone with later physical access to the machine can read it. Log only the derived *address*. |

## Independent key derivation

If you need a second, independent key (e.g. for a different purpose or chain), use a different `infoLabel` but **the same PRF output**. Run HKDF twice:

```ts
const prfOutput = /* ... */;
const ethKey = await prfToValidEthPrivKey(prfOutput, new TextEncoder().encode("com.example.eth-key-v1"));
const encKey = await deriveBits(prfOutput, "com.example.enc-key-v1"); // not secp256k1-constrained
```

This is fine and is the recommended way to extend — it does not require the user to run another passkey ceremony. One ceremony produces PRF output; multiple HKDF derivations produce as many keys as you need.

## Determinism testing

When you add this derivation to a new codebase, the single most useful test:

```ts
it("produces the same address for the same prfOutput and infoLabel", async () => {
  const prfOutput = new Uint8Array(32).fill(0x42).buffer;
  const infoLabel = new TextEncoder().encode("test-v1");
  const key1 = await prfToValidEthPrivKey(prfOutput, infoLabel);
  const key2 = await prfToValidEthPrivKey(prfOutput, infoLabel);
  expect(key1).toBe(key2);
  // And a sanity check on the address
  expect(new Wallet(key1).address).toMatch(/^0x[a-fA-F0-9]{40}$/);
});
```

This will catch accidental reliance on `Math.random`, order-dependent side effects, or silent encoding changes.
