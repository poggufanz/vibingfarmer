import stellarDeployment from '../../deployments/stellar-testnet.json'

const DEPOSIT_SCOPE_ABI = 'scope_of:owner-vault-token-v1'
const BRIDGE_SCOPE_ABI = 'scope_of:owner-target-token-kind-v2'

function capability(generation, scopeOfOwnerAbi, allowedRelayOps) {
  return Object.freeze({
    generation,
    scopeOfOwnerAbi,
    allowedRelayOps: Object.freeze([...allowedRelayOps]),
  })
}

const DEPOSIT_HASH = stellarDeployment.agentAccountWasmHash
const BRIDGE_HASH = stellarDeployment.fundingRouter.agentWasmHashV3New

// Source/history proof:
// - DEPOSIT_HASH: deployments commit 1eeaee2, AgentScope at that commit exposes
//   {owner,vault,token,...}; scope_of and owner_withdraw are present in the deployed source.
// - BRIDGE_HASH: source commit 5263074 + deployment commit 1f84f1c, AgentScope exposes
//   {owner,target,token,kind,...}; owner_withdraw only uses the vault path for kind=Deposit.
// Hashes mentioned only in deployment notes are deliberately absent: a generation label is not
// ABI proof and never grants a direct exit capability.
export const AGENT_WASM_CAPABILITIES = Object.freeze({
  [DEPOSIT_HASH]: capability('deposit-v3', DEPOSIT_SCOPE_ABI, [
    'exit_router_sweep',
    'owner_withdraw',
    'revoke',
    'set_exit_signer',
    'token_transfer',
  ]),
  [BRIDGE_HASH]: capability('bridge-v3', BRIDGE_SCOPE_ABI, [
    'cctp_burn',
    'exit_router_sweep',
    'owner_withdraw',
    'revoke',
    'set_exit_signer',
    'token_transfer',
  ]),
})

export const TRACKED_AGENT_WASM_HASHES = Object.freeze([BRIDGE_HASH, DEPOSIT_HASH])

export function agentCapabilityFor(hash, relayOperation) {
  const capability = AGENT_WASM_CAPABILITIES[String(hash || '').toLowerCase()]
  if (!capability) return null
  if (relayOperation && !capability.allowedRelayOps.includes(relayOperation)) return null
  return capability
}
