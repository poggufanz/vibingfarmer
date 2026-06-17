# Server-Side Integration

The server's job in this architecture is narrow: generate challenges, verify WebAuthn responses, and store credentials. It never sees the private key, never performs key derivation, and never holds session state for the wallet beyond "is this user's session valid?".

This reference uses `@simplewebauthn/server` because it's the de facto Node.js implementation of the WebAuthn relying party logic, but the concepts translate to any RP library.

## Configuration

```ts
// Where the RP lives — must match window.location.hostname on the client.
const rpID = "payments.example.com";          // Or "localhost" for dev
const rpName = "Example Payments";
const publicOrigin = "https://payments.example.com"; // Or "http://localhost:3000" for dev
```

These are passed to options generators and verifiers. Get them from env/config. The `rpID` is the domain (no scheme, no path); `publicOrigin` is the full origin.

## Endpoints

Three endpoints are typically enough:

- `POST /api/auth/register` — get registration options (no body) OR submit a registration response (body includes credential).
- `POST /api/auth/login` — get authentication options (body includes username) OR submit an authentication response.
- `POST /api/auth/logout` — revoke the current session.

You can split into four endpoints instead; the "body present or absent" branching is purely stylistic.

## Storage requirements

- **Challenge store** with a short TTL (~60s). Redis is ideal. Each registration/authentication attempt gets a server-generated UUID (call it `challengeId`) and the corresponding WebAuthn `challenge` is stored under that key. On verification, look up the challenge by the `challengeId` the client echoes back.
- **Users and credentials table.** Minimum fields:
  - `user_id` (UUID)
  - `username` (unique)
  - `account_address` (EVM address derived from the wallet — for display/lookup)
  - For each credential: `credential_id` (base64url), `credential_public_key` (base64), `credential_type` ("LongBlob" | "PRF"), and a counter if you want authenticator-counter verification.
- **Recovery data (optional).** `encrypted_data` (base64), `recovery_id` (short UUID), `account_recovery_data_created_timestamp`.

## Registration options

Generate registration options with the PRF extension and a per-request PRF salt:

```ts
import { randomBytes } from "crypto";
import {
  generateRegistrationOptions,
  GenerateRegistrationOptionsOpts,
} from "@simplewebauthn/server";

// Generate a 32-byte random salt, base64url-encoded.
const prfSaltBytes = randomBytes(32);
const prfSaltBase64url = prfSaltBytes
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=/g, "");

const opts: GenerateRegistrationOptionsOpts = {
  rpName,
  rpID,
  userName: username,
  timeout: 60_000,
  attestationType: "none",
  excludeCredentials: [], // Or existing credentials for this user if preventing re-registration
  authenticatorSelection: {
    userVerification: "required",
    requireResidentKey: false, // Server stores credential IDs; no need for discoverable credentials
  },
  supportedAlgorithmIDs: [-7, -257], // ES256, RS256
  extensions: {
    credBlob: true,
    largeBlob: { support: "preferred" },
    prf: { eval: { first: prfSaltBase64url } },
  } as unknown as GenerateRegistrationOptionsOpts["extensions"],
  // ^ Type assertion because the SimpleWebAuthn types don't all include PRF/credBlob/largeBlob yet
};

const options = await generateRegistrationOptions(opts);

// Store the challenge with a short TTL, under a new challengeId UUID.
const challengeId = crypto.randomUUID();
await redis.set(`challenge:${challengeId}`, options.challenge, "EX", 60);

// Return options + challengeId to the client.
return { ...options, challengeId };
```

**Key points:**

- The PRF salt on registration is only used to trigger the extension at credential creation. It does NOT need to be saved server-side (the client will NOT use this salt for authentication-time key derivation — it uses the constant `infoLabel` instead).
- `challengeId` is returned alongside the options so the client can echo it back; this way the server doesn't need session state for the in-progress registration.
- `attestationType: "none"` is the right default for most consumer applications. Use `direct` only if you actually verify attestations (rare in web contexts).

## Registration verification

```ts
import { verifyRegistrationResponse } from "@simplewebauthn/server";

const storedChallenge = await redis.get(`challenge:${challengeId}`);
if (!storedChallenge) throw new Error("Challenge not found or expired");

const verification = await verifyRegistrationResponse({
  response: credential, // RegistrationResponseJSON from the client
  expectedChallenge: storedChallenge,
  expectedOrigin: publicOrigin,
  expectedRPID: rpID,
  requireUserVerification: true,
});

if (!verification.verified) throw new Error("Registration verification failed");

// Inspect client extension results to decide the credential type.
const cer = credential.clientExtensionResults || {};
const hasCredBlob = "credBlob" in cer;
const hasLargeBlobSupport =
  typeof cer.largeBlob === "object" &&
  cer.largeBlob !== null &&
  "supported" in cer.largeBlob &&
  (cer.largeBlob as any).supported === true;
const hasLongBlob = hasCredBlob || hasLargeBlobSupport;

const prfResult = cer.prf;
const hasPRF =
  typeof prfResult === "object" &&
  prfResult !== null &&
  "enabled" in prfResult &&
  (prfResult as any).enabled === true;

if (!hasLongBlob && !hasPRF) {
  throw new Error(
    "Credential must support either LongBlob (credBlob/largeBlob) or PRF extension",
  );
}

const credentialType = hasLongBlob ? "LongBlob" : "PRF";

const info = verification.registrationInfo!;
// Persist the user + credential:
await db.users.create({
  id: crypto.randomUUID(),
  username,
  credentials: [{
    credentialId: info.credential.id, // base64url
    publicKey: Buffer.from(info.credential.publicKey).toString("base64"),
    credentialType,
  }],
});

// One-time challenge — delete after successful verification.
await redis.del(`challenge:${challengeId}`);
```

The `credential.id` from SimpleWebAuthn is already base64url-encoded. Don't re-encode it. Use it directly as a string key in lookups.

## Authentication options

```ts
import {
  generateAuthenticationOptions,
  GenerateAuthenticationOptionsOpts,
} from "@simplewebauthn/server";

// Look up user's credentials by username.
const user = await db.users.getByUsername(username);
if (!user) throw new Error("User not found");

const opts: GenerateAuthenticationOptionsOpts = {
  rpID,
  timeout: 60_000,
  userVerification: "required",
  allowCredentials: user.credentials.map((c) => ({
    id: c.credentialId, // base64url
    // transports field omitted — let the browser/authenticator decide
  })),
};

const options = await generateAuthenticationOptions(opts);

const challengeId = crypto.randomUUID();
await redis.set(`challenge:${challengeId}`, options.challenge, "EX", 60);

return { ...options, challengeId };
```

Notice that PRF is **not** mentioned server-side during authentication. The client injects the PRF extension with its constant `infoLabel`:

```ts
authOptions.extensions = {
  prf: { eval: { first: new TextEncoder().encode(infoLabel) } },
};
```

This is a deliberate design choice: the server cannot redirect a user's derived key to a different address by serving a different salt. The PRF salt used for key derivation lives entirely in the client's code.

## Authentication verification

```ts
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

const storedChallenge = await redis.get(`challenge:${challengeId}`);
if (!storedChallenge) throw new Error("Challenge not found or expired");

// Look up the credential by its ID (base64url).
const credentialId = authResponse.id;
const credential = await db.credentials.getById(credentialId);
if (!credential) throw new Error("Credential not found");

const verification = await verifyAuthenticationResponse({
  response: authResponse,
  expectedChallenge: storedChallenge,
  expectedOrigin: publicOrigin,
  expectedRPID: rpID,
  credential: {
    id: credential.credentialId,
    publicKey: Buffer.from(credential.publicKey, "base64"),
    counter: credential.counter ?? 0,
  },
  requireUserVerification: true,
});

if (!verification.verified) throw new Error("Authentication verification failed");

// Optionally update counter to detect cloned authenticators.
// await db.credentials.updateCounter(credential.id, verification.authenticationInfo.newCounter);

await redis.del(`challenge:${challengeId}`);

// If the accountAddress was supplied in the body, persist it on first login
// (the client derives it from the PRF output).
if (accountAddress && !credential.user.accountAddress) {
  await db.users.updateAccountAddress(credential.userId, accountAddress);
}

// Create a session and return it via an HttpOnly cookie.
const sessionToken = await createSession(credential.userId);
return setSessionCookie(sessionToken).json({ user: ... });
```

## Session management

- Use long-lived (e.g. 1 year) HttpOnly, Secure, SameSite=Lax cookies.
- Store session tokens server-side (Redis keyed by token → user_id) so you can revoke them by deleting the server-side record. Do not use stateless JWTs for this — you need revocation.
- `POST /api/auth/logout` deletes the server-side session record and clears the cookie.
- `GET /api/user` (or equivalent) reads the cookie, validates against Redis, returns `{ session: true, user: ... }` or `{ session: false }`. The iframe calls this on load to restore sessions without requiring a passkey ceremony every time the page opens.

Importantly: **the session alone does NOT unlock the wallet.** The iframe must still run a passkey ceremony to obtain the key. The session just tells the iframe who the user is so it can render the right UI and which credential IDs to allow during the ceremony.

## Rate limits

Protect these endpoints:

- **Registration options:** light limit per IP (10/hour) to prevent registration flooding.
- **Authentication options:** moderate limit per username (20/hour) — enumeration attacks don't really work here (the options contain only credential IDs) but rate limiting prevents account lockout spam.
- **Recovery endpoint:** strict limit per recovery ID (5/hour) — this is where offline passphrase brute force gets real, so slow it down.
- **Waiting list / support:** light limit per IP.

## CORS and origin checks

WebAuthn's `expectedOrigin` check already prevents a malicious site from using your registered credentials. Keep your API routes locked down too:

- Same-origin cookies (no `Access-Control-Allow-Credentials: true` except for known domains).
- Validate the `Origin` header on state-changing requests.

## What NOT to put on the server

- **Private keys.** The whole point.
- **PRF output.** Never logged, never persisted.
- **The `infoLabel`** used for key derivation. Put it in client code only.
- **Session-free "remember me" for wallet unlock.** The unlock state lives in the iframe's memory. Full stop.
