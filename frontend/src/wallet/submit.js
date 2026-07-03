// Production passkey sign+submit on SAK. Pure-ish: SAK (`kit`), relay, and server are injected
// for testability (mirrors account.js makeKit discipline). Mirrors scripts/m3-deposit-smoke.mjs
// for the on-chain assembly; swaps the synthetic signer for kit.signAuthEntry (browser Face-ID).
//
//   submitDeposit  — source = relayer; submitted via the gasless relay (user pays 0).
//   submitApprove  — source = an ephemeral Friendbot-funded fee-payer; self-paid via RPC
//                    (the relay is deposit-only and refuses a non-deposit).

import {
  submitViaRelay as realSubmitViaRelay,
  getRelayerAddress as realGetRelayer,
} from '../stellar/relay.js'
import { readVaultShares } from '../stellar/agentDeposit.js'
import { rpcServer, encodeArgs } from '../stellar/client.js'
import { buildApprove } from './account.js'
import { NETWORK_PASSPHRASE, SOROBAN_ACTIVE_VAULT_ADDRESS } from '../stellar/config.js'

const FRIENDBOT = 'https://friendbot.stellar.org'
const APPROVE_TTL_LEDGERS = 17_280 // ~24h on testnet (5s ledgers); allowance auto-expires after

const realRelay = { submitViaRelay: realSubmitViaRelay, getRelayerAddress: realGetRelayer }

async function assertEligible(eligibility, amount, vault) {
  const verdict = await eligibility({ vault, amount })
  if (!verdict.allow) throw new Error(`ineligible: ${(verdict.reasons ?? []).join('; ')}`)
}

// ── deposit ───────────────────────────────────────────────────────────────────
/**
 * F8-gated, passkey-signed vault deposit assembled with source = relayer, relayed gaslessly.
 * @returns {Promise<{ hash, status, sharesBefore, sharesAfter }>}
 */
export async function submitDeposit({
  contractId,
  amount,
  eligibility,
  kit,
  vault = SOROBAN_ACTIVE_VAULT_ADDRESS,
  relay = realRelay,
  server,
  readShares = readVaultShares,
  buildInner = defaultBuildDepositInner,
}) {
  await assertEligible(eligibility, amount, vault) // F8 fail-closed BEFORE any signing
  const relayer = await relay.getRelayerAddress()
  if (!relayer) throw new Error('relay unavailable (relayer address unconfigured)')
  const s = server ?? (await rpcServer())
  const sharesBefore = await readShares(contractId, { server: s })
  const xdr = await buildInner({ contractId, amount, vault, relayer, kit, server: s })
  const relayed = await relay.submitViaRelay({ xdr })
  if (!relayed) throw new Error('relay unavailable (submission failed)')
  const sharesAfter = await readShares(contractId, { server: s })
  return { hash: relayed.hash, status: relayed.status, sharesBefore, sharesAfter }
}

// Real assembler (covered by the m3plus smoke, not the unit test). Mirrors m3 lines 263–322.
async function defaultBuildDepositInner({ contractId, amount, vault, relayer, kit, server }) {
  const sdk = await import('@stellar/stellar-sdk')
  const { TransactionBuilder, Operation, Contract, Address, xdr, BASE_FEE, rpc } = sdk
  const units = typeof amount === 'bigint' ? amount : BigInt(amount)
  const relayerAcct = await server.getAccount(relayer)
  const depositOp = new Contract(vault).call(
    'deposit',
    Address.fromString(contractId).toScVal(),
    xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString('0'),
        lo: xdr.Uint64.fromString(units.toString()),
      })
    )
  )
  const recRaw = new TransactionBuilder(relayerAcct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(depositOp)
    .setTimeout(60)
    .build()
  const recSim = await server.simulateTransaction(recRaw)
  if (rpc.Api.isSimulationError(recSim)) throw new Error(`deposit sim failed: ${recSim.error}`)
  const entries = recSim.result?.auth ?? []
  if (entries.length !== 1) throw new Error(`expected 1 auth entry, got ${entries.length}`)
  const signed = await kit.signAuthEntry(entries[0]) // Face-ID; SAK owns the ceremony
  // Re-fetch the source for the SUBMITTED tx: recRaw's build() already bumped relayerAcct's
  // in-memory sequence, and nothing has been submitted yet, so a fresh fetch yields the true
  // on-chain seq → the enforced tx gets the correct next sequence (avoids txBadSeq).
  const enfAcct = await server.getAccount(relayer)
  const enforcedRaw = new TransactionBuilder(enfAcct, {
    fee: (BigInt(recSim.minResourceFee ?? '0') + BigInt(BASE_FEE) * 100n).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setSorobanData(recSim.transactionData.build())
    .addOperation(Operation.invokeHostFunction({ func: recRaw.operations[0].func, auth: [signed] }))
    .setTimeout(60)
    .build()
  const enfSim = await server.simulateTransaction(enforcedRaw)
  if (rpc.Api.isSimulationError(enfSim)) throw new Error(`deposit auth sim failed: ${enfSim.error}`)
  // source = relayer, left UNSIGNED — VF's relay signs source + fee-bumps (user pays 0).
  return rpc.assembleTransaction(enforcedRaw, enfSim).build().toEnvelope().toXDR('base64')
}

// ── approve (self-paid) ─────────────────────────────────────────────────────────
/**
 * Passkey-signed token.approve(spender=vault), fee-paid by a fresh ephemeral Friendbot source.
 * @returns {Promise<{ hash, status }>}
 */
export async function submitApprove({
  contractId,
  amount,
  vault = SOROBAN_ACTIVE_VAULT_ADDRESS,
  expiryLedgers = APPROVE_TTL_LEDGERS,
  kit,
  server,
  fund = fundFriendbot,
  makeEphemeral = defaultMakeEphemeral,
  signSubmitApprove = defaultSignSubmitApprove,
}) {
  const s = server ?? (await rpcServer())
  const ephemeral = await makeEphemeral()
  await fund(ephemeral.publicKey())
  return signSubmitApprove({ contractId, amount, vault, expiryLedgers, kit, server: s, ephemeral })
}

async function fundFriendbot(pubkey) {
  const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pubkey)}`)
  if (!res.ok) throw new Error(`Friendbot funding failed (${res.status}) for ${pubkey}`)
}

async function defaultMakeEphemeral() {
  const { Keypair } = await import('@stellar/stellar-sdk')
  return Keypair.random()
}

// Real approve assembler (covered by the m3plus smoke). source = ephemeral (self-paid).
async function defaultSignSubmitApprove({
  contractId,
  amount,
  vault,
  expiryLedgers,
  kit,
  server,
  ephemeral,
}) {
  const sdk = await import('@stellar/stellar-sdk')
  const { TransactionBuilder, Operation, Contract, BASE_FEE, rpc } = sdk
  const units = typeof amount === 'bigint' ? amount : BigInt(amount)
  const latest = await server.getLatestLedger()
  const expiryLedger = latest.sequence + expiryLedgers
  // Build the approve op from buildApprove's args via the same encodeArgs the rest of the
  // client uses — keeps the real path covered by buildApprove/encodeArgs tests instead of a
  // hand-rolled parallel copy (XDR is canonical, so this is byte-identical to the old operands).
  const {
    method,
    contract: tokenContract,
    args,
  } = buildApprove({
    contractId,
    vault,
    amount: units,
    expiryLedger,
  })
  const ephAcct = await getAccountWithRetry(server, ephemeral.publicKey())
  const approveOp = new Contract(tokenContract).call(method, ...encodeArgs(args))
  const recRaw = new TransactionBuilder(ephAcct, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(approveOp)
    .setTimeout(60)
    .build()
  const recSim = await server.simulateTransaction(recRaw)
  if (rpc.Api.isSimulationError(recSim)) throw new Error(`approve sim failed: ${recSim.error}`)
  const entries = recSim.result?.auth ?? []
  if (entries.length !== 1) throw new Error(`expected 1 auth entry, got ${entries.length}`)
  const signed = await kit.signAuthEntry(entries[0]) // Face-ID over the approve auth entry
  // Fresh source for the SUBMITTED tx — recRaw's build() bumped ephAcct's in-memory sequence;
  // nothing submitted yet, so a fresh fetch gives the true on-chain seq (avoids txBadSeq).
  const enfAcct = await server.getAccount(ephemeral.publicKey())
  const enforcedRaw = new TransactionBuilder(enfAcct, {
    fee: (BigInt(recSim.minResourceFee ?? '0') + BigInt(BASE_FEE) * 100n).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .setSorobanData(recSim.transactionData.build())
    .addOperation(Operation.invokeHostFunction({ func: recRaw.operations[0].func, auth: [signed] }))
    .setTimeout(60)
    .build()
  const enfSim = await server.simulateTransaction(enforcedRaw)
  if (rpc.Api.isSimulationError(enfSim)) throw new Error(`approve auth sim failed: ${enfSim.error}`)
  const prepared = rpc.assembleTransaction(enforcedRaw, enfSim).build()
  prepared.sign(ephemeral) // self-paid: ephemeral signs the source (relay is deposit-only)
  const sent = await server.sendTransaction(prepared)
  if (sent.status === 'ERROR')
    throw new Error(`approve rejected: ${JSON.stringify(sent.errorResult ?? sent)}`)
  const r = await waitSuccess(server, sent.hash, 'approve')
  return { hash: sent.hash, status: r.status }
}

async function getAccountWithRetry(server, pubkey, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      return await server.getAccount(pubkey)
    } catch {
      await new Promise((res) => setTimeout(res, 1500))
    }
  }
  throw new Error(`account never surfaced on the RPC: ${pubkey}`)
}

async function waitSuccess(server, hashHex, label) {
  let r = await server.getTransaction(hashHex)
  for (let i = 0; i < 30 && r.status === 'NOT_FOUND'; i++) {
    await new Promise((res) => setTimeout(res, 1000))
    r = await server.getTransaction(hashHex)
  }
  if (r.status !== 'SUCCESS') throw new Error(`${label} did not succeed: ${r.status}`)
  return r
}
