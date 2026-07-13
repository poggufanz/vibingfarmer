import { chromium } from 'playwright'

const url = process.env.VF_SMOKE_URL || 'http://localhost:5173'
const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(6, ' ')
const log = []
const noise = /\/node_modules\/|\/src\/|\/@|\.css|favicon|\.svg|\.woff/

const browser = await chromium.launch()
const page = await browser.newPage()
await page.addInitScript(() => {
  localStorage.setItem('yv_skip_landing', 'true')
  localStorage.setItem('yv_onboarded', 'true')
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
page.on('response', async (res) => {
  if (noise.test(res.url())) return
  if (res.status() >= 400 || /vf-cross|stellar-relay/.test(res.url())) {
    let body = ''
    try {
      body = (await res.text()).slice(0, 250)
    } catch {}
    log.push(`${ms()} < ${res.status()} ${res.url().slice(0, 110)} :: ${body}`)
  }
})
page.on('pageerror', (e) => log.push(`${ms()} ! ${String(e).slice(0, 200)}`))

const cdp = await page.context().newCDPSession(page)
await cdp.send('WebAuthn.enable')
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
  },
})

await page.goto(url + '/farm')
await page.getByLabel(/email/i).fill('smoke@vibingfarmer.dev')
await page.getByRole('button', { name: /create.*passkey/i }).click()
await page.waitForSelector('[data-testid="stellar-wallet-address"]', { timeout: 60_000 })
const stellarAddr = await page.locator('[data-testid="stellar-wallet-address"]').innerText()
log.push(`${ms()} STELLAR ${stellarAddr}`)

// Keep the burn small: 2 USDC across 2 pools (SMOKE treasury holds ~20 Circle USDC).
await page.getByLabel(/amount/i).fill('2')

// Fund the fresh wallet with 3 Circle USDC (7dp SAC) BEFORE farming — a new passkey wallet
// holds nothing to burn.
const { execFileSync } = await import('node:child_process')
const fundOut = execFileSync(
  process.execPath,
  ['--env-file=.dev.vars', '.fund-usdc.tmp.mjs', stellarAddr, String(3n * 10n ** 7n)],
  { cwd: '../relayer', encoding: 'utf8' }
)
log.push(`${ms()} FUND ${fundOut.trim()}`)

await page.getByRole('button', { name: /create mandate/i }).click()
await page.waitForSelector('[data-testid="mandate-serialized-approval"]', { timeout: 90_000 })
log.push(`${ms()} MANDATE ok`)
await page.getByRole('button', { name: /start farming/i }).click()

for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(15_000)
  const status = await page.locator('.farm-status').innerText().catch(() => null)
  const errEl = await page
    .locator('.farm-error, [role="alert"], .cross-chain-farm-flow-error')
    .allInnerTexts()
    .catch(() => [])
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 250)
  log.push(`${ms()} @ status=${JSON.stringify(status)} err=${JSON.stringify(errEl)} body="${body.slice(120, 250)}"`)
  if (status === 'done' || errEl.length) break
}
console.log(log.join('\n'))
await browser.close()
