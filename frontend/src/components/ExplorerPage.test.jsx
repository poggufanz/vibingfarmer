// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../../deployments/stellar-testnet.json'
import ExplorerPage from './ExplorerPage.jsx'

vi.mock('../stellar/vaultReads.js', () => ({
  readTotalAssets: vi.fn(async () => 0),
}))

afterEach(cleanup)

describe('ExplorerPage deployment facts', () => {
  it('renders the complete categorized Stellar deployment surface', () => {
    render(
      <MemoryRouter initialEntries={['/explorer']}>
        <ExplorerPage />
      </MemoryRouter>
    )

    expect(
      screen.getByText(
        '8 static Stellar testnet addresses: 6 Vibing Farmer deployments and 2 external protocol contracts. Agent accounts are created dynamically per run.'
      )
    ).toBeTruthy()
    expect(screen.getByText('Soroban source crates')).toBeTruthy()
    expect(screen.getByText('VF deployments')).toBeTruthy()
    expect(screen.getByText('Protocol contracts')).toBeTruthy()
    expect(screen.getByText('Dynamic agents')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
    expect(screen.getByText('6')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('8 static addresses')).toBeTruthy()
    expect(screen.getByText('N per run')).toBeTruthy()

    const addresses = [
      manifest.fundingRouter.addressV2,
      manifest.autofarmVault.address,
      manifest.strategy1.address,
      manifest.exitRouter.address,
      manifest.attestation,
      manifest.registry,
      manifest.strategy1.pool,
      manifest.fundingRouter.token,
    ]
    for (const address of addresses) expect(screen.getByText(address)).toBeTruthy()

    expect(screen.queryByText(manifest.agentAccountWasmHash)).toBeNull()
    expect(screen.queryByText('Contract Tests')).toBeNull()
    expect(screen.queryByText('Every deployed contract')).toBeNull()
  })
})
