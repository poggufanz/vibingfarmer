# Iframe Isolation for Wallet Operations

The derived private key must never be reachable from the parent page's JavaScript. This reference walks through the isolation pattern, the cross-frame RPC mechanics, and the non-obvious gotchas that break WebAuthn inside iframes.

## Why isolate at all

A modern web app has a large attack surface:

- Dozens to hundreds of npm dependencies, any of which could be compromised (supply chain).
- Third-party scripts (analytics, error reporting, A/B testing) with DOM and global access.
- XSS via user-generated content, markdown rendering, or careless `innerHTML`.

If the wallet's private key lives in the main app's JS context, any of the above is a potential leak. The iframe pattern shrinks the attack surface dramatically:

- The iframe page can import a tiny, audit-able set of dependencies (WebAuthn + key derivation + a signing library + Postmate).
- Even total XSS in the parent cannot read variables inside the iframe; the same-origin policy between siblings applies.
- The only data that crosses the boundary is whatever you deliberately expose through the RPC — signatures, the account address, never the key.

## Architecture

```
┌────────────────────────────── Main App ────────────────────────────────┐
│                                                                        │
│   AuthContext ──► WalletProxy ──► postMessage ──► [wallet iframe]     │
│                       ▲                                  │             │
│                       └─── signatures, addresses ◄───────┘             │
│                                                                        │
│   (hundreds of dependencies, third-party scripts, etc.)                │
└────────────────────────────────────────────────────────────────────────┘
```

The iframe loads a dedicated route (e.g. `/wallet/local`) that renders a Postmate Model. That page's dependency graph is kept minimal — the build should only pull in the WebAuthn helpers, your key derivation, and the signing primitives you need.

## Postmate crash course

[Postmate](https://github.com/dollarshaveclub/postmate) is a small wrapper over `postMessage`. It does two things well:

1. **Handshake.** Parent and child perform a short handshake on load so both know they're talking to the right iframe.
2. **Typed RPC.** The child registers a `Model` — an object of method names → handlers. The parent gets a `ChildAPI` handle and calls `child.call("methodName", params)`. Postmate serializes params via `postMessage`.

Minimal example, parent side:

```ts
import Postmate from "postmate";

const handshake = new Postmate({
  container: document.getElementById("wallet-container"),
  url: "/wallet/local",
  name: "wallet-iframe",
});

handshake.then((child) => {
  child.frame.setAttribute(
    "allow",
    "publickey-credentials-get publickey-credentials-create",
  );
  child.call("getStatus", {});
});
```

Child side (`/wallet/local/page.tsx`):

```ts
import Postmate from "postmate";

new Postmate.Model({
  getStatus: async () => {
    return { session: false };
  },
  signIn: async (params) => {
    // run passkey ceremony, derive key, reply with result
  },
});
```

## Request / response pattern

Postmate's `Model` methods don't have return values — they're fire-and-forget. To get a response back, use an event + nonce pattern. 1Shot's `rpcWrapper` on the child side looks like this:

```ts
async rpcWrapper<T, TReturn>(
  paramString: JSONString,
  callback: (params: T) => ResultAsync<TReturn, Error>,
): Promise<void> {
  const parent = await this.getInitialized();
  const { callbackNonce, params } = deserialize<{ callbackNonce: number; params: T }>(paramString);

  callback(params)
    .map((result) => {
      parent.emit("rpc:callback", serialize({
        success: true,
        callbackNonce,
        result: serialize(result),
      }));
    })
    .mapErr((e) => {
      parent.emit("rpc:callback", serialize({
        success: false,
        callbackNonce,
        result: serialize(e),
      }));
    });
}
```

And on the parent side, each outgoing call registers a callback in a Map keyed by nonce, and a single `rpc:callback` listener resolves the right Promise:

```ts
protected rpcCall<TReturn, TParams>(
  eventName: string,
  params: TParams,
): ResultAsync<TReturn, ProxyError> {
  return ResultAsync.fromPromise(
    new Promise<TReturn>((resolve, reject) => {
      const callbackNonce = this.rpcNonce++;
      this.rpcCallbacks.set(callbackNonce, (result) => {
        if (!result.success) reject(deserialize(result.result));
        else resolve(deserialize(result.result));
      });
      this.child!.call(eventName, serialize({ eventName, callbackNonce, params }));
    }),
    (e) => ProxyError.fromError(e as Error),
  );
}
```

This is a thin but important pattern: with only one Postmate `emit` channel, all method responses multiplex through it. Every call gets a fresh nonce; errors and successes use the same envelope.

## The `allow` attribute is mandatory

```ts
child.frame.setAttribute(
  "allow",
  "publickey-credentials-get publickey-credentials-create",
);
```

Without these permissions, `navigator.credentials.get()` / `create()` inside the iframe silently fails or throws `NotAllowedError`. Browsers differ in exact behavior; the fix is always the same. Set this immediately after the Postmate handshake resolves, before you try to make any RPC calls that touch WebAuthn.

## The "invisible but not display:none" requirement

This is the single most confusing gotcha. WebAuthn in iframes in several browsers (notably Safari, Firefox, and sometimes Chrome under specific DOM configurations) will refuse to show the passkey prompt when the iframe or any of its ancestors has `display: none`.

You probably want your wallet iframe hidden most of the time. Tailwind's `hidden` class, for example, sets `display: none`. So you need to temporarily make it "visible" (but not actually shown to the user) right before the ceremony, and restore afterwards.

The pattern 1Shot uses in `WalletProxy.prepareIframeForWebAuthn()`:

```ts
private prepareIframeForWebAuthn(): { restore: () => void } {
  const frame = this.child?.frame as HTMLIFrameElement;
  const container = frame.parentElement;

  // Snapshot original state
  const originalClasses = frame.className;
  const originalStyle = { display: frame.style.display, /* ... */ };

  // Make the container actually rendered
  container?.classList.remove("hidden");
  container?.style.setProperty("display", "block", "important");
  container?.style.setProperty("position", "fixed", "important");
  container?.style.setProperty("width", "1px", "important");
  container?.style.setProperty("height", "1px", "important");
  container?.style.setProperty("opacity", "0", "important");
  container?.style.setProperty("z-index", "-1", "important");
  container?.style.setProperty("pointer-events", "none", "important");

  // Same treatment for the iframe itself
  frame.classList.remove("hidden");
  frame.style.display = "block";
  frame.style.width = "1px";
  frame.style.height = "1px";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.style.zIndex = "-1";

  // Preserve user activation by focusing
  frame.contentWindow?.focus();
  frame.focus();

  return {
    restore: () => {
      container?.classList.add("hidden");
      // restore all the style properties we cleared
      frame.className = originalClasses;
      frame.style.display = originalStyle.display;
      // ...
    },
  };
}
```

Key properties:

- `opacity: 0` and `width/height: 1px` make the iframe invisible and tiny.
- `pointer-events: none` prevents it from intercepting clicks during the brief moment it's "visible."
- `!important` on container styles is needed to override utility classes like Tailwind's `.hidden { display: none !important }`.
- **Focus the `contentWindow` first, then the frame element.** This is what preserves user activation across the `postMessage` boundary in Safari.
- Restore state **after** the RPC response comes back, not synchronously. If you restore too early, Safari may cancel the in-progress prompt.

## User activation must survive the hop

WebAuthn requires transient user activation (the user recently clicked/tapped). When the user clicks "Sign In," the activation is consumed by the click handler. The iframe only has activation if you pass it through correctly:

- **Call `this.child.call(eventName, ...)` synchronously inside the click handler.** Any `await` that yields to the microtask queue between the click and the Postmate call risks losing activation.
- **Focus the iframe as part of the visibility setup.** This hints to the browser that the iframe is the active document.
- **If your UI needs a confirmation step before signing**, don't async-await a user confirmation modal between the click and the ceremony. Instead, make the confirmation itself be the click that triggers the ceremony.

The `navigator.userActivation.isActive` boolean in the iframe will be `true` if everything is correct. Log it on the first debug build:

```ts
console.debug("userActivation.isActive:", navigator.userActivation.isActive);
```

If it's `false`, the user will see "NotAllowedError" and no prompt.

## Minimizing iframe dependencies

The iframe is only as hardened as its dependency graph. Audit what gets imported:

```
# from the iframe route, list all transitive imports
npx madge --extensions ts,tsx src/app/wallet/local/page.tsx --summary
```

Legitimate reasons to import into the iframe:

- `@simplewebauthn/browser` for `startAuthentication` helper.
- `ethers` or `viem` for signing and wallet construction.
- Your own key derivation code (`ClientCrypto.ts` equivalent).
- Postmate.

Red flags:

- UI libraries (if your iframe must render a confirmation UI, see below).
- Analytics.
- Anything that does network calls to third-party domains.

If the iframe does need a UI (e.g. for transaction confirmation in the external-integration use case), keep that UI's dependencies separate from the signing path — the key derivation and private-key access should not depend on having a rendered component.

## Same-origin vs third-party iframes

1Shot Payments distinguishes two iframe routes:

- `/wallet/local` — same-origin only. Response has `X-Frame-Options: SAMEORIGIN`. Used by the main 1Shot Payments app.
- `/wallet` — allowed to be embedded in third-party sites. Has extra UI for explicit user approval of each signature request (since the third-party site is untrusted). Documented separately and published through the integration SDK.

If you're building a standalone product, you only need `/wallet/local`. Set the HTTP response header `X-Frame-Options: SAMEORIGIN` and a CSP `frame-ancestors 'self'` so no one can embed your wallet in a malicious page.

## Security checklist

- [ ] Iframe URL is same-origin.
- [ ] Response has `X-Frame-Options: SAMEORIGIN` and CSP `frame-ancestors 'self'`.
- [ ] Iframe `allow` attribute includes both `publickey-credentials-get` and `publickey-credentials-create`.
- [ ] `navigator.userActivation.isActive` is `true` inside the iframe when the ceremony starts.
- [ ] The iframe's ancestor chain is not `display: none` during the ceremony.
- [ ] Wallet is cached only in iframe closure state, never posted to the parent.
- [ ] Parent receives only `{ success, user, walletUnlocked }` — never the key.
- [ ] RPC messages are validated with Postmate's origin checking; production code must not skip origin checks.
- [ ] Logout clears the cached wallet (`walletFrame.clearAuthResult()`), forcing the next operation to trigger a fresh passkey ceremony.
