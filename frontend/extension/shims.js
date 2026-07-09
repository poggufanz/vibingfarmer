// MV3 extension pages have no Node globals. The classic-wallet dependency chain
// (ed25519-hd-key → create-hmac → readable-stream) reads `process.browser` /
// `process.version` at module scope, so `process` must exist before any other
// module evaluates — this file must stay the FIRST import of every entry that
// touches wallet code.
import { Buffer } from 'buffer'

if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    env: {},
    browser: true,
    version: 'v18.0.0',
    versions: {},
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    stdout: null,
    stderr: null,
  }
}

if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}
