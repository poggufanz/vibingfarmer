// A2A coordination via ERC-7710 redelegation (orchestrator → workers).
// Targets the "Best A2A Coordination" track. Base Sepolia (84532).
import {
  createDelegation,
  CaveatType,
  ScopeType,
  Implementation,
  toMetaMaskSmartAccount,
} from '@metamask/smart-accounts-kit'
// NOTE: createCaveatBuilder + hashDelegation live in the /utils subpath in SAK 1.6.0,
// NOT the main entry — importing them from the main entry crashes at module load.
import { createCaveatBuilder, hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { parseUnits, createPublicClient, http } from 'viem'
import { baseSepolia as chain } from 'viem/chains'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { USDC_SEPOLIA } from './config.js'

// Ephemeral, per-session orchestrator key. Generated client-side in memory and
// NEVER persisted, NEVER bundled. SECURITY: a static VITE_ORCHESTRATOR_PRIVATE_KEY
// would be inlined into the client bundle by Vite and readable by any visitor —
// a standing-authority key leak. An ephemeral key has no standing authority: it
// only signs redelegations scoped under the user's freshly-signed root delegation
// for the current session, then is discarded on reload.
let sessionOrchestratorKey = null
function getSessionOrchestratorKey() {
  if (!sessionOrchestratorKey) sessionOrchestratorKey = generatePrivateKey()
  return sessionOrchestratorKey
}

/**
 * Creates the orchestrator smart account.
 * Orchestrator is an ephemeral per-session smart account — NOT the user's MetaMask,
 * and NOT a long-lived backend key. Its private key lives only in memory for the
 * current tab session and is regenerated on reload.
 */
export async function createOrchestratorAccount() {
  const orchestratorEOA = privateKeyToAccount(getSessionOrchestratorKey())

  const publicClient = createPublicClient({
    chain,
    transport: http(import.meta.env.VITE_RPC_URL || 'https://sepolia.base.org'),
  })

  return toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [orchestratorEOA.address, [], [], []],
    deploySalt: '0x',
    signer: { account: orchestratorEOA },
  })
}

/**
 * Creates redelegation chain: orchestrator → each worker.
 * Each worker gets scoped permission: their USDC allocation only, on a single vault,
 * capped to 3 calls (approve + deposit + stake). `parentDelegation` links back to the
 * user's root delegation (ERC-7715) — the on-chain proof of A2A coordination.
 *
 * @param {object}  params
 * @param {object}  params.orchestratorSmartAccount
 * @param {object}  params.rootDelegation - signed root delegation from the user
 * @param {Array}   params.workers - [{ address, allocationUsdc, vaultAddress, workerId }]
 * @returns {Promise<Array>} workerRedelegations
 */
export async function createWorkerRedelegations({ orchestratorSmartAccount, rootDelegation, workers }) {
  const redelegations = []

  // Link to the user's root ONLY when it's a real Delegation-Framework parent: a Delegation
  // object or a bytes32 delegation hash. The app's ERC-7715 permissionContext (e.g. '0xmock'
  // in the demo) is NOT a framework delegation — using it as `authority` throws
  // BytesSizeMismatchError (expected bytes32). In that case omit the parent so the
  // orchestrator-rooted scoped delegation still signs (real signature + hash) and A2A events emit.
  const parentDelegation =
    rootDelegation && (typeof rootDelegation === 'object' || /^0x[0-9a-fA-F]{64}$/.test(rootDelegation))
      ? rootDelegation
      : undefined

  for (const worker of workers) {
    // Limit each worker to max 3 calls: approve + deposit + stake
    const caveats = createCaveatBuilder(orchestratorSmartAccount.environment)
      .addCaveat(CaveatType.LimitedCalls, { limit: 3 })
      .build()

    // Scope narrows to this worker's USDC allocation — never exceeds the root delegation.
    const redelegation = createDelegation({
      scope: {
        type: ScopeType.Erc20TransferAmount,
        tokenAddress: USDC_SEPOLIA,
        maxAmount: parseUnits(String(worker.allocationUsdc), 6),
      },
      to: worker.address,
      from: orchestratorSmartAccount.address,
      ...(parentDelegation ? { parentDelegation } : {}), // ← A2A chain link (when a real framework root exists)
      environment: orchestratorSmartAccount.environment,
      caveats,
    })

    // SAK account.signDelegation() returns a signature string — assemble the signed
    // delegation, and hash the struct (hash is signature-independent, Etherscan-verifiable).
    const signature = await orchestratorSmartAccount.signDelegation({ delegation: redelegation })

    redelegations.push({
      workerId: worker.workerId,
      workerAddress: worker.address,
      vaultAddress: worker.vaultAddress,
      allocationUsdc: worker.allocationUsdc,
      signedRedelegation: { ...redelegation, signature },
      delegationHash: hashDelegation(redelegation),
    })
  }

  return redelegations
}

/**
 * Maps strategy agents → worker redelegation params.
 * Reads workerAddress from each agent (set by orchestrator before calling this).
 */
export function buildWorkerConfigs(strategyAgents, totalUsdc) {
  return strategyAgents.map((agent, i) => ({
    address: agent.workerAddress,
    allocationUsdc: Math.floor(totalUsdc * (agent.allocation / 100)),
    vaultAddress: agent.vault.addr,
    workerId: i + 1,
    label: agent.label || `Worker ${i + 1}`,
  }))
}
