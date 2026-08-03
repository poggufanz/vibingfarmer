// frontend/src/strategy/autoExit/exitKey.test.js
//
// Pocket Crew "My money" Task 10 removed the AUTONOMOUS auto-exit path (this directory's own
// engine.js/rules.js/triggers.js, agents/exitExecutor.js, and components/AutoExitSettings.jsx —
// all deleted). This leftover test file is NOT deleted with them, because the functions it
// exercises in wallet/exitKey.js split into two groups with two very different fates:
//
//   - `generateExitKey` and `registerExitSigner` are SHARED with the still-live MANUAL
//     partial-withdraw flow: stellar/partialWithdraw.js's `ensureExitSigner` imports both as its
//     own defaults (`_generateExitKey`, `_registerExitSigner`) to mint and register a fresh
//     owner-scoped v2 exit signer. Deleting either from wallet/exitKey.js would break manual
//     partial withdraw, not just the removed autonomous path — labeled here so a future cleanup
//     never mistakes them for dead auto-exit code.
//   - `saveExitKey`/`loadExitKey`/`clearExitKey` are the LEGACY agent-only-keyed cache
//     (`yv_exit_key_<agent>`). Task 10 deleted their only production callers (AutoExitSettings.jsx,
//     exitExecutor.js), so nothing in the app writes or reads that cache anymore — it is inspected
//     (never auto-deleted) by money/legacyAutoExit.js and surfaced under Settings → Data & Privacy
//     → "Legacy auto-exit data" (components/settings/LegacyAutoExitCleanup.jsx). They stay in
//     wallet/exitKey.js (out of this task's file list) and stay tested here for back-compat
//     coverage of that inspector's expectations, not because anything still calls them.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  generateExitKey,
  registerExitSigner,
  saveExitKey,
  loadExitKey,
  clearExitKey,
} from '../../wallet/exitKey.js'

const store = {}
beforeEach(() => {
  for (const k in store) delete store[k]
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = v
    },
    removeItem: (k) => {
      delete store[k]
    },
  }
})

describe('Exit Key Management', () => {
  it('generates a random ed25519 keypair', async () => {
    const key = await generateExitKey()
    expect(key.publicKey).toBeDefined()
    expect(key.secret).toBeDefined()
  })

  it('saves, loads, and clears the exit key correctly', () => {
    const key = { publicKey: 'GEXIT', secret: 'SEXIT' }
    saveExitKey('CAGENT', key)

    const loaded = loadExitKey('CAGENT')
    expect(loaded).toEqual(key)

    clearExitKey('CAGENT')
    expect(loadExitKey('CAGENT')).toBeNull()
  })
})

describe('generateExitKey / registerExitSigner — still load-bearing for manual partial withdraw', () => {
  it('are real exports of wallet/exitKey.js, the exact module stellar/partialWithdraw.js imports its defaults from', async () => {
    // Tripwire, not a duplicate of partialWithdraw.test.js's own coverage: this only proves the
    // two functions manual withdraw depends on still exist on this module, so a future cleanup
    // that assumes "auto-exit was deleted, so wallet/exitKey.js's exit-signer helpers must be dead
    // too" fails loudly here instead of silently breaking partial withdraw.
    expect(typeof generateExitKey).toBe('function')
    expect(typeof registerExitSigner).toBe('function')
    const partialWithdrawModule = await import('../../stellar/partialWithdraw.js')
    expect(typeof partialWithdrawModule.ensureExitSigner).toBe('function')
  })
})
