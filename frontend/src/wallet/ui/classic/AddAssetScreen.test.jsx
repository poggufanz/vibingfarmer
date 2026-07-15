// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import AddAssetScreen from './AddAssetScreen.jsx'
import { KNOWN_ASSETS } from '../../trustline.js'

afterEach(() => {
  cleanup()
})

describe('AddAssetScreen', () => {
  it('quick-add chip fills code + issuer, enabling the button', () => {
    const onAddAsset = vi.fn()
    render(<AddAssetScreen onAddAsset={onAddAsset} />)
    const chipName = KNOWN_ASSETS[0].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(chipName) }))
    expect(screen.getByLabelText(/asset code/i).value).toBe(KNOWN_ASSETS[0].code)
    expect(screen.getByLabelText(/issuer/i).value).toBe(KNOWN_ASSETS[0].issuer)
    fireEvent.click(screen.getByRole('button', { name: /^add asset$/i }))
    expect(onAddAsset).toHaveBeenCalledWith(KNOWN_ASSETS[0].code, KNOWN_ASSETS[0].issuer)
  })

  it('shows an inline error and disables the button for an invalid code', () => {
    const onAddAsset = vi.fn()
    render(<AddAssetScreen onAddAsset={onAddAsset} />)
    fireEvent.change(screen.getByLabelText(/asset code/i), { target: { value: 'BAD CODE' } })
    fireEvent.change(screen.getByLabelText(/issuer/i), {
      target: { value: KNOWN_ASSETS[0].issuer },
    })
    expect(screen.getByText(/alphanumeric/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^add asset$/i }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^add asset$/i }))
    expect(onAddAsset).not.toHaveBeenCalled()
  })

  it('disables the button while busy even with a valid entry', () => {
    render(<AddAssetScreen onAddAsset={vi.fn()} busy error="" />)
    fireEvent.change(screen.getByLabelText(/asset code/i), { target: { value: 'USDC' } })
    fireEvent.change(screen.getByLabelText(/issuer/i), {
      target: { value: KNOWN_ASSETS[0].issuer },
    })
    expect(screen.getByRole('button', { name: /adding/i }).disabled).toBe(true)
  })
})
