// Live-testnet proof of the gasless agent deposit. Runs a real session-key-signed deposit
// through the relay (production assemblers) and asserts the vault share balance rose AT THE
// EXCHANGE RATE — post-cutover the target is the autofarm vault, so minted shares are
// amount × 1e7 / price_per_share, NOT 1:1.
// Run: node scripts/stellar-deposit-smoke.mjs  (NOT part of vitest run; needs DEMO_AGENT_SECRET)
// DEMO_AGENT_SECRET is loaded from the gitignored frontend/.env (or pass it inline in the env).
// Headless runs also need VF_RELAY_URL pointing at a running dev server's relay endpoint.
import 'dotenv/config'

// Headless node fetch sends no Origin → api/_guard.js applyCors 403s the relay call. Forge the
// dev origin on RELAY calls only (browser-enforced header; same harness seam the wallet
// m-smokes use). Everything else (Soroban RPC) passes through untouched — wrapping those
// mangles the SDK's Headers instances.
const realFetch = globalThis.fetch
globalThis.fetch = (url, init = {}) => {
  if (!String(url).includes('/api/stellar-relay')) return realFetch(url, init)
  return realFetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Origin: 'http://localhost:5173' },
  })
}

const { newSessionKey } = await import('../src/stellar/sessionKey.js')
const { runAgentDeposit, readVaultShares } = await import('../src/stellar/agentDeposit.js')
const { readPricePerShare } = await import('../src/stellar/vaultReads.js')
const { SOROBAN_DEMO_AGENT, SOROBAN_ACTIVE_VAULT_ADDRESS, SOROBAN_AUTOFARM_VAULT_ADDRESS } =
  await import('../src/stellar/config.js')

if (SOROBAN_ACTIVE_VAULT_ADDRESS !== SOROBAN_AUTOFARM_VAULT_ADDRESS)
  throw new Error('ACTIVE vault is not the autofarm vault — cutover config wrong')

const secret = process.env.DEMO_AGENT_SECRET
if (!secret) throw new Error('set DEMO_AGENT_SECRET (the demo agent session S... secret)')
const sessionKey = newSessionKey(secret)

const AMOUNT = 20_000_000n // 2 VFUSD
const PPS_SCALE = 10_000_000n

const pps = await readPricePerShare()
const before = await readVaultShares(SOROBAN_DEMO_AGENT)
console.log('agent:', SOROBAN_DEMO_AGENT)
console.log('vault (ACTIVE=autofarm):', SOROBAN_ACTIVE_VAULT_ADDRESS)
console.log('pps before:', pps, ' shares before:', before)
if (pps == null || before == null) throw new Error('pre-reads failed')

const res = await runAgentDeposit({ agentAddress: SOROBAN_DEMO_AGENT, amount: AMOUNT, sessionKey })
console.log('relay result:', res)
if (!res || res.status !== 'SUCCESS')
  throw new Error(`deposit did not succeed: ${JSON.stringify(res)}`)

const after = await readVaultShares(SOROBAN_DEMO_AGENT)
const minted = after - before
const expected = (AMOUNT * PPS_SCALE) / pps
console.log('shares after:', after, ' minted:', minted, ' expected≈:', expected)
if (minted <= 0n)
  throw new Error('FAIL: vault shares did not increase — __check_auth or relay rejected the deposit')
// pps can tick up between the read and the deposit ledger — allow tiny slack (10 base units).
const diff = minted > expected ? minted - expected : expected - minted
if (diff > 10n)
  throw new Error(`FAIL: minted ${minted} not at the exchange rate (expected ~${expected})`)
if (pps > PPS_SCALE && minted === AMOUNT)
  throw new Error('FAIL: minted 1:1 despite pps>1 — deposit hit the wrong vault?')
console.log('PASS: gasless deposit minted exchange-rate shares on the AUTOFARM vault')
