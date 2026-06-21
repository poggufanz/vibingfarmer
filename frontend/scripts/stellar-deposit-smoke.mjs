// Live-testnet proof of the gasless agent deposit. Funds the demo agent (if needed) then runs
// a real session-key-signed deposit through the relay and asserts the vault share balance rose.
// Run: node scripts/stellar-deposit-smoke.mjs  (NOT part of vitest run; needs DEMO_AGENT_SECRET)
import { newSessionKey } from '../src/stellar/sessionKey.js'
import { runAgentDeposit, readVaultShares } from '../src/stellar/agentDeposit.js'
import { SOROBAN_DEMO_AGENT } from '../src/stellar/config.js'

const secret = process.env.DEMO_AGENT_SECRET
if (!secret) throw new Error('set DEMO_AGENT_SECRET (the demo agent session S... secret)')

const sessionKey = newSessionKey(secret)
const before = await readVaultShares(SOROBAN_DEMO_AGENT)
console.log('shares before:', before)

const res = await runAgentDeposit({ agentAddress: SOROBAN_DEMO_AGENT, amount: 10_000_000n, sessionKey }) // 1 VFUSD
console.log('relay result:', res)
if (!res || res.status !== 'SUCCESS') throw new Error(`deposit did not succeed: ${JSON.stringify(res)}`)

const after = await readVaultShares(SOROBAN_DEMO_AGENT)
console.log('shares after:', after)
if (!(after > before)) throw new Error('FAIL: vault shares did not increase — __check_auth or relay rejected the deposit')
console.log('PASS: gasless agent deposit minted shares on-chain')
