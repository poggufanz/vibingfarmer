---
name: webauthn-prf-wallet
description: Build an iframe-isolated, passkey-derived Ethereum wallet using the WebAuthn PRF extension. Use when the user wants to implement a passkey-based wallet, derive an EVM private key from a passkey without server custody, add a non-custodial wallet pattern to a web app, harden wallet key handling against XSS via an isolated iframe, or check whether a client platform supports the WebAuthn PRF extension. Covers PRF + HKDF → secp256k1 key derivation, LongBlob fallback for compatibility, cross-frame RPC via Postmate, and browser/OS platform support gating.
---

# WebAuthn PRF Wallet

A reusable pattern for deriving an Ethereum private key from a user's passkey entirely on the client, with the key never leaving an isolated iframe. This skill captures the implementation from the 1Shot Payments app, distilled so that it can be dropped into any web application.

**What you get:**

- A deterministic `passkey ⇒ EVM private key` derivation that produces the same wallet every time the user authenticates with the same passkey.
- An isolated wallet iframe that holds the derived key in memory and signs transactions via a narrow RPC surface — the key is never reachable from the parent page's JavaScript, substantially reducing XSS/supply-chain risk.
- Platform support gating (PRF is not universally available) with a LongBlob + recovery-phrase fallback so users on incompatible authenticators can still have an account.

**What you do NOT get from this skill alone:**

- A product. You still need to wire up registration UI, session management, a relying party (RP) configuration, and whatever use case you're building (signing, payments, delegations, etc.).
- A server. The skill shows what the server must do (challenge storage, signature verification) but does not prescribe the stack — Next.js is shown as an example in `references/nextjs-example.md`.

## Quick Reference

**Detailed references — read the one(s) relevant to your task:**

- [references/prf-derivation.md](./references/prf-derivation.md) — How PRF output becomes a valid secp256k1 private key. Read this when implementing the derivation function or debugging "wrong address" issues.
- [references/platform-support.md](./references/platform-support.md) — Browser/OS compatibility matrix, webview detection, `isPlatformSupported()` helper. Read this when gating registration or showing a "not supported" message.
- [references/iframe-isolation.md](./references/iframe-isolation.md) — Postmate cross-frame RPC, iframe `allow` attribute, the user-activation / visibility gotcha that breaks WebAuthn in hidden iframes. Read this when setting up the wallet iframe or debugging "no passkey prompt appears" in the iframe.
- [references/longblob-fallback.md](./references/longblob-fallback.md) — `credBlob` / `largeBlob` storage, recovery-phrase encryption, multi-passkey support. Read this when you want PRF-incompatible devices to still work, or when supporting multiple passkeys per account.
- [references/server-integration.md](./references/server-integration.md) — Generating registration/authentication options with PRF salts, verifying responses, and what to persist. Framework-agnostic.
- [references/nextjs-example.md](./references/nextjs-example.md) — Concrete walkthrough using Next.js App Router + `@simplewebauthn` + Redis for challenges.

**Copy-ready code (in `assets/`):**

- `assets/prfToValidEthPrivKey.ts` — HKDF → secp256k1 derivation (browser-safe, Web Crypto API).
- `assets/platformSupport.ts` — Browser/OS/webview detection using Bowser.
- `assets/WalletIframeSketch.ts` — Minimal Postmate `Model` that derives the key and exposes a `signMessage` RPC. Strip out what you don't need.

## Package Installation

```bash
npm install @simplewebauthn/browser @simplewebauthn/server ethers viem postmate bowser
```

At runtime the pattern uses the platform `crypto.subtle` API (no polyfill needed in modern browsers). Server-side you need a KV store for challenges with a short TTL (Redis is used in the reference, any equivalent works).

## Core Concepts

### 1. The PRF extension is a deterministic, per-credential secret

`PRF` (Pseudo-Random Function) is a WebAuthn extension that lets the authenticator evaluate an HMAC-SHA-256 over an input you provide (the "salt") using a secret key it keeps for that credential. Properties you care about:

- **Deterministic.** The same credential + same `eval.first` salt always produces the same 32-byte output.
- **Scoped to a credential.** A different passkey produces a different PRF output, even with the same input. This is why you generally bind **one wallet = one credential** unless you use the LongBlob fallback (see `references/longblob-fallback.md`).
- **Never leaves the authenticator without user presence + verification.** The user consents to each evaluation via biometrics / PIN.
- **Not available everywhere.** See `references/platform-support.md`.

You use the PRF output as keying material, then run **HKDF → secp256k1** to produce an Ethereum private key. The PRF output is not itself a valid key — it could be zero or above the curve order.

### 2. The derivation must converge on the same key forever

The derivation inputs are:

- `prfOutput` — 32 bytes from the authenticator, **depends on the `info` label you pass as `eval.first`**.
- `infoLabel` — a UTF-8 string you choose, e.g. `"com.example.eth-key-v1"`.
- HKDF parameters — salt (32 zero bytes is fine; PRF output is already scoped to the credential), info (infoLabel ‖ counter byte), hash = SHA-256, output length = 32 bytes.

**The `infoLabel` is a forever decision.** If you change it after users have registered, their derived key changes and they lose access to their wallet. Version it in the string itself (e.g. `-v1`) and never change that version.

The HKDF output may occasionally be ≥ the secp256k1 curve order or zero. Retry with `counter = 0, 1, 2, …, 15`; in practice counter 0 succeeds with overwhelming probability. See `assets/prfToValidEthPrivKey.ts` for the full implementation.

### 3. Isolate the key in an iframe

The derived private key must never be reachable from the main application's JavaScript context. If the parent page is compromised (XSS, malicious dependency), the attacker gets the user's funds.

The pattern:

- Host a dedicated wallet page at a same-origin route (e.g. `/wallet/local`). This page has **minimal dependencies** — only what's needed for passkey auth and signing.
- Embed that page in a hidden `<iframe>` on the main app. The iframe must have `allow="publickey-credentials-get publickey-credentials-create"`.
- Communicate via structured RPC (Postmate is a thin wrapper over `postMessage` that's well-suited here). The parent calls methods like `signIn`, `getERC3009Signature`, `getAccountAddress`; the iframe runs the passkey ceremony and signs inside its own context.
- The iframe caches the unlocked wallet in module-level (closure) state. The parent never receives the key.

See `references/iframe-isolation.md` for the non-obvious bits: WebAuthn requires the iframe's ancestor chain to NOT be `display:none`, and `navigator.userActivation` must be preserved across the `postMessage` hop.

### 4. PRF is primary, LongBlob is the compatibility path

Because PRF is not supported on every browser/OS combination (notably Firefox-for-Android and in-app webviews), the 1Shot architecture supports a **LongBlob fallback**: the authenticator stores the 32-byte EVM private key in `credBlob` (at registration) or `largeBlob` (at authentication) inside the credential itself. The key is generated on the client at registration time.

Consequences:

- In **PRF mode**, a user has exactly one credential. Adding a second passkey would produce a different PRF output, i.e. a different wallet.
- In **LongBlob mode**, a user can have many passkeys — each stores a copy of the same key.
- Always provide a recovery-phrase path (AES-encrypted key stored server-side) so a user who loses access to all their passkeys can still recover.

See `references/longblob-fallback.md` for details.

### 5. Every wallet operation requires a fresh passkey ceremony

Even if the user has a valid session cookie, performing a wallet operation (signing a transaction, creating a delegation) must trigger a passkey ceremony in the iframe. Rationale:

- The derived key is only held in iframe memory while the wallet is "unlocked" after a ceremony. If the app is backgrounded / reloaded, the iframe loses the key and needs another ceremony.
- This matches the user's mental model of "approving" each transaction with their fingerprint / Face ID / PIN.
- Defense-in-depth: even if a session is hijacked, the attacker still can't sign anything without the user's biometric.

Structure your proxy so that `signIn` can be called at any time and is idempotent (returns the cached unlock result if already unlocked for this session), and signing methods call an internal `assureWallet()` that triggers a ceremony if needed.

## Implementation Workflow

Use this order when building a new app that uses this pattern:

1. **Gate the platform.** On the registration / login page, call `isPlatformSupported()` (see `assets/platformSupport.ts`). If it returns false, route the user to a waiting-list / recovery-phrase-only flow rather than letting them register a passkey that can't be used.

2. **Set up the wallet iframe route.** Create a same-origin page (e.g. `/wallet/local`) that loads a Postmate `Model`. Keep its dependency graph small — import only what's needed for the passkey ceremony, key derivation, and signing. Return `<div style={{display: 'none'}} />` as the component's default render (the iframe doesn't need UI most of the time).

3. **Build the `WalletProxy`** in the parent app. It holds the `Postmate.ParentAPI` handle and exposes typed methods like `signIn(username)`, `getAccountAddress()`, `signMessage(msg)`, `getERC3009Signature(...)`. Wrap each method in an RPC envelope with a nonce so responses can be correlated (see `assets/WalletIframeSketch.ts`).

4. **Implement the server endpoints** (framework-agnostic):
   - `POST /api/auth/register` — no body → returns registration options with a 32-byte PRF salt base64url-encoded in `extensions.prf.eval.first`; with credential → verifies and persists the credential.
   - `POST /api/auth/login` — no credential → returns authentication options (no PRF salt here; the salt is reconstructed client-side from the `infoLabel`); with credential → verifies and starts a session.
   - Store the challenge nonce in Redis (or equivalent) with a ~60s TTL keyed by a server-generated `challengeId` that is returned to the client and echoed back.

5. **Wire the registration flow** (runs in the parent page, NOT the iframe, so the initial credential creation happens in the primary browsing context):
   - Fetch options, decode the PRF salt from base64url to an `ArrayBuffer`, generate a random EVM private key locally (for LongBlob storage if supported), call `navigator.credentials.create({ publicKey })`, inspect `clientExtensionResults` to decide if PRF or LongBlob is available, send the response back to the server.
   - After the server confirms, call `walletProxy.signIn(username)` to run the first authentication ceremony (this time in the iframe) and let the iframe learn the account address.

6. **Wire the sign-in flow** (runs in the iframe via the proxy):
   - Parent calls `walletProxy.signIn(username)`.
  - Iframe fetches authentication options from the server, adds the PRF extension with `eval.first = TextEncoder().encode(infoLabel)`, calls `startAuthentication()`, reads `clientExtensionResults.prf.results.first` as `unknown`, normalizes it to `ArrayBuffer`, then runs HKDF derivation to get the EVM private key, constructs an `ethers.Wallet`, posts the authentication response back for server verification, and caches the wallet in memory.

7. **Wire signing operations.** Any method that signs uses `assureWallet()` which either returns the cached wallet or triggers `authenticateWithPasskey()` again.

8. **Add the recovery flow.** At registration (after a successful sign-in), prompt the user to create a recovery phrase; derive an AES-256 key from the phrase via PBKDF2, encrypt the private key, send the ciphertext to the server. At recovery, the user types their recovery phrase and `accountRecoveryId`, the server returns the ciphertext, the client decrypts and re-authenticates.

## Critical Implementation Nuances

These are the things that will cost you a day each if you miss them. The reference files go deeper on each.

### PRF salt encoding

- On the **server**, generate 32 random bytes and base64url-encode them into `extensions.prf.eval.first` — **not** plain base64. The WebAuthn library on the client may or may not accept unpadded/padded base64, and you avoid ambiguity by being strict.
- On the **client during registration**, you must decode the base64url back to an `ArrayBuffer` (e.g. with `@simplewebauthn/browser`'s `base64URLStringToBuffer`) before handing to `navigator.credentials.create`. A common bug is leaving it as a string — the browser silently ignores PRF and `clientExtensionResults.prf` comes back `undefined`.
- On the **client during authentication**, the salt that feeds key derivation should be **constant and baked into your code**, not fetched from the server. Use something like `new TextEncoder().encode("com.example.eth-key-v1")`. This way, even if the server is compromised it cannot redirect the user to a different derived key.

### Checking PRF support happens at two different shapes

- At **registration** the authenticator reports support via `clientExtensionResults.prf.enabled === true`. Results are optional here; `enabled` is the signal.
- At **authentication** you usually get PRF bytes via `clientExtensionResults.prf.results.first`, but treat it as `unknown` at runtime and normalize before HKDF. Accept `ArrayBuffer`, typed-array/DataView, and optionally base64url/base64 strings if your WebAuthn stack serializes extension data. If normalization fails (or the value is `undefined`), authentication may still succeed server-side but you cannot derive the wallet key — show a provider-compatibility error and block sign-in.
- Do **not** pass raw `unknown` PRF data directly into `crypto.subtle.importKey("raw", ...)`. If the value is not a `BufferSource`, browsers throw `TypeError: Key data must be a BufferSource for non-JWK formats`.

### The `infoLabel` is part of the key forever

Pick it once, put it in a constant with a clear comment, and never change it. If you later want a second key (e.g., for a different purpose), use a different `infoLabel` for the new key — don't change the original.

### Platform detection must exclude webviews explicitly

User-agent sniffing is fragile but in this case unavoidable: in-app webviews (Facebook, Instagram, LinkedIn, iOS WKWebView without Safari) do not support PRF even when the underlying browser engine does. See `assets/platformSupport.ts` for the detection heuristics. Fail closed: if you can't tell, don't let the user register a passkey that won't work.

### Iframe must not be `display: none` during the passkey ceremony

Several browsers refuse to show the WebAuthn prompt if the iframe's ancestor chain has `display: none`. The pattern in 1Shot's `WalletProxy`:

1. Right before calling into the iframe, set the container to `display: block !important; position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; z-index: -1`.
2. Focus the iframe's `contentWindow` to preserve user activation.
3. After the RPC resolves, restore the original (hidden) state.

This is worth its own look in `references/iframe-isolation.md`.

### Iframe `allow` attribute is required

Set `allow="publickey-credentials-get publickey-credentials-create"` on the iframe element. Without this, `navigator.credentials.*` inside the iframe throws or silently fails depending on the browser.

### User activation survives one `postMessage` hop when triggered from a user gesture

WebAuthn APIs require transient user activation. When the user clicks a button in the parent page, the activation is consumed quickly. You must call `this.child.call(eventName, ...)` (via Postmate) synchronously inside the click handler so the iframe still sees `navigator.userActivation.isActive === true`. Don't wrap it behind an extra `setTimeout` or unrelated `await`.

### secp256k1 range validation isn't just theoretical

The HKDF output is uniformly random 32 bytes; the probability it's ≥ N or zero is astronomically small, but spec-correct implementations must reject out-of-range keys. Loop with the counter byte as shown in `assets/prfToValidEthPrivKey.ts`. If you skip this, a rare future user could end up with an invalid key and a very confused support ticket.

### Session doesn't replace passkey for wallet ops

Even if the user is "logged in" (valid session cookie), wallet operations must still trigger a passkey ceremony. The session is for server-side authorization (who are you?), the passkey is for client-side key derivation (can you unlock the wallet?). Keep the two orthogonal.

## When NOT to use this skill

- You need **custodial** wallet operations (server holds the key). Use a KMS or MPC service instead; passkey PRF is for non-custodial flows.
- You target only Node-based servers or desktop environments. WebAuthn PRF is browser-only; there's no analogue for a headless signer.
- You need the same wallet across multiple authenticators on day one and can't tolerate a LongBlob migration story. Consider MPC or a seed-phrase-first architecture.
- Your users are overwhelmingly on in-app webviews (embedded social apps, some corporate mobile clients). PRF coverage is poor there; use this skill in combination with a recovery-phrase-only path or pick a different approach entirely.

## Security Notes

- **The PRF output is sensitive.** Never log it. Never persist it. Never send it to the server.
- **The derived private key stays in the iframe.** The parent should only ever receive signatures and the public account address.
- **Postmate uses `postMessage`** — Postmate restricts messages to a known origin; verify the iframe URL is same-origin in production.
- **CSP matters.** Consider adding `frame-ancestors 'self'` to the wallet iframe's response and `X-Frame-Options: SAMEORIGIN` so third parties can't re-embed it. The 1Shot app uses `/wallet/local` for same-origin and reserves `/wallet` for intentional external embedding, which has different CSP rules.
- **Recovery phrase encryption** uses PBKDF2-SHA256 with 100,000 iterations and a per-user salt (the user ID). The recovery ciphertext stored server-side is useless without the passphrase.
- **Do not reuse the `infoLabel`** across different apps on the same origin. Two different apps deriving the same key from the same passkey breaks the "one passkey = one purpose" model.

## File Layout You Should End Up With

A minimal integration into an existing Next.js app looks like:

```
src/
├── app/
│   └── wallet/
│       └── local/
│           └── page.tsx              # Iframe wallet (Postmate Model)
├── clientUtils/
│   ├── WalletProxy.ts                # Parent-side RPC client
│   ├── WalletFrame.ts                # Iframe-side helper (authenticateWithPasskey, assureWallet, rpcWrapper)
│   ├── ClientCrypto.ts               # prfToValidEthPrivKey + AES helpers + signing helpers
│   ├── platformSupport.ts            # isPlatformSupported, isWebview
│   └── ProxyTypes.ts                 # Shared RPC types
├── app/
│   └── api/
│       └── auth/
│           ├── register/route.ts     # Registration options + verification
│           └── login/route.ts        # Authentication options + verification
```

See `references/nextjs-example.md` for working code snippets at each of these paths.

## Getting Started Checklist

1. Pick your `infoLabel` (e.g. `"com.yourcompany.yourapp.eth-key-v1"`) and write it down somewhere permanent.
2. Decide your relying party ID (`rpID`) and relying party name.
3. Copy `assets/prfToValidEthPrivKey.ts` and `assets/platformSupport.ts` into your client utils.
4. Stub out the server endpoints using the `@simplewebauthn/server` examples in `references/server-integration.md`.
5. Build the iframe page from the scaffold in `assets/WalletIframeSketch.ts`.
6. Add the `WalletProxy` on the parent and initialize it in a context/provider on app mount.
7. Gate your registration/login UI with `isPlatformSupported()`.
8. Implement recovery before launch — users will lose devices.
