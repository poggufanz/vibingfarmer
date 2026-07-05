// @vitest-environment jsdom
// frontend/src/screens/Withdraw.test.jsx
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Withdraw from './Withdraw.jsx'

vi.mock('../base/withdrawBatch.js', () => ({ signAndSubmitUnwind: vi.fn() }))
vi.mock('../base/relayerClient.js', () => ({ postUnwind: vi.fn(), pollFarmStatus: vi.fn() }))

import { signAndSubmitUnwind } from '../base/withdrawBatch.js'
import { postUnwind, pollFarmStatus } from '../base/relayerClient.js'

afterEach(() => {
  cleanup() // @testing-library/react v16 does not auto-clean; unmount between tests
  vi.clearAllMocks() // module-wide vi.mock spies otherwise leak call history across tests
})

describe('Withdraw screen', () => {
  test('one tap signs the batched unwind, hands it to the relayer, polls to done, shows the Stellar recipient', async () => {
    signAndSubmitUnwind.mockResolvedValue({ unwindTxHash: '0xUNWINDTX' })
    postUnwind.mockResolvedValue({ jobId: 'unwind-job-1' })
    pollFarmStatus.mockResolvedValue({ status: 'done' })

    render(
      <Withdraw
        ownerKernelAccount={{ address: '0xOWNER' }}
        publicClient={{}}
        withdrawals={[{ pool: '0xAAAA', shares: 100n, minAssets: 99n }]}
        stellarRecipient="GRECIPIENTOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO"
        totalAssetsForBurn={99n}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /withdraw/i }))

    await waitFor(() => expect(signAndSubmitUnwind).toHaveBeenCalled())
    await waitFor(() => expect(postUnwind).toHaveBeenCalledWith(expect.objectContaining({ unwindTxHash: '0xUNWINDTX' })))
    await waitFor(() => expect(screen.getByText(/done/i)).toBeTruthy())
    expect(screen.getByText(/GRECIPIENT/i)).toBeTruthy()
  })

  test('a hookData validation failure never reaches signAndSubmitUnwind and shows a clear error', async () => {
    signAndSubmitUnwind.mockRejectedValue(new Error('hookData payload does not decode as a plausible Stellar strkey: "short"'))

    render(
      <Withdraw
        ownerKernelAccount={{ address: '0xOWNER' }}
        publicClient={{}}
        withdrawals={[{ pool: '0xAAAA', shares: 1n, minAssets: 1n }]}
        stellarRecipient="short"
        totalAssetsForBurn={1n}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /withdraw/i }))
    await waitFor(() => expect(screen.getByText(/strkey/i)).toBeTruthy())
    expect(postUnwind).not.toHaveBeenCalled()
  })
})
