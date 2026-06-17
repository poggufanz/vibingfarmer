# Platform Support for WebAuthn PRF

WebAuthn PRF is a relatively new extension. Before you let a user try to register, confirm their platform can actually use it — otherwise they'll create a passkey that never produces PRF output and they'll be locked out of their own wallet.

## Support Matrix (as of early 2026)

| Platform | Supports PRF? | Minimum version |
| --- | --- | --- |
| Chrome (desktop & Android) | ✅ | 108+ |
| Edge (desktop & Android) | ✅ | 108+ |
| Firefox desktop | ✅ | 122+ |
| Firefox for Android | ❌ | — |
| Safari (macOS) | ✅ | 17+ (on macOS 13+) |
| Safari (iOS / iPadOS) | ✅ | 17+ (on iOS 16+) |
| Safari (other OSes) | ❌ | — |
| iOS WKWebView without Safari | ❌ | — |
| Android WebView | ❌ | — |
| In-app browsers (Facebook, Instagram, Twitter/X, LinkedIn, Telegram, Line, WeChat) | ❌ | — |

These are the checks encoded in `assets/platformSupport.ts`. Update the table when support changes, but **fail closed** — if you can't identify the browser, don't let the user register.

## Why webviews fail

Most webviews are either proxied through an app's internal networking stack (breaking the WebAuthn origin model) or built on older browser engines that haven't picked up the PRF extension. Some in-app browsers have custom prompts that intercept credential creation entirely. Even when the OS has PRF support, the webview doesn't pass the extension through.

**Practical consequence:** users who open your site from inside the Facebook/Instagram/LinkedIn app must be routed to "open in your default browser" before they can register. The `isWebview()` helper flags them.

## Detection code

`assets/platformSupport.ts` bundles the full implementation. The essentials:

```ts
import Bowser from "bowser";

export function isWebview(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;

  // Android WebView typically contains 'wv' or 'WebView'
  if (/wv|WebView/i.test(ua)) return true;

  // iOS WKWebView: has AppleWebKit but no Safari
  if (/iPhone|iPad|iPod/.test(ua) && !/Safari/.test(ua) && /AppleWebKit/.test(ua)) return true;

  // Facebook app
  if (/FBAN|FBAV/i.test(ua)) return true;

  // Known social app patterns
  if (/Instagram|Twitter|LinkedInApp|Line|WeChat|QQBrowser|Telegram/i.test(ua)) return true;

  // Android app webviews often have Version/X.X but no Chrome
  if (/Android/.test(ua) && !/Chrome/.test(ua) && /Version\/\d+\.\d+/.test(ua)) return true;

  return false;
}

export function isPlatformSupported(): boolean {
  if (typeof window === "undefined") return true; // assume; client re-checks
  if (isWebview()) return false;

  const browser = Bowser.getParser(window.navigator.userAgent);
  const { os } = browser.getResult();

  if (browser.satisfies({ chrome: ">=108" })) return true;
  if (browser.satisfies({ edge: ">=108" })) return true;

  if (browser.satisfies({ firefox: ">=122" })) {
    return os.name !== "Android"; // Firefox for Android does not support PRF
  }

  if (browser.satisfies({ safari: ">=17" })) {
    if (os.name === "macOS") {
      const minor = parseFloat((os.version ?? "0.0").split(".")[1] ?? "0");
      return minor >= 13;
    }
    if (os.name === "iOS" || os.name === "iPadOS") {
      const major = parseFloat((os.version ?? "0").split(".")[0] ?? "0");
      return major >= 16;
    }
    return false;
  }

  return false;
}
```

## How to use the result

1. **On the registration page**, call `isPlatformSupported()` on mount. If false, render a waiting-list UI and block the "Create Passkey" button entirely. Capture user contact info so you can email them when they try again from a supported browser.

2. **Gracefully handle the "supported but doesn't work" case.** Even on supported platforms, some users have authenticators that report `clientExtensionResults.prf.enabled === false` or omit results during authentication. This is usually because they selected a password manager that doesn't support PRF yet (1Password, some LastPass versions, some Bitwarden versions). Wait for `navigator.credentials.create()` to return, inspect the client extension results, and if PRF is missing/disabled, explain that they need to use a different authenticator (hardware key, built-in platform authenticator, or a different password manager) and record a registration failure for analytics.

3. **Log platform info on failures.** When a registration attempt fails, capture `userAgent`, `browser.name`, `browser.version`, `os.name`, `os.version`. PRF support shifts quickly and you'll want to know when new platforms start working (or regress).

## Feature detection vs. version detection

In an ideal world you'd feature-detect rather than sniff user agents. Unfortunately WebAuthn doesn't expose a pre-ceremony "does this credential support PRF?" check — the only way to find out is to create a credential and look at the results. You can do that, but it means the user has already pressed "Create Passkey" and given biometrics before you can tell them it won't work.

So: **use UA-based gating to filter out known-bad platforms up front**, then use `clientExtensionResults.prf.enabled` as the authoritative post-ceremony check for the edge cases that slipped through.

If you want to do a best-effort availability check, these help but are not conclusive:

```ts
// Is a platform authenticator available at all?
const hasPlatformAuth =
  await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.();

// Is conditional mediation (passkey autofill) supported?
const hasConditional =
  await PublicKeyCredential.isConditionalMediationAvailable?.();
```

Neither of these tells you about PRF specifically.

## Updating the matrix

When you want to add or remove a platform, the single source of truth is `assets/platformSupport.ts`. The MDN compatibility page for [PublicKeyCredentialRequestOptions.extensions.prf](https://developer.mozilla.org/en-US/docs/Web/API/CredentialsContainer/get#prf) is the best outside reference — but always verify with a physical device on the new version before removing a negative check, because browser support pages lag reality by weeks.
