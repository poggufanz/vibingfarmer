// frontend/src/stellar/agentBurn.test.js
// Bridge worker: authorize TokenMessengerMinter.deposit_for_burn(bridgeAgent, ...) with the
// bridge agent's SESSION KEY, relayed — zero Stellar-wallet popups for the burn. Mocks the same
// two seams agentDeposit.js's own callers rely on: buildAgentAuthedInvoke (the shared sign+
// re-prepare primitive) and relay.js (getRelayerAddress/submitViaRelay) — mirrors
// cctpBurn.test.js's "capture the args" style and agentDeposit.test.js's signer-not-wallet intent.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const buildAgentAuthedInvokeMock = vi.fn()
vi.mock('./agentDeposit.js', () => ({
  buildAgentAuthedInvoke: (...a) => buildAgentAuthedInvokeMock(...a),
}))

const getRelayerAddressMock = vi.fn()
const submitViaRelayMock = vi.fn()
vi.mock('./relay.js', () => ({
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
  submitViaRelay: (...a) => submitViaRelayMock(...a),
}))

import { buildAgentBurn, runAgentBurn } from './agentBurn.js'
import {
  STELLAR_TOKEN_MESSENGER_MINTER,
  STELLAR_USDC_SAC,
  CCTP_BASE_DOMAIN,
  CCTP_MAX_FEE,
  CCTP_MIN_FINALITY_STANDARD,
  ZERO32,
} from './cctpBurn.js'

const BRIDGE_AGENT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const RELAYER = 'GRELAYER00000000000000000000000000000000000000000000000'
const MINT_RECIPIENT = new Uint8Array(32).fill(9)
const sessionKey = { rawPublicKey: new Uint8Array(32), sign: () => new Uint8Array(64) }

beforeEach(() => {
  buildAgentAuthedInvokeMock.mockReset()
  buildAgentAuthedInvokeMock.mockResolvedValue({ xdr: 'SIGNED_XDR' })
  getRelayerAddressMock.mockReset()
  getRelayerAddressMock.mockResolvedValue(RELAYER)
  submitViaRelayMock.mockReset()
  submitViaRelayMock.mockResolvedValue({ hash: 'HBURN', status: 'SUCCESS', relayer: RELAYER })
})

describe('buildAgentBurn - arg vector matches the pinned scope exactly', () => {
  it('calls the shared authed-invoke primitive with the TokenMessengerMinter deposit_for_burn args, in order', async () => {
    await buildAgentBurn({
      bridgeAgentAddress: BRIDGE_AGENT,
      amountUnits: 5_000_000n,
      mintRecipient: MINT_RECIPIENT,
      relayer: RELAYER,
      sessionKey,
      server: { fake: true },
    })

    expect(buildAgentAuthedInvokeMock).toHaveBeenCalledTimes(1)
    const call = buildAgentAuthedInvokeMock.mock.calls[0][0]
    expect(call.contract).toBe(STELLAR_TOKEN_MESSENGER_MINTER)
    expect(call.method).toBe('deposit_for_burn')
    // (bridgeAgent, amount, 6, mintRecipient32, USDC_SAC, ZERO32, 0, 2000) — EXACT order.
    expect(call.args).toEqual([
      { addr: BRIDGE_AGENT },
      { i128: 5_000_000n },
      { u32: CCTP_BASE_DOMAIN },
      { bytes32: MINT_RECIPIENT },
      { addr: STELLAR_USDC_SAC },
      { bytes32: ZERO32 },
      { i128: CCTP_MAX_FEE },
      { u32: CCTP_MIN_FINALITY_STANDARD },
    ])
    expect(CCTP_BASE_DOMAIN).toBe(6)
    expect(CCTP_MIN_FINALITY_STANDARD).toBe(2000)
    expect(CCTP_MAX_FEE).toBe(0n)
  })

  it('signs with the SESSION KEY (agent signer), never a wallet — the auth entry is credentialed to the bridge agent', async () => {
    await buildAgentBurn({
      bridgeAgentAddress: BRIDGE_AGENT,
      amountUnits: 1_000_000n,
      mintRecipient: MINT_RECIPIENT,
      relayer: RELAYER,
      sessionKey,
      server: {},
    })
    const call = buildAgentAuthedInvokeMock.mock.calls[0][0]
    expect(call.agentAddress).toBe(BRIDGE_AGENT)
    expect(call.signer).toBe(sessionKey) // the session key IS the signer, not a wallet kit
    expect(call.relayer).toBe(RELAYER) // source = relayer (fee-bump sponsor), not the user
  })
})

describe('runAgentBurn - relayed, session-key-signed, user-paid nothing', () => {
  it('resolves { burnHash } from a successful relay submit', async () => {
    const out = await runAgentBurn({
      bridgeAgentAddress: BRIDGE_AGENT,
      amountUnits: 2_000_000n,
      mintRecipient: MINT_RECIPIENT,
      sessionKey,
    })
    expect(out).toEqual({ burnHash: 'HBURN' })
    expect(submitViaRelayMock).toHaveBeenCalledWith({ xdr: 'SIGNED_XDR' })
  })

  it('returns null when the relay is unconfigured (no relayer address) — same contract as runAgentDeposit/runAgentPull', async () => {
    getRelayerAddressMock.mockResolvedValue(null)
    const out = await runAgentBurn({
      bridgeAgentAddress: BRIDGE_AGENT,
      amountUnits: 2_000_000n,
      mintRecipient: MINT_RECIPIENT,
      sessionKey,
    })
    expect(out).toBeNull()
    expect(buildAgentAuthedInvokeMock).not.toHaveBeenCalled()
  })

  it('a relay rejection bubbles with the method name for context, not a bare message', async () => {
    submitViaRelayMock.mockRejectedValue(new Error('The Stellar relay refused this transaction'))
    await expect(
      runAgentBurn({
        bridgeAgentAddress: BRIDGE_AGENT,
        amountUnits: 2_000_000n,
        mintRecipient: MINT_RECIPIENT,
        sessionKey,
      })
    ).rejects.toThrow(/deposit_for_burn:.*relay refused/)
  })

  it('a non-SUCCESS relay status throws with method context instead of silently returning a fake hash', async () => {
    submitViaRelayMock.mockResolvedValue({ hash: 'H', status: 'PENDING' })
    await expect(
      runAgentBurn({
        bridgeAgentAddress: BRIDGE_AGENT,
        amountUnits: 2_000_000n,
        mintRecipient: MINT_RECIPIENT,
        sessionKey,
      })
    ).rejects.toThrow(/deposit_for_burn:.*PENDING/)
  })
})
