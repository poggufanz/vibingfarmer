// frontend/src/baseLeg.js
// The Base leg of a mixed strategy, packaged as ONE settled unit for the orchestrator. Per the
// grant-covers-burn design (docs/superpowers/specs/2026-07-21-grant-covers-burn-design.md §4-5):
// the run's SINGLE funding_router grant already deployed this leg's bridge agent — folded in
// alongside the Stellar deposit workers' agent inits by orchestrator.js (see
// OrchestratorAgent.grantFreshAgents) — and a valid durable Base mandate is GUARANTEED to already
// be stored (app.jsx's preflight refuses to offer Base pools otherwise, mergeFlowHelpers.js's
// checkStoredBaseMandate). So this function never runs a passkey ceremony: no ensureBaseOwner, no
// createMandate, no second grant, no signTx. It only: re-validates the stored mandate is still
// live (a TOCTOU guard between strategy generation and dispatch), quotes the Base allocations,
// relays the pull+burn via the bridge agent's session key (both params it receives), then hands
// off to crossChainFarm's existing relayerClient /farm flow. Never throws — every failure resolves
// { success:false, stage, error } so a Base failure can never abort the Stellar workers beside it.
import {
  getMandateStatus as defaultGetMandateStatus,
  quantizeAllocations,
} from './base/relayerClient.js'
import { runFarmFlow as defaultRunFarmFlow } from './crossChainFarm.js'
import { runAgentPull as defaultRunAgentPull } from './stellar/grant.js'
import { runAgentBurn as defaultRunAgentBurn } from './stellar/agentBurn.js'
import { evmAddrToBytes32 } from './stellar/cctpBurn.js'
import { deriveCctpTransferUnits } from './stellar/format.js'
import { BASE_POOL_CATALOG } from './config.js'
import { estimateMinShares as defaultEstimateMinShares } from './base/quotes.js'
import { defaultMakePublicClient } from './wallet/passkeyBase.js'
import { readStoredBaseMandate } from './mergeFlowHelpers.js'

/**
 * @param {{
 *   connectedAddress: string,          // Stellar wallet — used only for logging/identity, never signs here
 *   bridgeAgentAddress: string,        // this leg's bridge agent, deployed by the run's ONE grant
 *   bridgeSessionKey: object,          // that agent's session key (signs pull + deposit_for_burn)
 *   kernelAddress: string,             // Base owner address the SAME grant pinned as mint_recipient —
 *                                      // sourced from orchestrator.js's OWN read of vf_base_mandate, never
 *                                      // re-read here, so a mid-run mandate rotation can't desync the
 *                                      // runtime burn arg from what's actually pinned on-chain.
 *   baseVaults: Array<{address:string, allocation:number}>,
 *   totalAmount: number,
 *   onEvent?: Function,
 *   deps?: object,
 * }} p
 * @returns {Promise<{success:boolean, burnHash?:string, jobId?:string, finalStatus?:string,
 *          baseAccount?:string, stage?:string, error?:string, pulled?:boolean,
 *          bridgeAgentAddress?:string}>}
 */
export async function executeBaseLeg({
  connectedAddress,
  bridgeAgentAddress,
  bridgeSessionKey,
  kernelAddress,
  baseVaults,
  totalAmount,
  onEvent = () => {},
  deps = {},
}) {
  // ponytail: `deps = {}` default only covers undefined; an explicit `deps: null` would throw
  // synchronously on the destructure below, outside the try — guard normalizes both.
  const {
    getMandateStatus = defaultGetMandateStatus,
    runFarmFlow = defaultRunFarmFlow,
    estimateMinShares = defaultEstimateMinShares,
    makePublicClient = defaultMakePublicClient,
    runAgentPull = defaultRunAgentPull,
    runAgentBurn = defaultRunAgentBurn,
    readStoredMandate = readStoredBaseMandate,
  } = deps || {}

  const safeEmit = (name, data) => {
    try {
      onEvent(name, data)
    } catch {
      // onEvent is caller UI glue — a broken listener must never abort a settled leg.
    }
  }

  let stage = 'mandate'
  // Set true once the relayed pull confirms — funds have left the owner into the bridge agent.
  // Declared here (not inside `try`) so the `catch` block below can still read it.
  let fundsPulled = false
  try {
    if (!bridgeAgentAddress) {
      throw new Error('No bridge agent address was provided — the run grant must supply one.')
    }
    if (!kernelAddress) {
      throw new Error('No Base kernel address was provided — the run grant must supply one.')
    }
    // Re-validate right before spending it (TOCTOU guard: the app.jsx preflight checked this
    // during strategy generation, which can be minutes before dispatch). No ceremony fallback —
    // mandate setup is its own per-window moment, never something a run performs.
    const storedMandate = readStoredMandate()
    if (!storedMandate) throw new Error('No durable Base mandate is stored.')
    let valid = false
    try {
      valid = (await getMandateStatus(storedMandate.serializedApproval)).valid
    } catch {
      valid = false
    }
    if (!valid) throw new Error('The stored Base mandate is no longer valid.')

    // ownerAddress comes from the CALLER's kernelAddress param (the exact value orchestrator.js
    // already used to pin this grant's mint_recipient on-chain), never re-read from storage here —
    // a mid-run mandate rotation must not desync the runtime burn arg from the pinned scope.
    const ownerAddress = kernelAddress
    // publicClient is a bare read-only RPC client (same one base/dashboardPositions.js uses, via
    // passkeyBase.js's exported defaultMakePublicClient) — live minShares quoting needs chain
    // reads, not wallet auth.
    const publicClient = makePublicClient()
    safeEmit('baseleg-owner', { status: 'done', ownerMode: 'mandate', address: ownerAddress })

    const legAmount = baseVaults.reduce((sum, v) => sum + totalAmount * v.allocation, 0)
    // NOTE (reality vs brief): deriveCctpTransferUnits returns
    // { requestedUnits7, baseTargetUnits6, burnUnits7, retainedDustUnits7 } — there is no
    // units7/units6 pair. burnUnits7 is the 7dp burn amount; baseTargetUnits6 is the exact 6dp
    // Base-side total that quantizeAllocations must apportion across (burnUnits7 = baseTargetUnits6 * 10n).
    const { burnUnits7, baseTargetUnits6 } = deriveCctpTransferUnits(legAmount)
    const allocations = quantizeAllocations(
      baseVaults.map((v) => {
        const cat = BASE_POOL_CATALOG.find(
          (p) => p.address.toLowerCase() === v.address.toLowerCase()
        )
        return {
          pool: v.address,
          protocol: cat?.protocol,
          amount: totalAmount * v.allocation,
        }
      }),
      { targetUnits: baseTargetUnits6 }
    )
    // Execution-time slippage guard: quote live convertToShares per pool right before the burn,
    // replacing the old hardcoded minShares: 1n no-op (see base/quotes.js).
    const quotedAllocations = await Promise.all(
      allocations.map(async (a) => ({
        ...a,
        minShares: await estimateMinShares({
          pool: a.pool,
          amountBaseUnits: a.amountBaseUnits,
          publicClient,
        }),
      }))
    )
    safeEmit('baseleg-mandate', {
      status: 'done',
      sessionKeyAddress: storedMandate.sessionKeyAddress,
      expiry: storedMandate.expiry,
      reused: true,
    })

    stage = 'farm'
    // Grant-covered burn: pull moves burnUnits7 from the owner into the bridge agent (relayed,
    // session-key signed), then the SAME session key authorizes the burn itself — the Stellar
    // wallet never signs or pays for either step (it already signed once, in the run's single
    // grant, before this function was even called). Both failures are re-thrown as-is;
    // crossChainFarm catches them and fires 'farm-failed' with stage:'burn', same contract
    // burnViaWallet's old (now-retired-from-this-flow) path had.
    const mintRecipient32 = evmAddrToBytes32(ownerAddress)
    // Once the pull confirms, funds have LEFT the owner and are sitting in the bridge agent — any
    // failure after that point is a "stranded, recoverable via owner sweep" state, not a "nothing
    // moved" one. `stage` flips to 'burn' right there so a pull-ok/burn-fails outcome is reported
    // distinctly from an unstarted one, and `fundsPulled`/`bridgeAgentAddress` ride along in the
    // failure payload below as the recovery handle (an owner_withdraw sweep target).
    const result = await runFarmFlow({
      stellarWallet: { address: connectedAddress },
      baseRecipientAddress: ownerAddress,
      sessionKeyAddress: storedMandate.sessionKeyAddress,
      serializedApproval: storedMandate.serializedApproval,
      allocations: quotedAllocations,
      burnUnits7,
      onEvent,
      deps: {
        burn: async ({ amountUnits }) => {
          const pullRes = await runAgentPull({
            agentAddress: bridgeAgentAddress,
            amount: amountUnits,
            sessionKey: bridgeSessionKey,
          })
          if (!pullRes) throw new Error('The Stellar relay is unavailable for the CCTP burn.')
          if (pullRes.status !== 'SUCCESS')
            throw new Error(`The bridge agent funding pull returned ${pullRes.status}.`)
          fundsPulled = true
          stage = 'burn'
          const burned = await runAgentBurn({
            bridgeAgentAddress,
            amountUnits,
            mintRecipient: mintRecipient32,
            sessionKey: bridgeSessionKey,
          })
          if (!burned) throw new Error('The Stellar relay is unavailable for the CCTP burn.')
          return burned
        },
      },
    })
    return {
      success: true,
      burnHash: result.burnHash,
      jobId: result.jobId,
      finalStatus: result.finalStatus,
      baseAccount: ownerAddress,
    }
  } catch (err) {
    // A dependency can reject with anything (bare string, null, plain object) — never assume
    // Error shape, or reading .message here would itself throw and break the never-throws contract.
    const message = err instanceof Error ? err.message : String(err)
    // Stranded-funds observability: once the pull confirmed, the bridge agent is holding the
    // owner's USDC — surface that + the recovery handle (bridgeAgentAddress, for an owner_withdraw
    // sweep) in BOTH the event and the return value, so a pull-ok/burn-fails outcome is never
    // indistinguishable from a nothing-moved one.
    const strandedFunds = fundsPulled ? { pulled: true, bridgeAgentAddress } : {}
    safeEmit('baseleg-failed', { stage, error: message, ...strandedFunds })
    return { success: false, stage, error: message, ...strandedFunds }
  }
}
