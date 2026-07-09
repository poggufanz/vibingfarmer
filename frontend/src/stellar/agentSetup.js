// frontend/src/stellar/agentSetup.js
// The one user-signed step: per agent, register the scope on the Registry and fund the agent
// with the asset. (The agent custom account is deployed at agent-create time — its constructor
// self-approves the vault, Phase 1. The demo reuses the pre-deployed SOROBAN_DEMO_AGENT.)
// Two user-signed txs via the wallet kit: registry.authorize, then token.transfer(owner→agent).
import { buildInvokeTx, submitUserTx, readContract, rpcServer } from './client.js'
import { signTxXdr } from './walletKit.js'
import {
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
} from './config.js'

/**
 * Ensure the owner's classic Stellar account has a trustline for the token's
 * underlying asset (SAC-wrapped classic assets require a trustline before
 * transfer).  If the token is Soroban-native (no underlying_asset method) or
 * the trustline already exists, this is a no-op.
 */
async function ensureUserTrustline(owner) {
  let underlying
  try {
    underlying = await readContract({
      contract: SOROBAN_TOKEN_ADDRESS,
      method: 'underlying_asset',
      args: [],
    })
  } catch {
    // Token is Soroban-native — no trustline needed.
    return
  }
  if (!underlying) return

  const { Horizon, Asset, TransactionBuilder, Operation, BASE_FEE } = await import(
    '@stellar/stellar-sdk'
  )
  const horizon = new Horizon.Server(HORIZON_URL)
  let acct
  try {
    acct = await horizon.loadAccount(owner)
  } catch {
    return
  }
  const hasTrust = acct.balances.some(
    (b) =>
      b.asset_type !== 'native' &&
      String(b.asset_code) === String(underlying.code) &&
      String(b.asset_issuer) === String(underlying.issuer),
  )
  if (hasTrust) return

  const asset = new Asset(String(underlying.code), String(underlying.issuer))
  const server = await rpcServer()
  const source = await server.getAccount(owner)
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(30)
    .build()
  const xdr = tx.toEnvelope().toXDR('base64')
  const signed = await signTxXdr(xdr)
  const built = TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE)
  await horizon.submitTransaction(built)
}

/**
 * Register the agent's scope on the Registry, then fund it with the asset — user-signed.
 * Registry.authorize(owner, agent, vault, token, cap: i128, period_duration: u64, expiry: u64).
 * @param {{owner:string, agentAddress:string, vault:string, amount:bigint, capPerPeriod:bigint, periodDuration:number, expiry:number}} p
 * @returns {Promise<{hash:string, status:string}>} the authorize tx result
 */
export async function authorizeAndFundAgent({
  owner,
  agentAddress,
  vault,
  amount,
  capPerPeriod,
  periodDuration,
  expiry,
}) {
  // Step 0: establish trustline (SAC-wrapped assets need one before transfer).
  await ensureUserTrustline(owner)

  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: SOROBAN_REGISTRY_ADDRESS,
    method: 'authorize',
    args: [
      { addr: owner },
      { addr: agentAddress },
      { addr: vault },
      { addr: SOROBAN_TOKEN_ADDRESS },
      { i128: BigInt(capPerPeriod) },
      { u64: periodDuration },
      { u64: expiry },
    ],
  })
  const signed = await signTxXdr(xdr)
  const authRes = await submitUserTx({ signedXdr: signed })

  // token.transfer(owner → agent, amount) — funds the agent so the vault can pull on deposit.
  const { xdr: fundXdr } = await buildInvokeTx({
    source: owner,
    contract: SOROBAN_TOKEN_ADDRESS,
    method: 'transfer',
    args: [{ addr: owner }, { addr: agentAddress }, { i128: BigInt(amount) }],
  })
  const fundSigned = await signTxXdr(fundXdr)
  await submitUserTx({ signedXdr: fundSigned })

  return authRes
}
