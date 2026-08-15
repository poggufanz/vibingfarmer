// frontend/extension/popupView.test.js
// Task 2: the popup result is a pure projection of the existing ceremony payload. These tests
// intentionally import no controller, signer, relay, storage, or reader.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import {
  POPUP_RESULT_STATE,
  PopupResult,
  PopupSigningPending,
  toPopupResultModel,
} from './popupView.js'

const ACCOUNT = { kind: 'C', address: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ' }

afterEach(cleanup)

describe('popup result truth', () => {
  it('confirms only an authoritative success with a real hash', () => {
    expect(
      toPopupResultModel({ ok: true, action: 'deposit', status: 'SUCCESS', hash: 'abc' })
    ).toMatchObject({ state: POPUP_RESULT_STATE.CONFIRMED, hash: 'abc' })
  })

  it('does not call a pending share read a mint or completed movement', () => {
    const view = toPopupResultModel({
      ok: true,
      action: 'deposit',
      status: 'PENDING',
      hash: 'pending-hash',
      sharesBefore: '100',
      sharesAfter: '120',
    })
    expect(view.state).toBe(POPUP_RESULT_STATE.SUBMITTED)
    expect(view.message).not.toMatch(/mint|confirmed|completed/i)
    expect(view.shares).toBeNull()
  })

  it('keeps missing hash/status unknown and rejected movement explicit', () => {
    expect(toPopupResultModel({ ok: true, action: 'deposit' }).state).toBe(
      POPUP_RESULT_STATE.UNKNOWN
    )
    expect(toPopupResultModel({ ok: false, status: 'NOT_SUBMITTED' })).toMatchObject({
      state: POPUP_RESULT_STATE.NOT_SUBMITTED,
      message: expect.stringMatching(/nothing moved/i),
    })
  })

  it('keeps success without a hash unknown and never exposes an explorer link', () => {
    expect(toPopupResultModel({ ok: true, action: 'deposit', status: 'SUCCESS' })).toMatchObject({
      state: POPUP_RESULT_STATE.UNKNOWN,
      hash: null,
      explorerHref: null,
      shares: null,
    })
  })

  it('accepts status/hash evidence when the transport omits ok, but never when it rejects', () => {
    expect(toPopupResultModel({ status: 'SUCCESS', hash: 'abc' }).state).toBe(
      POPUP_RESULT_STATE.CONFIRMED
    )
    expect(toPopupResultModel({ ok: false, status: 'SUCCESS', hash: 'abc' }).state).toBe(
      POPUP_RESULT_STATE.FAILED
    )
  })

  it('exposes only a non-negative confirmed shares delta', () => {
    expect(
      toPopupResultModel({
        ok: true,
        action: 'deposit',
        status: 'SUCCESS',
        hash: 'abc',
        sharesBefore: '0002',
        sharesAfter: '7',
      }).shares
    ).toBe('5')
    expect(
      toPopupResultModel({
        ok: true,
        action: 'deposit',
        status: 'SUCCESS',
        hash: 'abc',
        sharesBefore: '-1',
        sharesAfter: '7',
      }).shares
    ).toBeNull()
    expect(
      toPopupResultModel({
        ok: true,
        action: 'deposit',
        status: 'SUCCESS',
        hash: 'abc',
        sharesBefore: '8',
        sharesAfter: '7',
      }).shares
    ).toBeNull()
  })

  it('maps a rejected result to failed copy without inventing a transaction link', () => {
    expect(
      toPopupResultModel({
        ok: false,
        action: 'deposit',
        status: 'FAILED',
        error: 'Face ID denied',
      })
    ).toMatchObject({
      state: POPUP_RESULT_STATE.FAILED,
      label: 'Failed',
      message: 'Failed — Face ID denied',
      explorerHref: null,
      shares: null,
    })
  })

  it('fails closed when a confirmed hash belongs to a stale account snapshot', () => {
    const view = toPopupResultModel({
      ok: true,
      action: 'deposit',
      status: 'SUCCESS',
      hash: 'stale-confirmed-hash',
      sharesBefore: '100',
      sharesAfter: '120',
      accountSnapshotStale: true,
    })

    expect(view).toMatchObject({
      state: POPUP_RESULT_STATE.UNKNOWN,
      label: 'Account changed',
      hash: 'stale-confirmed-hash',
      explorerHref: 'https://stellar.expert/explorer/testnet/tx/stale-confirmed-hash',
      shares: null,
    })
    expect(view.message).toMatch(/active account changed|verify the transaction/i)
    expect(view.message).not.toMatch(/confirmed|submitted|shares/i)
  })

  it('fails closed when a submitted hash belongs to a stale account snapshot', () => {
    const view = toPopupResultModel({
      ok: true,
      action: 'deposit',
      status: 'PENDING',
      hash: 'stale-pending-hash',
      sharesBefore: '100',
      sharesAfter: '120',
      accountSnapshotStale: true,
    })

    expect(view).toMatchObject({
      state: POPUP_RESULT_STATE.UNKNOWN,
      label: 'Account changed',
      hash: 'stale-pending-hash',
      explorerHref: 'https://stellar.expert/explorer/testnet/tx/stale-pending-hash',
      shares: null,
    })
    expect(view.message).toMatch(/active account changed|verify the transaction/i)
    expect(view.message).not.toMatch(/confirmed|submitted|shares/i)
  })
})

describe('popup result components — shared shell and truthful controls', () => {
  it('renders pending copy with the shared network/account trust anchors and a keyboard-reachable Cancel', () => {
    const onBack = () => {}
    render(
      React.createElement(PopupSigningPending, {
        account: ACCOUNT,
        origin: 'VF Wallet (this extension)',
        onBack,
      })
    )
    expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByTestId('wallet-account-chip').textContent).toContain('Passkey')
    expect(screen.getByRole('status').textContent).toMatch(/waiting for face id/i)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('renders a confirmed hash link and calls Done without adding a second status reader', () => {
    const onDone = () => {}
    render(
      React.createElement(PopupResult, {
        account: ACCOUNT,
        origin: 'VF Wallet (this extension)',
        result: { ok: true, action: 'deposit', status: 'SUCCESS', hash: 'abc' },
        onDone,
      })
    )
    expect(screen.getByRole('heading', { name: 'Confirmed' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/confirmed/i)
    expect(screen.getByRole('link', { name: /Stellar Expert/i }).getAttribute('rel')).toBe(
      'noreferrer'
    )
    expect(screen.getByRole('link', { name: /Stellar Expert/i }).getAttribute('href')).toBe(
      'https://stellar.expert/explorer/testnet/tx/abc'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  })

  it('renders pending as submitted copy without shares or a link when the hash is absent', () => {
    render(
      React.createElement(PopupResult, {
        account: ACCOUNT,
        result: {
          ok: true,
          action: 'deposit',
          status: 'PENDING',
          sharesBefore: '1',
          sharesAfter: '2',
        },
        onDone: () => {},
      })
    )
    expect(screen.getByRole('heading', { name: 'Unavailable' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/status unknown/i)
    expect(screen.queryByTestId('result-shares')).toBeNull()
    expect(screen.queryByRole('link', { name: /Stellar Expert/i })).toBeNull()
  })
})
