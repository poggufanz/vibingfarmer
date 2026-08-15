// A read-only strategy view over the owner and relayer bound Base mandate. This deliberately
// does not read storage: callers supply the versioned status received for the connected owner.
import { isVerifiedBaseMandateStatus, publicBaseMandateEvidence } from '../base/mandateStatus.js'

const WINDOW_DAYS = 7
const PER_CALL_CAP_UNITS = 10_000_000_000n
const READY_COPY =
  'For 7 days, the relayer-held key may repeatedly approve and deposit up to 10,000 USDC per call into allowlisted Base Sepolia custody proxies, while this smart account has funds. It cannot withdraw.'

function sameAddress(left, right) {
  return !!left && !!right && String(left).toLowerCase() === String(right).toLowerCase()
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function viewStatus({ mandate, stellarOwner, kernelAddress, relayerOrigin, now }) {
  if (!mandate || mandate.status === 'missing') return 'missing'
  if (mandate.status === 'revoked') return 'revoked'
  const expiry = mandate.validUntilSeconds
  if (mandate.status === 'expired' || (Number.isFinite(expiry) && expiry <= now)) {
    return 'expired'
  }
  if (!isVerifiedBaseMandateStatus(mandate)) return 'unavailable'
  // Expected connection data is part of the trust boundary. It is never optional for a ready view.
  if (!nonEmpty(stellarOwner) || !nonEmpty(kernelAddress) || !nonEmpty(relayerOrigin)) {
    return 'unavailable'
  }
  if (mandate.stellarOwner !== stellarOwner) return 'owner-mismatch'
  if (!sameAddress(mandate.kernelAddress, kernelAddress)) return 'kernel-mismatch'
  if (mandate.relayerOrigin !== relayerOrigin) return 'relayer-mismatch'
  if (
    !nonEmpty(mandate.sessionKeyAddress) ||
    !nonEmpty(mandate.bindingId) ||
    !nonEmpty(mandate.bindingHash) ||
    !Number.isFinite(expiry)
  ) {
    return 'unavailable'
  }
  return 'ready'
}

/**
 * Translate a canonical secret-free BaseMandateStatusV3 record into novice-readable strategy
 * data. It copies only public mandate metadata (`validUntilSeconds`, binding identity, public
 * evidence) and never returns a capability or session private key.
 */
export function toBaseMandateView({ mandate, stellarOwner, kernelAddress, relayerOrigin }) {
  const publicMandate = mandate ? publicBaseMandateEvidence(mandate) : null
  const now = Math.floor(Date.now() / 1000)
  const status = viewStatus({
    mandate: publicMandate,
    stellarOwner,
    kernelAddress,
    relayerOrigin,
    now,
  })
  const details = publicMandate || {}
  const bindingId = details.bindingId ?? null
  const bindingHash = details.bindingHash ?? null
  const sessionKeyAddress = details.sessionKeyAddress ?? null
  const mandateKernel = details.kernelAddress ?? null
  const validUntilSeconds = details.validUntilSeconds ?? null

  return {
    status,
    ready: status === 'ready',
    primaryCopy: READY_COPY,
    durationDays: WINDOW_DAYS,
    perCallCap: {
      usdc: '10,000',
      units: PER_CALL_CAP_UNITS,
      decimals: 6,
      cumulative: false,
      nonCumulative: true,
    },
    repeatedCalls: true,
    allowedActions: ['Circle USDC approve', 'YieldRouter deposit'],
    destination: 'allowlisted Base Sepolia custody proxies',
    sessionKeyAddress,
    kernelAddress: mandateKernel,
    validUntilSeconds,
    bindingId,
    bindingHash,
    evidence: publicMandate,
    renewalCopy: 'Renew the mandate before its expiry to continue using Base testnet.',
    revokeCopy:
      'Deleting or revoking the VF relayer copy does not invalidate another copied key before the on-chain timestamp policy expires.',
    outageCopy:
      'If the relayer has an outage, Base is unavailable until its health check succeeds.',
    technicalDisclosure: `The relayer holds the session key. The Stellar owner to Base kernel association is an application-level association, not a cryptographic binding. Binding ID: ${bindingId ?? 'unavailable'}. Binding hash: ${bindingHash ?? 'unavailable'}. Session key address: ${sessionKeyAddress ?? 'unavailable'}. Base kernel: ${mandateKernel ?? 'unavailable'}. Expiry: ${validUntilSeconds ?? 'unavailable'}. You must renew before expiry. Deleting or revoking the VF relayer copy does not invalidate another copied key before the on-chain timestamp policy expires. During a relayer outage, Base is unavailable.`,
  }
}
