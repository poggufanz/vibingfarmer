// Live testnet proof of the read + event-decode chain layer. NOT part of `vitest run`.
// Run: node scripts/stellar-chain-smoke.mjs
//
// 1. readContract(vault.decimals)        → proves client + scval decode against live RPC.
// 2. readContract(vault.total_shares)    → proves an i128 read decodes to BigInt.
// 3. pollEvents(recent ledgers)          → proves getEvents decode + graph deltas on real events.
//
// No keys, no funding, no writes — all read-only simulate + getEvents.

import { rpcServer, readContract } from '../src/stellar/client.js'
import { pollEvents } from '../src/stellar/events.js'
import { SOROBAN_VAULT_ADDRESS } from '../src/stellar/config.js'

async function main() {
  const decimals = await readContract({ contract: SOROBAN_VAULT_ADDRESS, method: 'decimals' })
  console.log('vault.decimals =', decimals)
  if (Number(decimals) !== 7) throw new Error(`expected 7 decimals, got ${decimals}`)

  const totalShares = await readContract({ contract: SOROBAN_VAULT_ADDRESS, method: 'total_shares' })
  console.log('vault.total_shares =', totalShares, '(' + typeof totalShares + ')')
  if (typeof totalShares !== 'bigint') throw new Error('total_shares should decode to a BigInt')

  const server = await rpcServer()
  const { sequence } = await server.getLatestLedger()
  const startLedger = Math.max(1, sequence - 8000) // stay inside the RPC retention window
  const { events, deltas } = await pollEvents({ server, startLedger })
  // i128 fields decode to BigInt, which JSON.stringify can't serialize — stringify them.
  const bigintSafe = (_k, v) => (typeof v === 'bigint' ? v.toString() : v)
  console.log(`decoded ${events.length} recent events`)
  for (const e of events.slice(0, 5)) console.log(' ', e.type, 'ledger', e.ledger, JSON.stringify(e.data, bigintSafe))
  console.log('graph deltas sample:', JSON.stringify(deltas.slice(0, 3), bigintSafe))

  console.log('OK — read + event-decode chain layer verified against live testnet')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
