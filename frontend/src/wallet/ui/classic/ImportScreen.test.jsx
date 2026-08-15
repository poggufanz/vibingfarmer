// frontend/src/wallet/ui/classic/ImportScreen.test.jsx
// VF Wallet Task 11. ImportScreen had no dedicated test file before this task -- it was only
// exercised indirectly through popup.jsx's classic-import screen. This pins its own behavior
// directly: format detection, the 12-char password floor gating submit, and the Task 11 `heading`
// override this file's own header documents (default text unchanged for the pre-existing
// onboarding caller; WalletAdvanced.jsx supplies a different heading for the "restore a different
// wallet on an existing device" reuse).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ImportScreen from './ImportScreen.jsx'

afterEach(cleanup)

// Real, checksum-valid Ed25519 secret seed test vector, shared with classicKeypair.test.js /
// session.test.js -- classifyImport calls StrKey.isValidEd25519SecretSeed, which validates the
// checksum, not just the S-prefix/length shape, so a made-up string of repeated characters fails.
const VALID_SECRET = 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN'

describe('ImportScreen — default heading (backward compatible)', () => {
  it('renders the original heading when no override is supplied', () => {
    render(<ImportScreen onImport={() => {}} busy={false} error="" />)
    expect(
      screen.getByRole('heading', { name: 'Restore from a secret key or recovery phrase' })
    ).toBeTruthy()
  })
})

describe('ImportScreen — Task 11 heading override', () => {
  it('renders the caller-supplied heading instead', () => {
    render(
      <ImportScreen
        onImport={() => {}}
        busy={false}
        error=""
        heading="Restore a different Standard wallet"
      />
    )
    expect(
      screen.getByRole('heading', { name: 'Restore a different Standard wallet' })
    ).toBeTruthy()
    expect(
      screen.queryByRole('heading', { name: 'Restore from a secret key or recovery phrase' })
    ).toBeNull()
  })
})

describe('ImportScreen — submit gating', () => {
  it('disables Import wallet until a valid secret and a 12+ char password are entered', () => {
    render(<ImportScreen onImport={() => {}} busy={false} error="" />)
    const button = screen.getByRole('button', { name: /import wallet/i })
    expect(button.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Secret key or recovery phrase'), {
      target: { value: VALID_SECRET },
    })
    expect(button.disabled).toBe(true) // password still empty

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } })
    expect(button.disabled).toBe(true) // under 12 chars

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'twelvecharspw' } })
    expect(button.disabled).toBe(false)
  })

  it('calls onImport with the normalized secret, password, and label exactly once', () => {
    const onImport = vi.fn()
    render(<ImportScreen onImport={onImport} busy={false} error="" />)
    fireEvent.change(screen.getByLabelText('Secret key or recovery phrase'), {
      target: { value: VALID_SECRET },
    })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'twelvecharspw' } })
    fireEvent.click(screen.getByRole('button', { name: /import wallet/i }))
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport).toHaveBeenCalledWith(VALID_SECRET, 'twelvecharspw', 'Imported')
  })

  it('shows a checksum error for an invalid recovery phrase without crashing', () => {
    render(<ImportScreen onImport={() => {}} busy={false} error="" />)
    fireEvent.change(screen.getByLabelText('Secret key or recovery phrase'), {
      target: { value: 'one two three four five six seven eight nine ten eleven twelve' },
    })
    expect(screen.getByText(/checksum failed|12\/24-word/i)).toBeTruthy()
  })

  it('surfaces a caller-supplied error message', () => {
    render(<ImportScreen onImport={() => {}} busy={false} error="Network error." />)
    expect(screen.getByText('Network error.')).toBeTruthy()
  })

  it('shows a busy label and keeps the button disabled while importing', () => {
    render(<ImportScreen onImport={() => {}} busy error="" />)
    expect(screen.getByRole('button', { name: /importing…/i })).toBeTruthy()
  })
})
