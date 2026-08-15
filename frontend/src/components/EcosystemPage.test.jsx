// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import EcosystemPage from './EcosystemPage.jsx'
import { BASE_PROXY_TRUTH, createEcosystemModel } from '../secondary/ecosystemModel.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function renderPage(ecosystemRead = createEcosystemModel()) {
  return render(
    <MemoryRouter initialEntries={['/ecosystem']}>
      <EcosystemPage ecosystemRead={ecosystemRead} />
    </MemoryRouter>
  )
}

describe('EcosystemPage', () => {
  it('keeps one route heading and the exact ordered catalog in a keyboard-readable list', () => {
    renderPage()

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Ecosystem' })).toBeTruthy()

    const list = screen.getByRole('list', { name: 'Ecosystem services' })
    expect(
      [...list.querySelectorAll('[data-ecosystem-list-card]')].map(
        (row) => row.dataset.ecosystemListCard
      )
    ).toEqual([
      'stellar-soroban',
      'autofarm-vault',
      'blend-capital-v2',
      'base-sepolia-proxy',
      'circle-cctp',
      'openzeppelin',
      'defillama',
      'zerodev',
    ])
    expect(list.querySelectorAll('li')).toHaveLength(8)
  })

  it('keeps Base custody truth adjacent to Base Sepolia and never renders an APY', () => {
    renderPage()

    const baseRow = screen.getByTestId('ecosystem-row-base-sepolia-proxy')
    expect(within(baseRow).getByText('Base Sepolia')).toBeTruthy()
    expect(within(baseRow).getByText(BASE_PROXY_TRUTH)).toBeTruthy()
    expect(within(baseRow).queryByText(/APY/i)).toBeNull()
    expect(within(baseRow).getByText(/Source:/)).toBeTruthy()

    const blendRow = screen.getByTestId('ecosystem-row-blend-capital-v2')
    expect(within(blendRow).queryByText(/APY/i)).toBeNull()
  })

  it.each(['loading', 'current', 'stale', 'empty', 'partial', 'error', 'unavailable'])(
    'projects the source-owned %s state without hiding the service list',
    (state) => {
      renderPage(createEcosystemModel({ state }))

      expect(document.querySelector(`[data-fact-state="${state}"]`)).toBeTruthy()
      expect(screen.getByRole('list', { name: 'Ecosystem services' })).toBeTruthy()
      expect(screen.getAllByText('Stellar / Soroban').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Base Sepolia proxy').length).toBeGreaterThan(0)
      expect(screen.getAllByText(/Source:/).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/Checked at/).length).toBeGreaterThan(0)
      const consequence = {
        loading: /Checking ecosystem read\./i,
        current: /Verified from catalog\./i,
        stale: /Showing the last known value\./i,
        empty: /The source confirmed no records\./i,
        partial: /Some sources responded; the rest are unknown\./i,
        error: /The ecosystem read failed; movement is not confirmed\./i,
        unavailable: /We cannot verify this fact right now\./i,
      }[state]
      expect(screen.getAllByText(consequence).length).toBeGreaterThan(0)
    }
  )

  it('marks mainnet lending as Planned and keeps its APY fact absent', () => {
    renderPage(createEcosystemModel({ deployment: 'mainnet' }))

    for (const id of ['autofarm-vault', 'blend-capital-v2']) {
      const row = screen.getByTestId(`ecosystem-row-${id}`)
      expect(within(row).getByText('Planned')).toBeTruthy()
      expect(within(row).getByText('Network: Mainnet')).toBeTruthy()
      expect(within(row).queryByText(/APY/i)).toBeNull()
    }
  })

  it('keeps the CTA side effects and renders the shared route primitives', () => {
    renderPage()

    expect(document.querySelector('.pc-stage-shell')).toBeTruthy()
    expect(document.querySelector('.network-route')).toBeTruthy()
    expect(document.querySelector('.pc-status-notice')).toBeTruthy()
    expect(document.querySelector('.pc-technical-details')).toBeTruthy()
    expect(document.querySelector('.pc-venue-truth--proxy')).toBeTruthy()
    expect(screen.getByRole('img', { name: /Architecture: wallet limits/i })).toBeTruthy()

    const launchButtons = screen.getAllByRole('button', { name: 'Launch app' })
    fireEvent.click(launchButtons.at(-1))
    expect(localStorage.getItem('yv_skip_landing')).toBe('true')
    expect(localStorage.getItem('yv_onboarded')).toBe('true')
  })

  it('keeps the diagram statically comprehensible without forbidden visual declarations', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/EcosystemPage.jsx'), 'utf8')
    const css = readFileSync(resolve(process.cwd(), 'src/components/EcosystemPage.css'), 'utf8')

    expect(source).not.toMatch(/IntersectionObserver|feGaussianBlur|stroke-dasharray|is-visible/iu)
    expect(css).not.toMatch(/blur|dash|pulse|@keyframes|animation/iu)
    expect(document.querySelector('.eco-diagram')).toBeNull()

    renderPage()
    expect(document.querySelector('.eco-diagram')).toBeTruthy()
    expect(document.querySelector('.arch-svg')).toBeTruthy()
  })
})
