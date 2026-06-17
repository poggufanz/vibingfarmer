/**
 * Platform support detection for WebAuthn PRF.
 *
 * Use `isPlatformSupported()` at registration/login page load to decide whether
 * to allow the user to create a passkey-backed wallet. Returns `false` when the
 * browser/OS combination is known to not support the PRF extension, or when the
 * app is running inside an in-app webview (which generally do not support PRF
 * even on otherwise-supported OSes).
 *
 * Support matrix (early 2026, subject to change):
 *   Chrome / Edge 108+  — all platforms
 *   Firefox 122+        — desktop only (NOT Firefox for Android)
 *   Safari 17+          — macOS 13+, iOS/iPadOS 16+
 *   All webviews        — not supported
 *
 * Fails closed: when the browser can't be identified, returns `false`.
 *
 * Dependency: `npm install bowser`
 */

import Bowser from "bowser";

/**
 * True when the current user agent looks like an in-app webview.
 * Webviews typically do not support the WebAuthn PRF extension even on OSes
 * where the system browser does.
 */
export function isWebview(): boolean {
  if (typeof window === "undefined") return false;

  const ua = window.navigator.userAgent;

  // Android WebView: contains "wv" or "WebView".
  if (/wv|WebView/i.test(ua)) return true;

  // iOS WKWebView: has AppleWebKit but no Safari in the UA.
  if (
    /iPhone|iPad|iPod/.test(ua) &&
    !/Safari/.test(ua) &&
    /AppleWebKit/.test(ua)
  ) {
    return true;
  }

  // Facebook in-app browser.
  if (/FBAN|FBAV/i.test(ua)) return true;

  // Other common in-app browsers.
  if (
    /Instagram|Twitter|LinkedInApp|Line|WeChat|QQBrowser|Telegram/i.test(ua)
  ) {
    return true;
  }

  // Android app webviews with Chromium engine but no Chrome branding.
  if (
    /Android/.test(ua) &&
    !/Chrome/.test(ua) &&
    /Version\/\d+\.\d+/.test(ua)
  ) {
    return true;
  }

  return false;
}

/**
 * True when the current browser/OS is known to support the WebAuthn PRF extension.
 * Fails closed (returns `false`) for unknown platforms.
 *
 * On the server (`typeof window === "undefined"`) returns `true` so SSR doesn't
 * block the page; the client re-checks on mount.
 */
export function isPlatformSupported(): boolean {
  if (typeof window === "undefined") return true;
  if (isWebview()) return false;

  const parser = Bowser.getParser(window.navigator.userAgent);
  const { os } = parser.getResult();

  // Chrome / Edge 108+
  if (parser.satisfies({ chrome: ">=108" })) return true;
  if (parser.satisfies({ edge: ">=108" })) return true;

  // Firefox 122+ — desktop only.
  if (parser.satisfies({ firefox: ">=122" })) {
    return os.name !== "Android";
  }

  // Safari 17+ with OS version requirements.
  if (parser.satisfies({ safari: ">=17" })) {
    if (os.name === "macOS") {
      const minor = parseFloat((os.version ?? "0.0").split(".")[1] ?? "0");
      return minor >= 13;
    }
    if (os.name === "iOS" || os.name === "iPadOS") {
      const major = parseFloat((os.version ?? "0").split(".")[0] ?? "0");
      return major >= 16;
    }
    // Safari on any other OS: not supported.
    return false;
  }

  return false;
}

/**
 * Returns platform info useful for logging / analytics on registration failures.
 */
export function getPlatformInfo(): {
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  userAgent: string;
  isWebview: boolean;
} {
  if (typeof window === "undefined") {
    return {
      browser: "Unknown",
      browserVersion: "0",
      os: "Unknown",
      osVersion: "0",
      userAgent: "",
      isWebview: false,
    };
  }

  const parser = Bowser.getParser(window.navigator.userAgent);
  const r = parser.getResult();
  return {
    browser: r.browser.name ?? "Unknown",
    browserVersion: r.browser.version ?? "0",
    os: r.os.name ?? "Unknown",
    osVersion: r.os.version ?? "0",
    userAgent: window.navigator.userAgent,
    isWebview: isWebview(),
  };
}
