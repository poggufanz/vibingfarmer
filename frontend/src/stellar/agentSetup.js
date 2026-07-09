// frontend/src/stellar/agentSetup.js
// The one user-signed step: per agent, register the scope on the Registry and fund the agent
// with the asset. (The agent custom account is deployed at agent-create time — its constructor
// self-approves the vault, Phase 1. The demo reuses the pre-deployed SOROBAN_DEMO_AGENT.)
// Two user-signed txs via the wallet kit: registry.authorize, then token.transfer(owner→agent).
import { buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'
import { SOROBAN_REGISTRY_ADDRESS, SOROBAN_TOKEN_ADDRESS } from './config.js'

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
