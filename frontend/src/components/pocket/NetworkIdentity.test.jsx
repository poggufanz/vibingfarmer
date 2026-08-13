// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { NETWORK_IDS } from '../../design/networks.js'
import { NetworkBadge, NetworkRoute } from './NetworkIdentity.jsx'

expect.extend(axeMatchers)

afterEach(cleanup)

const THEMES = ['forest', 'day-field']

function renderThemed(theme, ui) {
  return render(<div data-theme={theme}>{ui}</div>)
}

describe('NetworkBadge', () => {
  for (const theme of THEMES) {
    it(`renders the Stellar testnet mark + visible label at 16px (${theme})`, () => {
      const { container } = renderThemed(
        theme,
        <NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} size={16} />
      )
      expect(screen.getByText('Stellar testnet')).toBeTruthy()
      // The mark is decorative (alt="" -> role "presentation", not "img") on purpose: the visible
      // text label is the only accessible name here. Query the element directly, not by role.
      const img = container.querySelector('img')
      expect(img.getAttribute('alt')).toBe('')
      expect(img.getAttribute('src')).toBe('/brand/networks/stellar.svg')
      expect(img.getAttribute('width')).toBe('16')
    })

    it(`renders the Base Sepolia mark + visible label at 14px (${theme})`, () => {
      const { container } = renderThemed(
        theme,
        <NetworkBadge networkId={NETWORK_IDS.BASE_SEPOLIA} size={14} />
      )
      expect(screen.getByText('Base Sepolia')).toBeTruthy()
      const img = container.querySelector('img')
      expect(img.getAttribute('alt')).toBe('')
      expect(img.getAttribute('src')).toBe('/brand/networks/base.svg')
      expect(img.getAttribute('width')).toBe('14')
    })
  }

  it('falls back to a neutral outlined glyph + visible "Unknown network" text for an unrecognized id', () => {
    const { container } = render(<NetworkBadge networkId="polygon-mumbai" />)
    expect(screen.getByText('Unknown network')).toBeTruthy()
    // no <img> at all for the fallback -- it's an inline decorative svg glyph, never an empty icon
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg.network-mark--fallback')).toBeTruthy()
  })

  it('falls back to the neutral glyph for a null networkId too', () => {
    render(<NetworkBadge networkId={null} />)
    expect(screen.getByText('Unknown network')).toBeTruthy()
  })

  it('clamps an out-of-range size to 16 rather than shipping an unreadable mark', () => {
    const { container } = render(<NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} size={40} />)
    expect(container.querySelector('img').getAttribute('width')).toBe('16')
  })

  it('accepts 14 explicitly without clamping it up to 16', () => {
    const { container } = render(<NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} size={14} />)
    expect(container.querySelector('img').getAttribute('width')).toBe('14')
  })

  it('uses 14px for compact badges and clamps an invalid compact size to 14px', () => {
    const { container } = render(
      <>
        <NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} compact />
        <NetworkBadge networkId={NETWORK_IDS.BASE_SEPOLIA} compact size={40} />
      </>
    )
    const widths = Array.from(container.querySelectorAll('img')).map((img) =>
      img.getAttribute('width')
    )
    expect(widths).toEqual(['14', '14'])
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    expect(screen.getByText('Base Sepolia')).toBeTruthy()
  })

  it('has zero axe violations for a known network', async () => {
    const { container } = render(<NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero axe violations for the unknown-network fallback', async () => {
    const { container } = render(<NetworkBadge networkId="polygon-mumbai" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('NetworkRoute', () => {
  it('renders a single badge (no arrow) for a same-network Stellar deposit', () => {
    render(
      <NetworkRoute
        context={{
          hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          transitState: 'none',
        }}
      />
    )
    expect(screen.getAllByText('Stellar testnet')).toHaveLength(1)
    expect(screen.queryByRole('img', { name: 'to' })).toBeNull()
  })

  it('renders source, arrow, destination, and a truthful mid-bridge status (never claiming Base custody)', () => {
    render(
      <NetworkRoute
        context={{
          hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA, // raw input lies about arrival
          transitState: 'burning',
        }}
      />
    )
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    expect(screen.getByText('Base Sepolia')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'to' })).toBeTruthy()
    expect(screen.getByText('Bridging from Stellar testnet')).toBeTruthy()
    expect(screen.queryByText(/Arrived/)).toBeNull()
  })

  it('renders the arrived status once transitState is arrived', () => {
    render(
      <NetworkRoute
        context={{
          hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          transitState: 'arrived',
        }}
      />
    )
    expect(screen.getByText('Arrived on Base Sepolia')).toBeTruthy()
  })

  it('distinguishes the bridge host from custody once funds have arrived elsewhere', () => {
    render(
      <NetworkRoute
        context={{
          hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          transitState: 'arrived',
        }}
      />
    )
    expect(screen.getByText('Hosted on Stellar testnet')).toBeTruthy()
  })

  it('omits the host note while the bridge is still in flight (host already equals custody)', () => {
    render(
      <NetworkRoute
        context={{
          hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          transitState: 'burning',
        }}
      />
    )
    expect(screen.queryByText(/^Hosted on/)).toBeNull()
  })

  it('renders no duplicate accessible name between the source and destination mark images', () => {
    const { container } = render(
      <NetworkRoute
        context={{
          sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          transitState: 'burning',
        }}
      />
    )
    // Both marks are plain decorative <img alt=""> (role "presentation", not "img"), so query
    // them directly rather than by role.
    const images = Array.from(container.querySelectorAll('img'))
    expect(images).toHaveLength(2)
    // both marks are decorative (alt="") -- the visible labels carry the names, so no two images
    // ever compete for the same accessible name.
    expect(images.every((img) => img.getAttribute('alt') === '')).toBe(true)
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    expect(screen.getByText('Base Sepolia')).toBeTruthy()
  })

  it('never renders an empty icon for an unknown identifier in a route', () => {
    render(
      <NetworkRoute
        context={{
          sourceNetworkId: 'polygon-mumbai',
          destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
        }}
      />
    )
    expect(screen.getByText('Unknown network')).toBeTruthy()
    expect(screen.getByText('Base Sepolia')).toBeTruthy()
  })

  it.each([false, true])(
    'keeps a missing source as Unknown network instead of borrowing the host (%s)',
    (compact) => {
      render(
        <NetworkRoute
          compact={compact}
          context={{
            hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
            sourceNetworkId: null,
            destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
            custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
            transitState: 'arrived',
          }}
        />
      )
      expect(screen.getByText('Source: Unknown network')).toBeTruthy()
      expect(screen.getByText('Destination: Base Sepolia')).toBeTruthy()
      expect(screen.getByText('Custody: Base Sepolia')).toBeTruthy()
      if (!compact) expect(screen.getByText('Hosted on Stellar testnet')).toBeTruthy()
    }
  )

  it.each([false, true])(
    'keeps a missing destination as Unknown network instead of borrowing the source (%s)',
    (compact) => {
      const { container } = render(
        <NetworkRoute
          compact={compact}
          context={{
            hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
            sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
            destinationNetworkId: null,
            custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
            transitState: 'burning',
          }}
        />
      )
      expect(screen.getByText('Source: Stellar testnet')).toBeTruthy()
      expect(screen.getByText('Destination: Unknown network')).toBeTruthy()
      expect(screen.getByText('Custody: Stellar testnet')).toBeTruthy()
      expect(container.querySelector('.network-route-arrow')).toBeNull()
      expect(screen.getByText(/Bridging from Stellar testnet/)).toBeTruthy()
    }
  )

  it('compact mode keeps source, destination, custody, and transit status text', () => {
    render(
      <NetworkRoute
        compact
        context={{
          sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          transitState: 'minting',
        }}
      />
    )
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    expect(screen.getByText('Base Sepolia')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'to' })).toBeTruthy()
    expect(screen.getByText('Source: Stellar testnet')).toBeTruthy()
    expect(screen.getByText('Destination: Base Sepolia')).toBeTruthy()
    expect(screen.getByText('Custody: Stellar testnet')).toBeTruthy()
    expect(screen.getByText(/Status: In transit/)).toBeTruthy()
  })

  it.each([
    ['burning', /In transit/],
    ['attesting', /In transit/],
    ['minting', /In transit/],
    ['arrived', /Arrived/],
    ['failed', /Failed/],
    ['unknown', /Unavailable/],
  ])('renders an explicit %s status in both route variants', (transitState, status) => {
    const context = {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId:
        transitState === 'arrived' ? NETWORK_IDS.BASE_SEPOLIA : NETWORK_IDS.STELLAR_TESTNET,
      transitState,
    }

    for (const compact of [false, true]) {
      const { container, unmount } = render(<NetworkRoute compact={compact} context={context} />)
      expect(screen.getByText('Source: Stellar testnet')).toBeTruthy()
      expect(screen.getByText('Destination: Base Sepolia')).toBeTruthy()
      expect(screen.getByText(/Custody:/)).toBeTruthy()
      expect(container.querySelector('.network-route-status-kind').textContent).toMatch(status)
      unmount()
    }
  })

  it('shows neutral unavailable status and unknown network labels when route evidence is missing', () => {
    render(
      <NetworkRoute
        compact
        context={{
          sourceNetworkId: 'future-chain',
          destinationNetworkId: null,
          custodyNetworkId: null,
          transitState: 'unknown',
        }}
      />
    )
    expect(screen.getAllByText('Unknown network').length).toBeGreaterThan(0)
    expect(screen.getByText('Source: Unknown network')).toBeTruthy()
    expect(screen.getByText('Destination: Unknown network')).toBeTruthy()
    expect(screen.getByText('Custody: Unknown network')).toBeTruthy()
    expect(screen.getByText('Status: Unavailable')).toBeTruthy()
  })

  it('has zero axe violations for a full (non-compact) bridge route', async () => {
    const { container } = render(
      <NetworkRoute
        context={{
          hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
          transitState: 'arrived',
        }}
      />
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero axe violations for the single-network (no-bridge) case', async () => {
    const { container } = render(
      <NetworkRoute
        context={{
          hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
          transitState: 'none',
        }}
      />
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
