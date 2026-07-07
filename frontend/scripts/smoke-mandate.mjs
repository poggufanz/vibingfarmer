// frontend/scripts/smoke-mandate.mjs
// Live-testnet proof that the PRODUCTION mandate (real passkey owner, real deployed YieldRouter,
// real whitelisted pools) reproduces every scenario spikes/smart-sessions/session-test.mjs proved
// PLUS the two SP0 never tested (over-cap, expired) — see Global Constraints. Run:
//   cd frontend && node scripts/smoke-mandate.mjs
// Requires: frontend dev server running on the URL below (npm run dev), and the env vars in
// docs/deploy-checklist.md set in frontend/.env.local.
//
// `// VERIFY:` this script uses the raw CDP WebAuthn domain (`WebAuthn.enable` /
// `WebAuthn.addVirtualAuthenticator`) via Playwright's `page.context().newCDPSession(page)`,
// which is the lowest-common-denominator approach and should work on any recent Playwright/
// Chromium pairing. If the installed Playwright version exposes a higher-level virtual-
// authenticator helper, prefer that instead — check `node_modules/playwright-core`'s API docs
// for the currently-installed version before assuming this raw-CDP form is still necessary.
import { chromium } from 'playwright'

const APP_URL = process.env.VF_SMOKE_URL || 'http://localhost:5173'
const RESULTS = { scenarios: {} }

async function withVirtualAuthenticator(page, fn) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  })
  try {
    return await fn(cdp, authenticatorId)
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => {})
  }
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  // app.jsx gates EVERY route behind two first-visit localStorage flags (yv_skip_landing at
  // app.jsx:2263, yv_onboarded at app.jsx:2282) — a fresh Playwright profile has neither, so
  // /farm would render the marketing landing instead of CrossChainFarmFlow. Pre-set both.
  await page.addInitScript(() => {
    localStorage.setItem('yv_skip_landing', 'true')
    localStorage.setItem('yv_onboarded', 'true')
    // Emulate a real platform authenticator's algorithm support (Windows Hello / Face ID =
    // ES256, no Ed25519). The CDP virtual authenticator happily honors alg -8, but ZeroDev's
    // register options list [-8, -7] and its toWebAuthnKey imports the credential as P-256 —
    // an Ed25519 pick dies there with an (empty-message) DataError. When ES256 (-7) is offered,
    // drop Ed25519 (-8); SAK's Stellar ceremony offers only -8 and passes through untouched.
    const c = navigator.credentials
    const origCreate = c.create.bind(c)
    c.create = (options) => {
      const params = options?.publicKey?.pubKeyCredParams
      if (Array.isArray(params) && params.some((p) => p.alg === -7)) {
        options.publicKey.pubKeyCredParams = params.filter((p) => p.alg !== -8)
      }
      return origCreate(options)
    }
  })
  await page.goto(`${APP_URL}/farm`)

  await withVirtualAuthenticator(page, async () => {
    // 1) Onboard: register the Stellar passkey + the Base owner passkey (both ceremonies now
    //    complete against the virtual authenticator instead of a human prompt). The real onboard
    //    step (CrossChainFarmFlow STEP.ONBOARD) has no "connect" button — it's an email input
    //    gating a disabled-until-filled "Create passkey wallets" button.
    await page.getByLabel(/email/i).fill('smoke@vibingfarmer.dev')
    await page.getByRole('button', { name: /create.*passkey/i }).click()
    await page.waitForSelector('[data-testid="stellar-wallet-address"]', { timeout: 30_000 })
    await page.waitForSelector('[data-testid="base-account-address"]', { timeout: 30_000 })
    RESULTS.onboarded = true

    // 2) Mandate ceremony: ONE passkey approval covering every whitelisted pool. Real button
    //    label is "Create mandate" (CrossChainFarmFlow STEP.MANDATE); the approval evidence
    //    renders on the farm step once mandate creation completes.
    await page.getByRole('button', { name: /create mandate/i }).click()
    await page.waitForSelector('[data-testid="mandate-serialized-approval"]', { timeout: 60_000 })
    RESULTS.mandateCreated = true

    // 3) In-policy deposit — expect success (mirrors session-test.mjs Test 1).
    await page.getByRole('button', { name: /start farming/i }).click()
    await page.waitForSelector('text=/done/i', { timeout: 120_000 })
    RESULTS.scenarios.inPolicyDeposit = 'PASS'

    // 4-7) Out-of-policy attempts — drive these through a dev-only exposed test hook rather than
    // real UI buttons (there is no "sweep" or "wrong pool" button in the product). `// VERIFY:`
    // wire a small dev-only harness (e.g. `window.__vfDevDispatchRawCall`) that calls
    // reconstructSessionClient + kernelClient.sendUserOperation directly with a deliberately
    // out-of-policy call, gated behind `import.meta.env.DEV`, so this smoke can exercise it
    // without shipping an attacker-usable hook in production.
    const attempt = async (label, callBuilder) => {
      const result = await page.evaluate(callBuilder)
      RESULTS.scenarios[label] = result.executed ? 'FAIL (executed — SECURITY ISSUE)' : 'PASS (blocked)'
    }
    await attempt('wrongSelector', () => window.__vfDevDispatchRawCall({ scenario: 'sweep' }))
    await attempt('wrongTarget', () => window.__vfDevDispatchRawCall({ scenario: 'wrong-target' }))
    await attempt('overCap', () => window.__vfDevDispatchRawCall({ scenario: 'over-cap' }))

    // 'expired' needs a SEPARATELY-issued, already-expired approval — the live mandate this
    // fixture carries is (by construction) not expired, so replaying it through the out-of-policy
    // dispatcher would just execute an in-policy deposit, not prove rejection. Until something
    // wires window.__vfDevMandateFixture.expired (a second, pre-expired approval), skip honestly
    // instead of vacuously passing. See docs/gate-approach-c-e2e.md.
    const hasExpired = await page.evaluate(() => Boolean(window.__vfDevMandateFixture?.expired))
    if (hasExpired) {
      await attempt('expired', () => window.__vfDevDispatchRawCall({ scenario: 'expired' }))
    } else {
      RESULTS.scenarios.expired = 'SKIP (no separately-expired approval wired — see docs/gate-approach-c-e2e.md)'
    }
  })

  await browser.close()

  const scenarioEntries = Object.entries(RESULTS.scenarios)
  const skipped = scenarioEntries.filter(([, v]) => String(v).startsWith('SKIP'))
  const evaluated = scenarioEntries.filter(([, v]) => !String(v).startsWith('SKIP'))
  const gate = evaluated.every(([, v]) => String(v).startsWith('PASS'))

  console.log(JSON.stringify(RESULTS, null, 2))
  if (skipped.length > 0) {
    console.log(`\n${skipped.length} scenario(s) skipped: ${skipped.map(([k]) => k).join(', ')}`)
  }
  console.log(`\nGATE mandate-smoke: ${gate ? 'PASS' : 'FAIL'}${skipped.length ? ` (${skipped.length} skipped)` : ''}`)
  process.exit(gate ? 0 : 1)
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err?.message || err)
  process.exit(1)
})
