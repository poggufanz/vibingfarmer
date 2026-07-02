// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import SendScreen from './SendScreen.jsx'

// No global RTL auto-cleanup is registered for this project's vitest config
// (globals: false, no setupFiles), so isolate each test's DOM explicitly.
afterEach(() => {
  cleanup()
})

describe('SendScreen', () => {
  it('requires a preview (clear-sign) before confirm is enabled', () => {
    const onPreview = vi.fn()
    const onConfirm = vi.fn()
    render(<SendScreen from="GME" onPreview={onPreview} onConfirm={onConfirm} preview={null} />)
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'GYOU' } })
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ to: 'GYOU', amount: '1' }))
    // confirm not present until a preview is supplied
    expect(screen.queryByRole('button', { name: /confirm & send/i })).toBeNull()
  })

  it('disables confirm when inputs change after preview (no stale sign)', () => {
    const onConfirm = vi.fn()
    const preview = {
      confirm: { ops: [{ destination: 'GYOU', asset: 'XLM', amount: '1' }], memo: '', fee: 100 },
      vault: { hit: false },
    }
    const { rerender } = render(
      <SendScreen from="GME" onPreview={() => {}} onConfirm={onConfirm} preview={null} />
    )
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'GYOU' } })
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } })
    // parent supplies the matching preview → confirm enabled
    rerender(<SendScreen from="GME" onPreview={() => {}} onConfirm={onConfirm} preview={preview} />)
    const confirm = screen.getByRole('button', { name: /confirm & send/i })
    expect(confirm.disabled).toBe(false)
    // edit destination after preview → stale → confirm blocked
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'GEVIL' } })
    expect(screen.getByRole('button', { name: /confirm & send/i }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /confirm & send/i }))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
