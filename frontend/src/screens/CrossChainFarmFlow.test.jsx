// @vitest-environment jsdom
// frontend/src/screens/CrossChainFarmFlow.test.jsx
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import CrossChainFarmFlow from './CrossChainFarmFlow.jsx'

afterEach(() => {
  cleanup() // @testing-library/react v16 does not auto-clean; unmount between tests
  vi.clearAllMocks() // module-wide vi.mock spies otherwise leak call history across tests
  delete window.__vfDevMandateFixture // DEV-only global the mandate step writes; never leak across tests
})

vi.mock('../wallet/passkeyStellar.js', () => ({ createStellarPasskeyWallet: vi.fn() }))
vi.mock('../wallet/passkeyBase.js', () => ({ createBaseSmartAccount: vi.fn() }))
vi.mock('../wallet/mandate.js', () => ({ createMandate: vi.fn() }))
vi.mock('../venice.js', () => ({ allocateBasePools: vi.fn() }))
vi.mock('../base/relayerClient.js', () => ({
  postMandate: vi.fn(),
  postFarm: vi.fn(),
  pollFarmStatus: vi.fn(),
  postUnwind: vi.fn(),
}))

import { createStellarPasskeyWallet } from '../wallet/passkeyStellar.js'
import { createBaseSmartAccount } from '../wallet/passkeyBase.js'
import { createMandate } from '../wallet/mandate.js'
import { allocateBasePools } from '../venice.js'
import { postMandate } from '../base/relayerClient.js'

const STELLAR_WALLET = { address: 'GWALLET', credentialId: 'cred-1', signBurn: vi.fn() }
const BASE_ACCOUNT = {
  address: '0xBASEACCT',
  kernelAccount: { address: '0xBASEACCT' },
  publicClient: {},
  passkeyValidator: {},
}
const ALLOCATIONS = [
  {
    pool: '0xAAAA',
    protocol: 'aave-v3',
    amount: 60,
    minShares: 59n,
    expectedApy: 5.1,
    riskTier: 'low',
    skill: {},
  },
  {
    pool: '0xBBBB',
    protocol: 'morpho-blue',
    amount: 40,
    minShares: 39n,
    expectedApy: 6.8,
    riskTier: 'medium',
    skill: {},
  },
]
const MANDATE_RESULT = {
  serializedApproval: 'approval-blob',
  sessionKeyAddress: '0xSESSION',
  sessionPrivateKey: '0xSECRETKEY',
  permissions: [],
  expiry: 9999999999,
}

async function completeOnboarding() {
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: 'demo@vibingfarmer.xyz' },
  })
  fireEvent.click(screen.getByRole('button', { name: /create passkey wallets/i }))
  await waitFor(() => screen.getByRole('button', { name: /create mandate/i }))
}

describe('CrossChainFarmFlow', () => {
  test('walks onboard -> mandate -> farm, registering the mandate exactly once before rendering Farm', async () => {
    createStellarPasskeyWallet.mockResolvedValue(STELLAR_WALLET)
    createBaseSmartAccount.mockResolvedValue(BASE_ACCOUNT)
    // allocateBasePools is LLM-backed and non-deterministic: a hypothetical second call returns a
    // DIFFERENT allocation. The farm step must use the FIRST (mandate-time) one — anything else
    // could fall outside the session-key caps and revert on-chain.
    allocateBasePools.mockResolvedValueOnce(ALLOCATIONS).mockResolvedValue([
      {
        pool: '0xDDDD',
        protocol: 'drifted-pool',
        amount: 100,
        minShares: 99n,
        expectedApy: 9.9,
        riskTier: 'high',
        skill: {},
      },
    ])
    createMandate.mockResolvedValue(MANDATE_RESULT)
    postMandate.mockResolvedValue({ ok: true })

    render(<CrossChainFarmFlow />)

    await completeOnboarding()

    expect(createStellarPasskeyWallet).toHaveBeenCalledWith({ email: 'demo@vibingfarmer.xyz' })
    expect(createBaseSmartAccount).toHaveBeenCalledWith({
      passkeyName: 'demo@vibingfarmer.xyz',
      mode: 'register',
    })

    // Mandate step renders both onboarded addresses — smoke-mandate.mjs waits on these testids,
    // and a real user needs the Stellar address visible to fund the fresh wallet.
    expect(screen.getByTestId('stellar-wallet-address').textContent).toBe(STELLAR_WALLET.address)
    expect(screen.getByTestId('base-account-address').textContent).toBe(BASE_ACCOUNT.address)

    fireEvent.click(screen.getByRole('button', { name: /create mandate/i }))

    await waitFor(() => expect(createMandate).toHaveBeenCalled())
    const mandateCall = createMandate.mock.calls[0][0]
    expect(mandateCall.pools).toEqual([
      { pool: '0xAAAA', cap: 60_000_000n },
      { pool: '0xBBBB', cap: 40_000_000n },
    ])
    expect(mandateCall.kernelAccount).toBe(BASE_ACCOUNT.kernelAccount)
    expect(mandateCall.publicClient).toBe(BASE_ACCOUNT.publicClient)
    expect(mandateCall.passkeyValidator).toBe(BASE_ACCOUNT.passkeyValidator)
    expect(typeof mandateCall.expiry).toBe('number')
    expect(mandateCall.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000))

    await waitFor(() =>
      expect(postMandate).toHaveBeenCalledWith({
        serializedApproval: 'approval-blob',
        sessionPrivateKey: '0xSECRETKEY',
      })
    )
    expect(postMandate).toHaveBeenCalledTimes(1)

    // Farm renders (real component) with the SAME allocations that built the mandate caps —
    // exactly one allocateBasePools call total; the drifted second result never appears.
    await waitFor(() => expect(screen.getByText(/aave-v3/i)).toBeTruthy())
    expect(screen.getByText(/morpho-blue/i)).toBeTruthy()
    expect(screen.queryByText(/drifted-pool/i)).toBeNull()
    expect(allocateBasePools).toHaveBeenCalledTimes(1)

    // Farm step renders truncated approval evidence — smoke-mandate.mjs waits on this testid.
    expect(screen.getByTestId('mandate-serialized-approval').textContent).toBe(
      `${MANDATE_RESULT.serializedApproval.slice(0, 16)}…`
    )

    // DEV-only fixture: the smoke script's out-of-policy scenarios (window.__vfDevDispatchRawCall)
    // read live session material from here instead of vacuously passing. Under vitest,
    // import.meta.env.DEV is true, so the assignment in handleCreateMandate runs.
    expect(window.__vfDevMandateFixture).toEqual({
      publicClient: BASE_ACCOUNT.publicClient,
      serializedApproval: MANDATE_RESULT.serializedApproval,
      sessionPrivateKey: MANDATE_RESULT.sessionPrivateKey,
      pool: ALLOCATIONS[0].pool,
    })
  })

  test('surfaces an onboarding error without advancing past the onboard step', async () => {
    createStellarPasskeyWallet.mockRejectedValue(new Error('WebAuthn ceremony cancelled'))

    render(<CrossChainFarmFlow />)
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'demo@vibingfarmer.xyz' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create passkey wallets/i }))

    await waitFor(() => expect(screen.getByText(/webauthn ceremony cancelled/i)).toBeTruthy())
    expect(createBaseSmartAccount).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /create mandate/i })).toBeNull()
  })

  test('surfaces a mandate error and never calls postMandate when createMandate rejects', async () => {
    createStellarPasskeyWallet.mockResolvedValue(STELLAR_WALLET)
    createBaseSmartAccount.mockResolvedValue(BASE_ACCOUNT)
    allocateBasePools.mockResolvedValue(ALLOCATIONS)
    createMandate.mockRejectedValue(new Error('policy build failed'))

    render(<CrossChainFarmFlow />)
    await completeOnboarding()
    fireEvent.click(screen.getByRole('button', { name: /create mandate/i }))

    await waitFor(() => expect(screen.getByText(/policy build failed/i)).toBeTruthy())
    expect(postMandate).not.toHaveBeenCalled()
    expect(screen.queryByText(/aave-v3/i)).toBeNull()
  })
})
