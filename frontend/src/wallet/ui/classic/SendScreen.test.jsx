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
    expect(screen.queryByRole('button', { name: /confirm and send/i })).toBeNull()
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
    const confirm = screen.getByRole('button', { name: /confirm and send/i })
    expect(confirm.disabled).toBe(false)
    // edit destination after preview → stale → confirm blocked
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'GEVIL' } })
    expect(screen.getByRole('button', { name: /confirm and send/i }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /confirm and send/i }))
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

// VF Wallet Task 10, Step 2 -- Passkey (C) Send has no real submit path yet (popup.jsx's old
// passkey send handler only ever built unsigned XDR and said so out loud). Rendering the form for
// an unsupported account would be a dead button that fails on submit, not a fail-closed UI.
describe('SendScreen — action availability is model-specific (no dead button for an unsupported account)', () => {
  it('renders the real form by default (supported, the existing Standard/G path)', () => {
    render(<SendScreen from="GME" onPreview={vi.fn()} onConfirm={vi.fn()} preview={null} />)
    expect(screen.getByLabelText(/destination/i)).toBeTruthy()
  })

  it('renders no form and no submit control when supported is false', () => {
    const onPreview = vi.fn()
    render(
      <SendScreen
        from="CFAKE"
        onPreview={onPreview}
        onConfirm={vi.fn()}
        preview={null}
        supported={false}
      />
    )
    expect(screen.queryByLabelText(/destination/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull()
    expect(screen.getByText(/not available yet/i)).toBeTruthy()
    expect(onPreview).not.toHaveBeenCalled()
  })
})

// VF Wallet Task 10 fix loop 1 (coordinator follow-up, SendScreen overflow): real-Chromium
// measurement found the confirm card's full, untruncated destination address forced
// .pc-wallet-main's shared implicit grid column (header and nav included) to 465.46875px at a 320
// viewport -- the same mechanism WalletReceive's full address overflow used, fixed the same way
// (.pc-address-full alongside .pc-technical). jsdom does no layout and cannot re-run that geometry
// check itself (the same limitation WalletReceive.test.jsx documents for its own guard), so this
// pins the STRUCTURAL fix instead: the confirm card's destination line must carry
// .pc-address-full, which is what actually prevents the overflow in a real browser.
describe('SendScreen — confirm card destination stays within .pc-address-full (VF Wallet Task 10 fix loop 1)', () => {
  it('applies .pc-address-full alongside .pc-technical to the full destination address', () => {
    const preview = {
      confirm: {
        ops: [
          {
            destination: 'GBRPYHILCUFXYVJDXHYQMWZXGWLPKVPMDDIVGXAFTQZTZPMOI4XG3ZC7OX2H',
            asset: 'XLM',
            amount: '1',
          },
        ],
        memo: '',
        fee: 100,
      },
      vault: { hit: false },
    }
    render(<SendScreen from="GME" onPreview={vi.fn()} onConfirm={vi.fn()} preview={preview} />)
    const destinationLine = screen.getByText(/^To: G/)
    expect(destinationLine.className.split(' ')).toEqual(
      expect.arrayContaining(['pc-technical', 'pc-address-full'])
    )
  })
})
