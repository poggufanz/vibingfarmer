// Live testnet proof of the gasless fee-bump relay. NOT part of `vitest run`.
// Run: node scripts/stellar-relay-smoke.mjs   (needs a funded STELLAR_RELAYER_SECRET in env)
//
// 1. Generate + friendbot-fund a throwaway inner-source account.
// 2. Build a no-auth Soroban view invoke (vault.decimals()) as the inner tx, simulate+assemble.
// 3. feeBumpAndSubmit() wraps it (relayer pays the fee) and submits.
// 4. Assert SUCCESS + the relayer's XLM dropped while the inner source's XLM is unchanged.
//
// Balance reads go through Horizon (the Soroban rpc.Server.getAccount returns only sequence,
// not balances) — see the plan's XDR/balance note.

import 'dotenv/config'
import { readFileSync } from 'node:fs'
import {
  Keypair,
  TransactionBuilder,
  FeeBumpTransaction,
  Address,
  Contract,
  Networks,
  Horizon,
  rpc,
} from '@stellar/stellar-sdk'
import { feeBumpAndSubmit, _clearSeen } from '../api/stellar-relay.js'

const PASS = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET
const RPC = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
const secret = process.env.STELLAR_RELAYER_SECRET
if (!secret) throw new Error('STELLAR_RELAYER_SECRET not set (generate + fund a testnet key first)')

const deployments = JSON.parse(readFileSync(new URL('../../deployments/stellar-testnet.json', import.meta.url)))
const VAULT = deployments.rwa.vault
const server = new rpc.Server(RPC)
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
const sdk = { TransactionBuilder, FeeBumpTransaction, Keypair, Address }

const nativeBalance = async (pubkey) => {
  const acct = await horizon.loadAccount(pubkey)
  return Number(acct.balances.find((b) => b.asset_type === 'native').balance)
}

async function main() {
  _clearSeen()
  const relayer = Keypair.fromSecret(secret).publicKey()

  // 1. throwaway inner source, friendbot-funded
  const inner = Keypair.random()
  await fetch(`https://friendbot.stellar.org?addr=${inner.publicKey()}`).then((r) => r.json())
  const innerAccount = await server.getAccount(inner.publicKey())

  // 2. no-auth view invoke (vault.decimals()) — valid tx, no agent/vault auth required
  const tx = new TransactionBuilder(innerAccount, { fee: '100', networkPassphrase: PASS })
    .addOperation(new Contract(VAULT).call('decimals'))
    .setTimeout(60)
    .build()
  const prepared = await server.prepareTransaction(tx) // simulate + assemble (sets resource fee)
  prepared.sign(inner)
  const xdr = prepared.toEnvelope().toXDR('base64')

  const relayerBefore = await nativeBalance(relayer)
  const innerBefore = await nativeBalance(inner.publicKey())

  // 3. relay it (allowlist bypassed for the smoke: vaultAddr '')
  const out = await feeBumpAndSubmit({
    xdr, secret, passphrase: PASS, vaultAddr: '', sdk, rpcServer: server,
  })
  console.log('relay result:', out)

  // 4. gasless assertion
  const relayerAfter = await nativeBalance(relayer)
  const innerAfter = await nativeBalance(inner.publicKey())
  const relayerPaid = relayerBefore - relayerAfter
  const innerPaid = innerBefore - innerAfter
  console.log({ status: out.status, relayerPaidXLM: relayerPaid, innerPaidXLM: innerPaid })
  if (out.status !== 'SUCCESS') throw new Error('expected SUCCESS, got ' + out.status)
  if (relayerPaid <= 0) throw new Error('relayer did not pay the fee — fee-bump not applied')
  if (innerPaid !== 0) throw new Error('inner source paid — NOT gasless')
  console.log('OK — gasless fee-bump verified')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
