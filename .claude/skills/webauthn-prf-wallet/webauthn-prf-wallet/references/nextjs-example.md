# Next.js + @simplewebauthn Reference Implementation

A concrete, minimal implementation of the webauthn-prf-wallet pattern using Next.js (App Router), `@simplewebauthn/server` + `@simplewebauthn/browser`, Redis for challenges, and Postmate for iframe RPC. This mirrors the approach in the 1Shot Payments codebase, stripped down to what you need to get started.

```
src/
├── app/
│   ├── api/
│   │   └── auth/
│   │       ├── register/route.ts
│   │       ├── login/route.ts
│   │       └── logout/route.ts
│   └── wallet/
│       └── local/
│           └── page.tsx
├── clientUtils/
│   ├── ClientCrypto.ts       # prfToValidEthPrivKey + AES helpers (see assets/)
│   ├── platformSupport.ts    # isPlatformSupported, isWebview (see assets/)
│   ├── WalletFrame.ts        # Child-side helper
│   ├── WalletProxy.ts        # Parent-side RPC client
│   └── ProxyTypes.ts         # Shared RPC types
└── components/
    ├── AuthProvider.tsx
    ├── LoginButton.tsx
    └── Register.tsx
```

## Shared constant

Define your `infoLabel` in exactly one place. This is the forever-string:

```ts
// src/clientUtils/constants.ts
export const ETH_KEY_DERIVATION_LABEL = "com.example.eth-key-v1";
```

## The iframe page

```tsx
// src/app/wallet/local/page.tsx
"use client";

import Postmate from "postmate";
import { useEffect } from "react";

import { WalletFrame } from "@/clientUtils/WalletFrame";

let walletFrame: WalletFrame | null = null;

function initialize() {
  if (typeof window === "undefined") return;
  if (walletFrame) return;

  const model = new Postmate.Model({
    getStatus: async (paramString) => {
      walletFrame!.rpcWrapper(paramString, () => walletFrame!.getStatus());
    },
    signIn: async (paramString) => {
      walletFrame!.rpcWrapper(paramString, ({ username }) => {
        return walletFrame!.authenticateWithPasskey(username);
      });
    },
    getAccountAddress: async (paramString) => {
      walletFrame!.rpcWrapper(paramString, () => walletFrame!.getAccountAddress());
    },
    signMessage: async (paramString) => {
      walletFrame!.rpcWrapper(paramString, ({ message }) => {
        return walletFrame!.assureWallet().andThen((wallet) =>
          ResultAsync.fromPromise(wallet.signMessage(message), (e) => e as Error),
        );
      });
    },
    signOut: async (paramString) => {
      walletFrame!.rpcWrapper(paramString, () => {
        walletFrame!.clearAuthResult();
        return okAsync({});
      });
    },
  });

  walletFrame = new WalletFrame(model);
}

if (typeof window !== "undefined") initialize();

export default function WalletLocalPage() {
  useEffect(() => {
    if (!walletFrame) initialize();
  }, []);
  return <div style={{ display: "none" }} />;
}
```

This page has no UI, minimal imports, and never exposes the private key. All behavior runs through `walletFrame.rpcWrapper`.

## The `WalletFrame` helper (iframe-side)

Long to inline here; see `assets/WalletIframeSketch.ts` for a working template. The critical method:

```ts
public authenticateWithPasskey(username: string): ResultAsync<IFullAuthResult, Error> {
  // 1. Fetch authentication options from server
  return this.fetchJson<PublicKeyCredentialRequestOptionsJSON & { challengeId: string }>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ username }) },
  )
    .andThen((authOptions) => {
      // 2. Inject PRF extension client-side
      const infoLabel = new TextEncoder().encode(ETH_KEY_DERIVATION_LABEL);
      authOptions.extensions = {
        ...authOptions.extensions,
        prf: { eval: { first: infoLabel } },
      };

      // 3. Start the authentication ceremony
      return ResultAsync.fromPromise(
        startAuthentication({ optionsJSON: authOptions }),
        (e) => e as Error,
      ).andThen((credential) => {
        const prfOutput = (credential.clientExtensionResults as any)
          ?.prf?.results?.first as ArrayBuffer | undefined;

        if (!prfOutput) {
          return errAsync(new Error("PRF not available on this passkey"));
        }

        // 4. Derive the Ethereum private key
        return ResultAsync.fromPromise(
          prfToValidEthPrivKey(prfOutput, infoLabel),
          (e) => e as Error,
        ).andThen((privateKey) => {
          const wallet = new Wallet(privateKey);

          // 5. Verify the authentication with the server
          return this.fetchJson<{ user: UserModel }>("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({
              credential,
              challengeId: authOptions.challengeId,
              accountAddress: wallet.address,
            }),
          }).map((result) => {
            this.authResult = {
              success: true,
              user: result.user,
              walletUnlocked: true,
              wallet,
            };
            return this.authResult;
          });
        });
      });
    });
}
```

Full version in the 1Shot codebase is at `src/clientUtils/WalletUtils.ts`.

## The `WalletProxy` (parent-side)

```ts
// src/clientUtils/WalletProxy.ts
import Postmate from "postmate";
import { ResultAsync } from "neverthrow";

import { prepareIframeForWebAuthn } from "./prepareIframeForWebAuthn";

export class WalletProxy {
  private child: Postmate.ParentAPI | null = null;
  private rpcNonce = 0;
  private rpcCallbacks = new Map<number, (result: any) => void>();

  initialize(containerId: string, walletUrl: string): ResultAsync<void, Error> {
    const handshake = new Postmate({
      container: document.getElementById(containerId),
      url: walletUrl, // e.g. "/wallet/local"
      name: "wallet-iframe",
    });

    return ResultAsync.fromPromise(handshake, (e) => e as Error).map((child) => {
      this.child = child;

      // Attach WebAuthn permissions
      if (child.frame instanceof HTMLIFrameElement) {
        child.frame.setAttribute(
          "allow",
          "publickey-credentials-get publickey-credentials-create",
        );
      }

      // Listen for RPC responses
      child.on("rpc:callback", (data: string) => {
        const parsed = JSON.parse(data);
        const cb = this.rpcCallbacks.get(parsed.callbackNonce);
        if (cb) {
          this.rpcCallbacks.delete(parsed.callbackNonce);
          cb(parsed);
        }
      });
    });
  }

  signIn(username: string) {
    return this.rpcCall("signIn", { username });
  }

  signMessage(message: string) {
    return this.rpcCall<string, { message: string }>("signMessage", { message });
  }

  getAccountAddress() {
    return this.rpcCall<{ accountAddress: string }, {}>("getAccountAddress", {});
  }

  signOut() {
    return this.rpcCall("signOut", {});
  }

  private rpcCall<TReturn, TParams>(name: string, params: TParams): ResultAsync<TReturn, Error> {
    if (!this.child) return errAsync(new Error("Not initialized"));

    // Preserve user activation for iframe WebAuthn
    const { restore } = prepareIframeForWebAuthn(this.child.frame);

    return ResultAsync.fromPromise(
      new Promise<TReturn>((resolve, reject) => {
        const nonce = this.rpcNonce++;
        this.rpcCallbacks.set(nonce, (result) => {
          if (!result.success) reject(new Error(result.result));
          else resolve(JSON.parse(result.result));
        });
        this.child!.call(name, JSON.stringify({ callbackNonce: nonce, params }));
      }),
      (e) => e as Error,
    ).map((result) => {
      restore();
      return result;
    });
  }
}
```

## The registration component (parent page)

Registration happens in the **parent** page (not the iframe) because it's the natural flow — the user clicks a "Create Passkey" button, we run `navigator.credentials.create()` right there, then hand off to the iframe for the first sign-in.

```tsx
// src/components/Register.tsx
"use client";

import { base64URLStringToBuffer } from "@simplewebauthn/browser";
import { Wallet } from "ethers";
import { useState } from "react";

import { ETH_KEY_DERIVATION_LABEL } from "@/clientUtils/constants";
import { isPlatformSupported } from "@/clientUtils/platformSupport";
import { useWalletProxy } from "@/components/AuthProvider";

export function Register({ username }: { username: string }) {
  const walletProxy = useWalletProxy();
  const [error, setError] = useState<string | null>(null);

  if (!isPlatformSupported()) {
    return <p>Your browser doesn't support passkey-based wallets.</p>;
  }

  const handleRegister = async () => {
    // 1. Get registration options
    const options = await fetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username }),
    }).then((r) => r.json());

    // 2. Generate a random EVM private key (used only if LongBlob works)
    const registrationWallet = Wallet.createRandom();
    const privateKeyBytes = new Uint8Array(
      (registrationWallet.privateKey.slice(2).match(/.{1,2}/g) || []).map(
        (b) => parseInt(b, 16),
      ),
    );

    // 3. Build extensions — decode PRF salt from base64url to ArrayBuffer
    const prfSaltB64url = options.extensions?.prf?.eval?.first as string | undefined;
    const extensions: any = {
      credBlob: privateKeyBytes,
      largeBlob: { support: "preferred" },
    };
    if (prfSaltB64url) {
      extensions.prf = { eval: { first: base64URLStringToBuffer(prfSaltB64url) } };
    }

    // 4. Create the credential
    const credential = (await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: base64URLStringToBuffer(options.challenge),
        user: { ...options.user, id: base64URLStringToBuffer(options.user.id) },
        excludeCredentials: options.excludeCredentials?.map((c: any) => ({
          ...c,
          id: base64URLStringToBuffer(c.id),
        })),
        extensions,
      },
    })) as PublicKeyCredential;

    const cer = credential.getClientExtensionResults() as Record<string, unknown>;
    const hasLongBlob =
      "credBlob" in cer ||
      (typeof cer.largeBlob === "object" &&
        cer.largeBlob !== null &&
        (cer.largeBlob as any).supported === true);
    const hasPRF =
      typeof cer.prf === "object" &&
      cer.prf !== null &&
      (cer.prf as any).enabled === true;

    if (!hasLongBlob && !hasPRF) {
      setError("Your passkey provider doesn't support wallet features.");
      return;
    }

    // 5. Send to server for verification
    await fetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        credential: {
          id: bufferToBase64URL(credential.rawId),
          rawId: bufferToBase64URL(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: bufferToBase64URL(
              (credential.response as any).clientDataJSON,
            ),
            attestationObject: bufferToBase64URL(
              (credential.response as any).attestationObject,
            ),
          },
          clientExtensionResults: cer,
        },
        challengeId: options.challengeId,
        username,
      }),
    });

    // 6. Sign in via the iframe for the first time
    await walletProxy.signIn(username);
  };

  return (
    <>
      <button onClick={handleRegister}>Create Passkey</button>
      {error && <p>{error}</p>}
    </>
  );
}
```

**Why registration lives in the parent, not the iframe:** `navigator.credentials.create()` needs to run in the context that has the user activation from the button click, and it's OK for the parent to hold the random private key momentarily (it's used only for credBlob storage then discarded — the "real" wallet comes from the iframe's later authentication via PRF or credBlob read).

Some teams prefer to do registration in the iframe as well. Either works; the parent-side approach is simpler.

## The `AuthProvider`

```tsx
// src/components/AuthProvider.tsx
"use client";

import { createContext, useContext, useEffect, useState } from "react";

import { WalletProxy } from "@/clientUtils/WalletProxy";

const WalletProxyContext = createContext<WalletProxy | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [proxy, setProxy] = useState<WalletProxy | null>(null);

  useEffect(() => {
    const container = document.createElement("div");
    container.id = "wallet-iframe-container";
    container.className = "hidden";
    document.body.appendChild(container);

    const p = new WalletProxy();
    p.initialize("wallet-iframe-container", "/wallet/local")
      .map(() => setProxy(p));

    return () => {
      container.remove();
    };
  }, []);

  return (
    <WalletProxyContext.Provider value={proxy}>
      {children}
    </WalletProxyContext.Provider>
  );
}

export function useWalletProxy() {
  const proxy = useContext(WalletProxyContext);
  if (!proxy) throw new Error("WalletProxy not ready");
  return proxy;
}
```

The container uses Tailwind's `.hidden` (which applies `display: none`). The `WalletProxy` overrides this with `!important` only while WebAuthn ceremonies are in progress.

## Route handlers

### `/api/auth/register`

```ts
// src/app/api/auth/register/route.ts
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { randomBytes, randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { redis } from "@/lib/redis";
import { db } from "@/lib/db";

const rpID = process.env.RP_ID!;
const rpName = process.env.RP_NAME!;
const publicOrigin = process.env.PUBLIC_ORIGIN!;

export async function POST(req: NextRequest) {
  const body = await req.json();

  // No credential? Generate options.
  if (!body.credential) {
    const { username } = body;
    if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });

    const prfSalt = randomBytes(32).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: username,
      timeout: 60_000,
      attestationType: "none",
      excludeCredentials: [],
      authenticatorSelection: { userVerification: "required", requireResidentKey: false },
      supportedAlgorithmIDs: [-7, -257],
      extensions: {
        credBlob: true,
        largeBlob: { support: "preferred" },
        prf: { eval: { first: prfSalt } },
      } as any,
    });

    const challengeId = randomUUID();
    await redis.set(`challenge:${challengeId}`, options.challenge, "EX", 60);

    return NextResponse.json({ ...options, challengeId });
  }

  // Credential present? Verify.
  const { credential, challengeId, username } = body;
  const storedChallenge = await redis.get(`challenge:${challengeId}`);
  if (!storedChallenge) return NextResponse.json({ error: "challenge expired" }, { status: 400 });

  const verification = await verifyRegistrationResponse({
    response: credential,
    expectedChallenge: storedChallenge,
    expectedOrigin: publicOrigin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified) {
    return NextResponse.json({ error: "verification failed" }, { status: 400 });
  }

  // Decide credential type (LongBlob vs PRF)
  const cer = credential.clientExtensionResults || {};
  const hasLongBlob = "credBlob" in cer ||
    (typeof cer.largeBlob === "object" && (cer.largeBlob as any)?.supported === true);
  const hasPRF = typeof cer.prf === "object" && (cer.prf as any)?.enabled === true;
  if (!hasLongBlob && !hasPRF) {
    return NextResponse.json({ error: "passkey supports neither LongBlob nor PRF" }, { status: 400 });
  }
  const credentialType = hasLongBlob ? "LongBlob" : "PRF";

  const info = verification.registrationInfo!;
  const user = await db.users.create({
    id: randomUUID(),
    username,
    credentials: [{
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString("base64"),
      credentialType,
    }],
  });

  await redis.del(`challenge:${challengeId}`);
  return NextResponse.json({ user });
}
```

### `/api/auth/login`

Structurally identical shape (options if no credential, verify if credential present). See `references/server-integration.md` for the full body.

### `/api/auth/logout`

```ts
export async function POST(req: NextRequest) {
  const sessionToken = req.cookies.get("sessionToken")?.value;
  if (sessionToken) await redis.del(`session:${sessionToken}`);
  const res = NextResponse.json({ success: true });
  res.cookies.delete("sessionToken");
  return res;
}
```

## Next.js config tweaks

- **Headers.** Add response headers to the wallet iframe page to prevent third-party embedding:
  ```ts
  // next.config.ts
  async headers() {
    return [
      {
        source: "/wallet/local",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self';" },
        ],
      },
    ];
  }
  ```
- **Don't bundle the server-only RP library into the iframe.** The iframe page should import only `@simplewebauthn/browser`, not `@simplewebauthn/server`. If you accidentally import a server module from a client component, Next.js will pull it into the client bundle and your iframe becomes much heavier. `madge`-based dependency audits are a good periodic check.

## Putting it together

1. Copy `assets/prfToValidEthPrivKey.ts` and `assets/platformSupport.ts` into `src/clientUtils/`.
2. Copy `assets/WalletIframeSketch.ts` into `src/clientUtils/WalletFrame.ts` and adapt.
3. Create the three auth routes above.
4. Wrap your root layout in `<AuthProvider>`.
5. Build your UI using `useWalletProxy()` to call `signIn`, `signMessage`, etc.
6. Add a recovery flow before launch.
