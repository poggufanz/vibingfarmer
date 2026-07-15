// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TokenIcon, tokenName } from './tokenIcons.jsx'
import { VF_TESTNET_ISSUER } from '../../trustline.js'

afterEach(() => {
  cleanup()
})

const usdc = `USDC:${VF_TESTNET_ISSUER}`

describe('tokenIcons', () => {
  it('renders the brand mark and real name for a known asset', () => {
    render(<TokenIcon asset={usdc} code="USDC" />)
    expect(screen.getByRole('img', { name: 'USDC logo' }).tagName).toBe('svg')
    expect(tokenName(usdc)).toBe('USD Coin')
    expect(tokenName('XLM')).toBe('Stellar Lumens')
    expect(tokenName(`BLND:${VF_TESTNET_ISSUER}`)).toBe('Blend')
  })

  it('denies a known code from an unknown issuer the brand mark', () => {
    const impostor = 'USDC:GBADISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const { container } = render(<TokenIcon asset={impostor} code="USDC" />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.querySelector('.vf-token-icon.unknown')?.textContent).toBe('US')
    expect(tokenName(impostor)).toBe('Token')
  })

  it('falls back to an initials circle for an unknown asset', () => {
    const { container } = render(<TokenIcon asset="FOO:GXYZ" code="FOO" />)
    expect(container.querySelector('.vf-token-icon.unknown')?.textContent).toBe('FO')
  })
})
