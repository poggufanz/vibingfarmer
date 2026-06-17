# LongBlob Fallback & Recovery Phrase

PRF is not universally supported. This reference explains the fallback strategies that let a PRF-unavailable user still have a passkey-backed wallet: `credBlob` / `largeBlob` for in-authenticator storage, plus an encrypted recovery phrase stored server-side for device-loss recovery.

## Overview

Three ways a user can "hold" their EVM private key:

| Method | Storage | Multi-passkey? | Setup | Notes |
| --- | --- | --- | --- | --- |
| **PRF** | Derived on demand from authenticator secret | ❌ One passkey per account | Zero — key is derived | The default in this skill. |
| **credBlob / largeBlob (LongBlob)** | Stored inside the credential | ✅ Many passkeys | Generate key at registration, store in credential | Authenticators vary in support; may be truncated (credBlob is only 32 bytes, enough for an EVM key). |
| **Recovery phrase (AES-encrypted backup)** | AES-encrypted blob on server | N/A — not a passkey | User generates a passphrase at registration | Always available; last-resort recovery when all passkeys are lost. |

A production app wants **at least two** of these so no single failure loses a user's wallet.

## credBlob vs largeBlob

Both are WebAuthn extensions that let an authenticator store arbitrary bytes inside a credential:

- **credBlob** — written **during credential creation (registration)**. Maximum ~32 bytes. An EVM private key is exactly 32 bytes, so this is a perfect fit. Readable during any subsequent authentication via `clientExtensionResults.credBlob`.
- **largeBlob** — written/read **during authentication**. Much larger (up to ~1 KiB typically). More flexible but requires a two-step flow: register → authenticate once to write → authenticate again to read. During registration you can check `clientExtensionResults.largeBlob.supported === true` as a compatibility probe.

**The 1Shot approach:** prefer `credBlob` (one-step), fall back to `largeBlob` (two-step), fall back to PRF if neither is available. In practice most authenticators that support PRF don't support LongBlob (the opposite of what the spec designers intended), so you typically end up with either LongBlob OR PRF per user.

## Registration flow with LongBlob preference

```ts
// 1. Generate a random 32-byte EVM private key in the parent page, up front.
const registrationWallet = Wallet.createRandom();
const privateKeyHex = registrationWallet.privateKey.slice(2);
const privateKeyBytes = new Uint8Array(
  privateKeyHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
);

// 2. Build extensions. Include credBlob (the private key bytes) AND
//    the PRF salt (for the PRF path).
const extensions: AuthenticationExtensionsClientInputs = {
  credBlob: privateKeyBytes,
  largeBlob: { support: "preferred" },
  prf: { eval: { first: prfSaltFromServer } },
};

// 3. Create the credential with these extensions.
const credential = await navigator.credentials.create({
  publicKey: { ...options, extensions },
});

// 4. Inspect clientExtensionResults to decide the mode.
const cer = credential.getClientExtensionResults() as Record<string, unknown>;

const hasCredBlob = "credBlob" in cer;
const hasLargeBlobSupport =
  typeof cer.largeBlob === "object" &&
  cer.largeBlob !== null &&
  "supported" in cer.largeBlob &&
  (cer.largeBlob as { supported: boolean }).supported === true;

const hasLongBlob = hasCredBlob || hasLargeBlobSupport;

const hasPRF =
  typeof cer.prf === "object" &&
  cer.prf !== null &&
  "enabled" in cer.prf &&
  (cer.prf as { enabled: boolean }).enabled === true;

if (!hasLongBlob && !hasPRF) {
  // Authenticator supports neither path. Waiting-list the user.
  return showWaitingList();
}

// 5. Tell the server which mode was used, so it remembers on the next login.
const credentialType = hasLongBlob ? "LongBlob" : "PRF";
```

The generated `registrationWallet` is **only used if LongBlob storage worked**. If the user ended up in PRF mode, the random key is discarded and the real wallet is derived from the PRF output on the next authentication.

## Authentication flow with LongBlob mode

If the user's credential was registered in LongBlob mode, authentication must include the appropriate read extensions:

```ts
// credBlob is returned automatically on authentication when it was set at registration —
// just include it as a flag in extensions.
const authOptions = {
  ...optionsFromServer,
  extensions: {
    ...optionsFromServer.extensions,
    getCredBlob: true,
  },
};

const credential = await startAuthentication({ optionsJSON: authOptions });

const cer = credential.clientExtensionResults as Record<string, unknown>;
const credBlob = cer.credBlob as ArrayBuffer | undefined;

if (credBlob) {
  const privateKey = `0x${bufToHex(credBlob)}`;
  const wallet = new Wallet(privateKey);
  // ... proceed
}
```

For largeBlob, use `{ largeBlob: { read: true } }` to read, `{ largeBlob: { write: bytes } }` to write. The two-step registration looks like:

1. Register with `extensions.largeBlob: { support: "preferred" }`; check that `cer.largeBlob.supported === true`.
2. First authentication: `extensions.largeBlob: { write: privateKeyBytes }`; check `cer.largeBlob.written === true`.
3. All subsequent authentications: `extensions.largeBlob: { read: true }`; key comes back in `cer.largeBlob.blob`.

## Multi-passkey support in LongBlob mode

Because LongBlob stores the actual key bytes, a user can enroll multiple passkeys that all hold the same key. Pattern:

1. User is already signed in with passkey #1.
2. User requests "add passkey" for device #2.
3. Server generates a registration challenge and returns it.
4. **Client reads the existing private key from the unlocked wallet** (i.e. the private key the iframe already has in memory).
5. Client calls `navigator.credentials.create({ publicKey: { ...options, extensions: { credBlob: privateKeyBytes } } })`.
6. The new credential now holds a copy of the same key. Both passkeys produce the same Ethereum address.

This explicitly does **not** work for PRF, because the PRF output is per-credential and cannot be cross-credential.

## Recovery phrase (AES-encrypted backup)

Always offer recovery, because passkeys can be lost (device wiped, authenticator reset, account migration to a new phone that drops enrollments).

### At registration

1. User has just completed registration and authentication. The iframe has the unlocked wallet.
2. Prompt the user for a recovery passphrase (or generate one for them and display once).
3. In the iframe:
   - Derive an AES-256 key from the passphrase using PBKDF2-SHA256 with:
     - Salt: the user's ID / UUID, as bytes.
     - Iterations: 100,000.
     - Output length: 256 bits.
   - Encrypt the EVM private key as a UTF-8 string with AES-CBC. Derive the 16-byte IV from `SHA-256(userId)[0:16]` — deterministic so decrypt can rebuild it.
   - POST the ciphertext to your server (e.g. `/api/user/backup`) along with any recovery ID the server generates for lookup.

```ts
// Derive AES key
const aesKey = await deriveAESKeyFromString(passphrase, userId.toLowerCase());

// Encrypt
const ciphertext = await encryptString(wallet.privateKey, aesKey, userId.toLowerCase());

// Send to server
await fetch("/api/user/backup", {
  method: "POST",
  body: JSON.stringify({ encryptedData: ciphertext }),
});
```

See `src/clientUtils/ClientCrypto.ts` in the 1Shot codebase for `deriveAESKeyFromString`, `encryptString`, `decryptAESEncryptedString` — the implementations use Web Crypto API (`crypto.subtle`) and are browser-safe.

### At recovery

1. User can't sign in with their passkey. They click "Recover account."
2. Prompt for the recovery ID (a short UUID or code) and the passphrase.
3. Client fetches the ciphertext + user data from the server.
4. Derive the AES key (same PBKDF2 parameters), decrypt the ciphertext → EVM private key.
5. Construct the wallet, sign a "recovery nonce" challenge the server issued, submit to prove the recovery succeeded.
6. Server creates a new session. The user is back in.

After recovery, prompt the user to register a new passkey immediately, so they have both an active credential and their recovery phrase.

### Recovery security properties

- **Ciphertext is useless alone.** Anyone who steals the server's database still needs the user's passphrase to decrypt. PBKDF2 at 100,000 iterations makes brute-force expensive for strong passphrases.
- **Passphrase-only recovery.** The server never sees the plaintext key. It only sees `ciphertext` and `encryptedWith(userId)`.
- **Rate-limit the recovery endpoint.** An attacker who knows a user's `accountRecoveryId` can attempt passphrases via the API. 5 attempts per hour per recovery ID is reasonable.
- **Generate strong passphrases by default.** 1Shot uses the `generate-password` library with 15 characters including numbers, symbols, and mixed case; it also excludes visually similar characters. Users who choose their own are usually worse, so default to generating and displaying once.

## Choosing a default mode per user

At registration time, after inspecting `clientExtensionResults`:

```ts
let mode: "LongBlob" | "PRF";

if (hasCredBlob || hasLargeBlobSupport) {
  mode = "LongBlob";
  // Store privateKeyBytes via credBlob/largeBlob
  // User can add more passkeys later
} else if (hasPRF) {
  mode = "PRF";
  // No stored bytes. Key is PRF-derived.
  // User is limited to ONE credential for this account.
} else {
  // Neither path works. Waiting list.
}
```

Persist the mode alongside the credential in the database. On authentication, use it to decide which extension results to look for.

## Preference order: why LongBlob over PRF?

1. **Multi-passkey.** LongBlob lets the user enroll a second device, which is the #1 reason real users ask for recovery support.
2. **No derivation bugs.** LongBlob stores the key directly — there's no HKDF loop, no secp256k1 range check, no infoLabel to get wrong. Fewer moving parts.
3. **Cross-authenticator portability.** If the user wants to export the key to another wallet (MetaMask, etc.) you can expose it; the same key travels with any passkey that holds it. With PRF, each passkey would derive a different key, which is usually not what users want.

PRF's advantage is that the key never "exists" outside the active ceremony — there's no ciphertext for an attacker to steal from the authenticator. In practice this is marginal; both modes resist offline attack.

**Recommendation for production apps:** prefer LongBlob when available, fall back to PRF, always offer recovery phrase.
