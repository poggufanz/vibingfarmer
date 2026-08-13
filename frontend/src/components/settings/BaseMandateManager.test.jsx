// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import BaseMandateManager from './BaseMandateManager.jsx'

const OWNER = 'GOWNERSETTINGS000000000000000000000000000000000000000000000000'
const KERNEL = '0x1111111111111111111111111111111111111111'
const SESSION = '0x2222222222222222222222222222222222222222'

const readyView = {
  status: 'ready',
  ready: true,
  primaryCopy:
    'For 7 days, the relayer-held key may repeatedly approve and deposit up to 10,000 USDC per call into allowlisted Base Sepolia custody proxies, while this smart account has funds. It cannot withdraw.',
  durationDays: 7,
  perCallCap: {
    usdc: '10,000',
    units: 10_000_000_000n,
    decimals: 6,
    cumulative: false,
    nonCumulative: true,
  },
  repeatedCalls: true,
  allowedActions: ['Circle USDC approve', 'YieldRouter deposit'],
  destination: 'allowlisted Base Sepolia custody proxies',
  sessionKeyAddress: SESSION,
  kernelAddress: KERNEL,
  validUntilSeconds: 1_800_000_000,
  renewalCopy: 'Renew the mandate before its expiry to continue using Base testnet.',
  revokeCopy:
    'Deleting or revoking the VF relayer copy does not invalidate another copied key before the on-chain timestamp policy expires.',
  outageCopy: 'If the relayer has an outage, Base is unavailable until its health check succeeds.',
  confirmationCopy: 'Renewal is awaiting the existing confirmation result.',
  result: 'unknown',
  technicalDisclosure: 'Technical disclosure is source-backed and does not include secrets.',
  evidence: {
    stellarOwner: OWNER,
    sessionPrivateKey: 'DO_NOT_RENDER_SESSION_PRIVATE_KEY',
    privateKey: 'DO_NOT_RENDER_PRIVATE_KEY',
    capability: 'DO_NOT_RENDER_CAPABILITY',
    serializedApproval: 'DO_NOT_RENDER_SERIALIZED_APPROVAL',
    bearer: 'DO_NOT_RENDER_BEARER',
  },
}

const viewFor = (status, extra = {}) => ({
  ...readyView,
  status,
  ready: status === 'ready',
  ...extra,
})

function renderManager(props = {}) {
  return render(
    <BaseMandateManager
      mandateView={null}
      connected={true}
      busy={false}
      error={null}
      onSetup={vi.fn()}
      onRenew={null}
      onRevoke={null}
      onRefresh={vi.fn()}
      {...props}
    />
  )
}

afterEach(() => cleanup())

describe('BaseMandateManager state presentation', () => {
  it.each([
    ['ready', readyView],
    ['unavailable', viewFor('unavailable')],
  ])('shows the canonical Base Sepolia badge for the %s manager state', (_name, mandateView) => {
    renderManager({ mandateView })

    const label = screen.getByText('Base Sepolia', { exact: true })
    expect(label.closest('.network-badge')?.getAttribute('data-network')).toBe('base-sepolia')
    expect(
      screen.getByRole('region', { name: /base mandate/i }).querySelector('.network-route')
    ).toBeNull()
  })

  it.each([
    ['disconnected', { connected: false, mandateView: viewFor('ready') }, 'Disconnected'],
    ['switched', { mandateView: viewFor('switched') }, 'Switched account'],
    ['mismatched', { mandateView: viewFor('mismatched') }, 'Mismatched'],
    ['unavailable', { mandateView: viewFor('unavailable') }, 'Unavailable'],
    ['missing', { mandateView: viewFor('missing') }, 'Missing'],
    ['expired', { mandateView: viewFor('expired') }, 'Expired'],
    ['revoked', { mandateView: viewFor('revoked') }, 'Revoked'],
    ['busy', { mandateView: viewFor('ready'), busy: true }, 'Pending'],
    ['ready', { mandateView: readyView }, 'Ready'],
  ])('renders source-provided %s status', (_name, props, label) => {
    renderManager(props)
    expect(screen.getByRole('status').textContent).toContain(label)
  })

  it('renders only safe source facts and the Base custody boundary for a ready mandate', () => {
    renderManager({ mandateView: readyView })

    expect(screen.getByText(OWNER)).toBeTruthy()
    expect(screen.getByText(KERNEL)).toBeTruthy()
    expect(screen.getByText(SESSION)).toBeTruthy()
    expect(screen.getByText('Circle USDC approve')).toBeTruthy()
    expect(screen.getByText('YieldRouter deposit')).toBeTruthy()
    expect(screen.getByText(/Destination:/).textContent).toContain(
      'allowlisted Base Sepolia custody proxies'
    )
    expect(screen.getByText(/Cap:/).textContent).toContain('10,000 USDC per call')
    expect(screen.getByText(/non-cumulative/i)).toBeTruthy()
    expect(screen.getByText(/Expiry:/).textContent).toContain('7 days')
    expect(screen.getByText(/smart account has funds/i)).toBeTruthy()
    expect(screen.getByText(/Balance bound:/).textContent).toContain('cannot withdraw')
    expect(screen.getByText(/Destination:/).textContent).toContain(
      'Base Sepolia proxy. Custody only. No protocol yield.'
    )
    expect(screen.getByText(readyView.renewalCopy)).toBeTruthy()
    const revokeDisclosure = screen.getByText(/Deleting or revoking/)
    expect(revokeDisclosure.textContent).toContain(readyView.revokeCopy)
    expect(revokeDisclosure.textContent).toMatch(/only the relayer-held copy/i)
    expect(revokeDisclosure.textContent).toMatch(/not.*withdraw/i)
    expect(revokeDisclosure.textContent).toMatch(/not.*revoke.*Stellar agents/i)
    expect(screen.getByText(readyView.outageCopy)).toBeTruthy()
    expect(
      screen.queryByText(/DO_NOT_RENDER|private key|capability|serialized approval|bearer/i)
    ).toBeNull()
  })

  it('does not infer mandate facts when the source view is absent or disconnected', () => {
    renderManager({ mandateView: null, connected: true })
    expect(screen.getByText(/Unavailable/i)).toBeTruthy()
    expect(screen.queryByText(OWNER)).toBeNull()
    expect(screen.queryByText(/10,000 USDC/i)).toBeNull()
    expect(screen.queryByText(/Missing/i)).toBeNull()

    cleanup()
    renderManager({ mandateView: readyView, connected: false })
    expect(screen.getByText(/Disconnected/i)).toBeTruthy()
    expect(screen.queryByText(OWNER)).toBeNull()
    expect(screen.queryByText(KERNEL)).toBeNull()
  })

  it('shows setup and refresh only when their existing callbacks are supplied', () => {
    const onSetup = vi.fn()
    const onRefresh = vi.fn()
    renderManager({ mandateView: viewFor('missing'), onSetup, onRefresh })
    fireEvent.click(screen.getByRole('button', { name: 'Set up Base mandate' }))
    expect(onSetup).toHaveBeenCalledTimes(1)

    cleanup()
    renderManager({ mandateView: viewFor('unavailable'), onRefresh })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Base mandate' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    cleanup()
    renderManager({ mandateView: viewFor('missing'), onSetup: null, onRefresh: null })
    expect(screen.queryByRole('button', { name: 'Set up Base mandate' })).toBeNull()
    expect(screen.getByText(/Setup.*Unavailable/i)).toBeTruthy()
  })

  it('keeps expired/revoked and ready renewal/revoke facts read-only without optional callbacks', () => {
    renderManager({ mandateView: viewFor('expired') })
    expect(screen.queryByRole('button', { name: 'Renew Base mandate' })).toBeNull()
    expect(screen.getByText(/Renewal.*Unavailable/i)).toBeTruthy()

    cleanup()
    renderManager({ mandateView: readyView })
    expect(screen.queryByRole('button', { name: 'Renew Base mandate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke Base mandate copy' })).toBeNull()
    expect(screen.getByText(/Renewal.*Unavailable/i)).toBeTruthy()
    expect(screen.getByText(/Revoke.*Unavailable/i)).toBeTruthy()
  })
})

describe('BaseMandateManager supplied actions', () => {
  it('binds only supplied renewal and revoke callbacks', () => {
    const onRenew = vi.fn()
    const onRevoke = vi.fn()
    renderManager({ mandateView: readyView, onRenew, onRevoke })
    fireEvent.click(screen.getByRole('button', { name: 'Renew Base mandate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Base mandate copy' }))
    expect(onRenew).toHaveBeenCalledTimes(1)
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('preserves confirmation and error truth and disables duplicate actions while busy', () => {
    const onRenew = vi.fn()
    const onRevoke = vi.fn()
    renderManager({
      mandateView: readyView,
      onRenew,
      onRevoke,
      busy: true,
      error: 'Base mandate renewal was not confirmed.',
    })
    expect(screen.getByText(readyView.confirmationCopy)).toBeTruthy()
    expect(screen.getByText('Not confirmed')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(
      'Base mandate renewal was not confirmed.'
    )
    expect(screen.getByRole('button', { name: 'Renew Base mandate' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Revoke Base mandate copy' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Renew Base mandate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Base mandate copy' }))
    expect(onRenew).not.toHaveBeenCalled()
    expect(onRevoke).not.toHaveBeenCalled()
  })

  it('keeps failed or unknown source results Not confirmed without fabricating success', () => {
    renderManager({
      mandateView: viewFor('unknown', {
        result: 'failed',
        confirmationCopy: 'Action result is unknown.',
      }),
    })
    expect(screen.getByText('Not confirmed')).toBeTruthy()
    expect(screen.getByText('Action result is unknown.')).toBeTruthy()
    expect(screen.queryByText(/Confirmed successfully|Success/i)).toBeNull()
  })
})

describe('BaseMandateManager source-shape fail-closed policy', () => {
  it.each([
    ['owner mismatch', 'owner-mismatch'],
    ['kernel mismatch', 'kernel-mismatch'],
    ['relayer mismatch', 'relayer-mismatch'],
  ])('keeps the source %s refresh-only and labels it Mismatched', (_name, status) => {
    const onRefresh = vi.fn()
    renderManager({ mandateView: viewFor(status), onRefresh })

    expect(screen.getByRole('status').textContent).toContain('Mismatched')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Base mandate' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Set up Base mandate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Renew Base mandate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke Base mandate copy' })).toBeNull()
  })

  it('reads the connected owner from the canonical projected evidence field', () => {
    const canonicalReadyView = {
      ...readyView,
      owner: undefined,
      stellarOwner: undefined,
      evidence: { ...readyView.evidence, stellarOwner: OWNER },
    }

    renderManager({ mandateView: canonicalReadyView })

    expect(screen.getByText(OWNER)).toBeTruthy()
    expect(screen.queryByText(/undefined/i)).toBeNull()
  })

  it.each([
    ['nonCumulative string', { nonCumulative: 'false' }],
    ['nonCumulative false', { nonCumulative: false }],
    ['cumulative string', { cumulative: 'false' }],
    ['cumulative true', { cumulative: true }],
    ['cap string', { usdc: 'arbitrary' }],
    ['cap decimals', { decimals: 18 }],
  ])('shows an unavailable cap for malformed %s policy', (_name, capPatch) => {
    const malformed = {
      ...readyView,
      perCallCap: { ...readyView.perCallCap, ...capPatch },
    }

    renderManager({ mandateView: malformed })

    expect(screen.getByText(/^Cap:/).textContent).toContain('Unavailable')
    expect(screen.getByText(/^Cap:/).textContent).not.toMatch(/cumulative|allowed/i)
    expect(screen.queryByText(readyView.primaryCopy)).toBeNull()
  })

  it.each([
    ['repeated calls string', { repeatedCalls: 'false' }],
    ['repeated calls false', { repeatedCalls: false }],
    ['duration string', { durationDays: '7' }],
    ['duration wrong', { durationDays: 8 }],
    ['duration negative', { durationDays: -7 }],
    ['valid until string', { validUntilSeconds: '1800000000' }],
    ['valid until zero', { validUntilSeconds: 0 }],
    ['valid until negative', { validUntilSeconds: -1 }],
  ])('shows an unavailable policy for malformed %s source data', (_name, patch) => {
    renderManager({ mandateView: { ...readyView, ...patch } })

    expect(screen.getByText(/^Expiry:/).textContent).toContain('Unavailable')
    expect(screen.getByText(/^Cap:/).textContent).not.toMatch(/repeated calls: allowed/i)
  })
})
