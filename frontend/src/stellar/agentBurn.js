// frontend/src/stellar/agentBurn.js
// Bridge worker: authorize TokenMessengerMinter.deposit_for_burn(bridgeAgent, ...) with the
// BRIDGE AGENT's ephemeral session key — same sign+relay primitive agentDeposit.js's
// buildAgentAuthedInvoke already provides (simulate -> find the agent-credentialed auth entry ->
// sign -> re-prepare in enforcing mode), just pointed at the messenger contract's burn method
// instead of the vault's deposit. Source = the relay, so the user's Stellar wallet never signs or
// pays for the burn — replaces burnViaWallet.js's 2 user-signed popups with 0.
//
// Every arg-vector constant is imported from cctpBurn.js (proven live, never redeclared here).
// mint_recipient is NOT read from on-chain scope — the caller supplies it (from the durable Base
// mandate's kernelAddress); a mismatch with the agent's constructor-pinned scope is rejected
// on-chain (fail-closed), not re-validated client-side.
import { buildAgentAuthedInvoke } from './agentDeposit.js'
import {
  STELLAR_TOKEN_MESSENGER_MINTER,
  STELLAR_USDC_SAC,
  CCTP_BASE_DOMAIN,
  CCTP_MAX_FEE,
  CCTP_MIN_FINALITY_STANDARD,
  ZERO32,
} from './cctpBurn.js'
import { getRelayerAddress, submitViaRelay } from './relay.js'

/**
 * Build the relayed deposit_for_burn invoke, signed by the bridge agent's session key.
 * @param {{bridgeAgentAddress:string, amountUnits:bigint, mintRecipient:Uint8Array,
 *          relayer:string, sessionKey:{sign:(p:Uint8Array)=>Uint8Array}, server?:object}} p
 * @returns {Promise<{xdr:string}>}
 */
export async function buildAgentBurn({
  bridgeAgentAddress,
  amountUnits,
  mintRecipient,
  relayer,
  sessionKey,
  server,
}) {
  return buildAgentAuthedInvoke({
    contract: STELLAR_TOKEN_MESSENGER_MINTER,
    method: 'deposit_for_burn',
    // EXACT pinned-scope order: caller, amount, destination_domain, mint_recipient, burn_token,
    // destination_caller, max_fee, min_finality.
    args: [
      { addr: bridgeAgentAddress },
      { i128: BigInt(amountUnits) },
      { u32: CCTP_BASE_DOMAIN },
      { bytes32: mintRecipient },
      { addr: STELLAR_USDC_SAC },
      { bytes32: ZERO32 },
      { i128: CCTP_MAX_FEE },
      { u32: CCTP_MIN_FINALITY_STANDARD },
    ],
    agentAddress: bridgeAgentAddress,
    signer: sessionKey,
    relayer,
    server,
  })
}

/**
 * Full gasless burn: resolve the relayer, build + sign, submit via the relay.
 * null on relay-unconfigured (same contract as runAgentDeposit/runAgentPull — the caller decides
 * the fallback). A relay refusal/failure or a non-SUCCESS confirmed status throws WITH the method
 * name for context, since {burnHash} must never be a hash the chain didn't actually confirm.
 * @param {{bridgeAgentAddress:string, amountUnits:bigint, mintRecipient:Uint8Array,
 *          sessionKey:object, server?:object}} p
 * @returns {Promise<{burnHash:string}|null>}
 */
export async function runAgentBurn({
  bridgeAgentAddress,
  amountUnits,
  mintRecipient,
  sessionKey,
  server,
}) {
  const relayer = await getRelayerAddress()
  if (!relayer) return null
  let res
  try {
    const { xdr } = await buildAgentBurn({
      bridgeAgentAddress,
      amountUnits,
      mintRecipient,
      relayer,
      sessionKey,
      server,
    })
    res = await submitViaRelay({ xdr })
  } catch (err) {
    throw new Error(`deposit_for_burn: ${err.message}`)
  }
  if (!res || res.status !== 'SUCCESS') {
    throw new Error(`deposit_for_burn: relay returned ${res?.status ?? 'no response'}`)
  }
  return { burnHash: res.hash }
}
