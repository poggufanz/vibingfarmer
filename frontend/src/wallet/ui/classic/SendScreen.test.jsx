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
    const onPreview = vi.fn()
    // Preview amount is the SDK-canonicalized decode ('1' -> '1.0000000'), matching
    // real previewSend()/buildPaymentXdr()/decodeForConfirm() output. The gate must
    // compare against the Review-time input snapshot, not this decoded value, so it
    // must NOT misfire on canonicalization alone.
    const preview = {
      confirm: {
        ops: [{ destination: 'GYOU', asset: 'XLM', amount: '1.0000000' }],
        memo: '',
        fee: 100,
      },
      vault: { hit: false },
    }
    const { rerender } = render(
      <SendScreen from="GME" onPreview={onPreview} onConfirm={onConfirm} preview={null} />
    )
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'GYOU' } })
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ to: 'GYOU', amount: '1' }))
    // parent supplies the canonicalized preview → confirm still enabled (snapshot match)
    rerender(
      <SendScreen from="GME" onPreview={onPreview} onConfirm={onConfirm} preview={preview} />
    )
    const confirm = screen.getByRole('button', { name: /confirm & send/i })
    expect(confirm.disabled).toBe(false)
    // edit destination after preview → stale → confirm blocked
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'GEVIL' } })
    expect(screen.getByRole('button', { name: /confirm & send/i }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /confirm & send/i }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText(/inputs changed/i)).toBeTruthy()
  })

  it('gates ApproveOverlay approve on preview match for vault-hit deposits (no stale sign)', () => {
    const onConfirm = vi.fn()
    const onPreview = vi.fn()
    const preview = {
      confirm: {
        ops: [{ destination: 'GVAULT', asset: 'XLM', amount: '1.0000000' }],
        memo: '',
        fee: 100,
      },
      vault: { hit: true, name: 'Demo Vault', allow: true, reasons: ['eligible'] },
    }
    const { rerender } = render(
      <SendScreen from="GME" onPreview={onPreview} onConfirm={onConfirm} preview={null} />
    )
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'GVAULT' } })
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    rerender(
      <SendScreen from="GME" onPreview={onPreview} onConfirm={onConfirm} preview={preview} />
    )
    // edit amount after preview → stale, even though ApproveOverlay's own eligible
    // check (verdict.allow) would otherwise leave its approve button enabled
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /approve with face id/i }))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
