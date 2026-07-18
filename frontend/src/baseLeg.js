// frontend/src/baseLeg.js
// The Base leg of a mixed strategy, packaged as ONE settled unit for the orchestrator:
// ensure owner (VF reuse | ceremony) → mandate (1h TTL) → register with relayer → burn (wallet
// signs) → relay → deposits. Never throws — every failure resolves { success:false, stage, error }
// so a Base failure can never abort the Stellar workers running beside it.
// sessionPrivateKey stays inside this function: handed to postMandate, then dropped (same rule
// as CrossChainFarmFlow had).
import { ensureBaseOwner as defaultEnsureBaseOwner } from './wallet/passkeyBridge.js'
import { createMandate as defaultCreateMandate } from './wallet/mandate.js'
import { postMandate as defaultPostMandate, quantizeAllocations } from './base/relayerClient.js'
import { runFarmFlow as defaultRunFarmFlow } from './crossChainFarm.js'
import { burnViaWallet } from './stellar/burnViaWallet.js'
import { deriveCctpTransferUnits } from './stellar/format.js'
import { BASE_POOL_CATALOG } from './config.js'
import { estimateMinShares as defaultEstimateMinShares } from './base/quotes.js'

const MANDATE_TTL_SECONDS = 3600

export async function executeBaseLeg({
  connectedAddress,
  signTx,
  baseVaults,
  totalAmount,
  onEvent = () => {},
  deps = {},
}) {
  // ponytail: `deps = {}` default only covers undefined; an explicit `deps: null` would throw
  // synchronously on the destructure below, outside the try — guard normalizes both.
  const {
    ensureBaseOwner = defaultEnsureBaseOwner,
    createMandate = defaultCreateMandate,
    postMandate = defaultPostMandate,
    runFarmFlow = defaultRunFarmFlow,
    estimateMinShares = defaultEstimateMinShares,
  } = deps || {}

  const safeEmit = (name, data) => {
    try {
      onEvent(name, data)
    } catch {
      // onEvent is caller UI glue — a broken listener must never abort a settled leg.
    }
  }

  let stage = 'owner'
  try {
    safeEmit('baseleg-owner', { status: 'pending' })
    const owner = await ensureBaseOwner({ connectedAddress })
    safeEmit('baseleg-owner', {
      status: 'done',
      ownerMode: owner.ownerMode,
      address: owner.address,
    })

    stage = 'mandate'
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
    // Execution-time slippage guard: quote live convertToShares per pool right before mandate
    // creation, replacing the old hardcoded minShares: 1n no-op (see base/quotes.js).
    const quotedAllocations = await Promise.all(
      allocations.map(async (a) => ({
        ...a,
        minShares: await estimateMinShares({
          pool: a.pool,
          amountBaseUnits: a.amountBaseUnits,
          publicClient: owner.publicClient,
        }),
      }))
    )

    const mandate = await createMandate({
      kernelAccount: owner.kernelAccount,
      publicClient: owner.publicClient,
      passkeyValidator: owner.passkeyValidator,
      pools: quotedAllocations.map((a) => ({ pool: a.pool, cap: a.amountBaseUnits })),
      expiry: Math.floor(Date.now() / 1000) + MANDATE_TTL_SECONDS,
    })
    await postMandate({
      serializedApproval: mandate.serializedApproval,
      sessionPrivateKey: mandate.sessionPrivateKey, // crosses the wire exactly once, then dropped
    })
    safeEmit('baseleg-mandate', {
      status: 'done',
      sessionKeyAddress: mandate.sessionKeyAddress,
      expiry: mandate.expiry,
    })

    stage = 'farm'
    const result = await runFarmFlow({
      stellarWallet: { address: connectedAddress, signBurn: signTx },
      baseRecipientAddress: owner.address,
      sessionKeyAddress: mandate.sessionKeyAddress,
      serializedApproval: mandate.serializedApproval,
      allocations: quotedAllocations,
      burnUnits7,
      onEvent,
      deps: { burn: (p) => burnViaWallet({ ...p, signTx }) },
    })
    return {
      success: true,
      burnHash: result.burnHash,
      jobId: result.jobId,
      finalStatus: result.finalStatus,
      baseAccount: owner.address,
    }
  } catch (err) {
    // A dependency can reject with anything (bare string, null, plain object) — never assume
    // Error shape, or reading .message here would itself throw and break the never-throws contract.
    const message = err instanceof Error ? err.message : String(err)
    safeEmit('baseleg-failed', { stage, error: message })
    return { success: false, stage, error: message }
  }
}
