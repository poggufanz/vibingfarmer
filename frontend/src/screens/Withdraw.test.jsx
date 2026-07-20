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

const baseProps = {
  ownerKernelAccount: { address: '0xOWNER' },
  publicClient: {},
  withdrawals: [{ pool: '0xAAAA', shares: 100n, minAssets: 1_500_000n }],
  stellarRecipient: 'GRECIPIENTOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO',
  totalAssetsForBurn: 1_500_000n,
  poolName: 'Aave USDC',
  onClose: vi.fn(),
}

describe('Withdraw screen', () => {
  test('one tap signs the batched unwind, hands it to the relayer, polls to done, shows the Stellar recipient', async () => {
    signAndSubmitUnwind.mockResolvedValue({ unwindTxHash: '0xUNWINDTX' })
    postUnwind.mockResolvedValue({ jobId: 'unwind-job-1' })
    pollFarmStatus.mockResolvedValue({ status: 'done' })

    render(<Withdraw {...baseProps} />)

    expect(screen.getByRole('dialog', { name: /withdraw from aave usdc/i })).toBeTruthy()
    expect(screen.getByText('1.50')).toBeTruthy()
    expect(screen.getByTestId('base-withdraw-recipient').textContent).toMatch(/GRECIPIENT/)

    fireEvent.click(screen.getByRole('button', { name: /withdraw 1\.50 usdc/i }))

    await waitFor(() => expect(signAndSubmitUnwind).toHaveBeenCalled())
    await waitFor(() =>
      expect(postUnwind).toHaveBeenCalledWith(
        expect.objectContaining({ unwindTxHash: '0xUNWINDTX' })
      )
    )
    await waitFor(() => expect(screen.getByText(/unwind complete/i)).toBeTruthy())
    expect(screen.getByTestId('base-withdraw-recipient').textContent).toMatch(/GRECIPIENT/)
  })

  test('a hookData validation failure never reaches signAndSubmitUnwind and shows a clear error', async () => {
    signAndSubmitUnwind.mockRejectedValue(
      new Error('hookData payload does not decode as a plausible Stellar strkey: "short"')
    )

    render(
      <Withdraw
        {...baseProps}
        stellarRecipient="short"
        withdrawals={[{ pool: '0xAAAA', shares: 1n, minAssets: 1n }]}
        totalAssetsForBurn={1n}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /withdraw/i }))
    await waitFor(() => expect(screen.getByText(/strkey/i)).toBeTruthy())
    expect(postUnwind).not.toHaveBeenCalled()
  })

  test('cancel closes when idle; shows loading spinner while busy', async () => {
    const onClose = vi.fn()
    signAndSubmitUnwind.mockImplementation(() => new Promise(() => {})) // hang in signing

    render(<Withdraw {...baseProps} onClose={onClose} totalAssetsForBurn={1_000_000n} />)

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
    onClose.mockClear()

    fireEvent.click(screen.getByRole('button', { name: /withdraw/i }))
    await waitFor(() => expect(signAndSubmitUnwind).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /cancel/i }).disabled).toBe(true)
    expect(screen.getByText(/confirm the passkey prompt/i)).toBeTruthy()
    expect(document.querySelectorAll('.think-spin').length).toBeGreaterThan(0)
  })
})
