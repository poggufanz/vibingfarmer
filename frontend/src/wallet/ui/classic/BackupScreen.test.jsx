// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import BackupScreen from './BackupScreen.jsx'

describe('BackupScreen', () => {
  it('reveals the phrase and only confirms with correct words', () => {
    const onConfirm = vi.fn()
    const { container } = render(
      <BackupScreen
        mnemonic="alpha bravo charlie delta"
        indices={[1]}
        onConfirm={onConfirm}
        onSkip={() => {}}
      />
    )
    // hidden until reveal (step 1)
    expect(screen.queryByText('bravo')).toBeNull()
    expect(container.querySelector('.bk-prog-fill')?.style.transform).toBe('scaleX(0)')
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }))
    // Deviation from brief: use .toBeTruthy() instead of .toBeInTheDocument() (no jest-dom setup
    // in this project — see ApproveOverlay.test.jsx for the same precedent).
    expect(screen.getByText('bravo')).toBeTruthy()
    expect(container.querySelector('.bk-prog-fill')?.style.transform).toBe('scaleX(0.5)')
    // step 2 → 3: "Continue to verification" is gated on the saved checkbox
    const continueBtn = screen.getByRole('button', { name: /continue to verification/i })
    expect(continueBtn.disabled).toBe(true)
    // the native checkbox is visually hidden (custom-styled) — include hidden elements
    fireEvent.click(screen.getByRole('checkbox', { hidden: true }))
    fireEvent.click(continueBtn)
    // step 3: wrong word blocks confirm
    fireEvent.change(screen.getByLabelText(/word #2/i), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(onConfirm).not.toHaveBeenCalled() // wrong word blocks
    // correct word confirms
    fireEvent.change(screen.getByLabelText(/word #2/i), { target: { value: 'bravo' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(onConfirm).toHaveBeenCalledWith([{ index: 1, word: 'bravo' }])
  })
})
