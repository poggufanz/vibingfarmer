// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import BackupScreen from './BackupScreen.jsx'

describe('BackupScreen', () => {
  it('reveals the phrase and only confirms with correct words', () => {
    const onConfirm = vi.fn()
    render(
      <BackupScreen
        mnemonic="alpha bravo charlie delta"
        indices={[1]}
        onConfirm={onConfirm}
        onSkip={() => {}}
      />
    )
    // hidden until reveal
    expect(screen.queryByText('bravo')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }))
    // Deviation from brief: use .toBeTruthy() instead of .toBeInTheDocument() (no jest-dom setup
    // in this project — see ApproveOverlay.test.jsx for the same precedent).
    expect(screen.getByText('bravo')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/word #2/i), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(onConfirm).not.toHaveBeenCalled() // wrong word blocks
  })
})
