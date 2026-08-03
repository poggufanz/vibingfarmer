// frontend/src/wallet/ui/classic/SettingsScreen.test.jsx
// VF Wallet Task 11. SettingsScreen owns Lock/auto-lock/VF-key/export/reset for the classic
// (Standard, G-address) account model. The one behavior change from the pre-Task-11 version is
// reset's confirmation: it must never fire onReset from a single click, and it must offer a real,
// visible Cancel -- replacing the old native window.confirm() (no Cancel of its own visible in the
// DOM, easy to blow through with a reflex "OK", and untestable without mocking window.confirm).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SettingsScreen from './SettingsScreen.jsx'

afterEach(cleanup)

const noop = () => {}

describe('SettingsScreen — lock and auto-lock', () => {
  it('fires onLock exactly once per click', () => {
    const onLock = vi.fn()
    render(
      <SettingsScreen
        onLock={onLock}
        onExport={noop}
        onReset={noop}
        autoLockMin={10}
        onSetAutoLock={noop}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Lock now' }))
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('shows the current auto-lock minutes and reports a new value as a number', () => {
    const onSetAutoLock = vi.fn()
    render(
      <SettingsScreen
        onLock={noop}
        onExport={noop}
        onReset={noop}
        autoLockMin={10}
        onSetAutoLock={onSetAutoLock}
      />
    )
    const input = screen.getByLabelText('Auto-lock (minutes)')
    expect(input.value).toBe('10')
    fireEvent.change(input, { target: { value: '15' } })
    expect(onSetAutoLock).toHaveBeenCalledWith(15)
  })
})

describe('SettingsScreen — export secret', () => {
  it('fires onExport exactly once per click (reveal itself is the caller`s job)', () => {
    const onExport = vi.fn()
    render(
      <SettingsScreen
        onLock={noop}
        onExport={onExport}
        onReset={noop}
        autoLockMin={10}
        onSetAutoLock={noop}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Export secret' }))
    expect(onExport).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsScreen — reset requires an explicit, visible confirm step (no native confirm())', () => {
  it('does not call onReset from the first ("Reset wallet") click', () => {
    const onReset = vi.fn()
    render(
      <SettingsScreen
        onLock={noop}
        onExport={noop}
        onReset={onReset}
        autoLockMin={10}
        onSetAutoLock={noop}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset wallet' }))
    expect(onReset).not.toHaveBeenCalled()
  })

  it('shows consequence copy and a Cancel control once Reset wallet is tapped', () => {
    render(
      <SettingsScreen
        onLock={noop}
        onExport={noop}
        onReset={noop}
        autoLockMin={10}
        onSetAutoLock={noop}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset wallet' }))
    expect(screen.getByTestId('reset-confirm').textContent).toMatch(/cannot be recovered/i)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('Cancel dismisses the confirm step without ever calling onReset', () => {
    const onReset = vi.fn()
    render(
      <SettingsScreen
        onLock={noop}
        onExport={noop}
        onReset={onReset}
        autoLockMin={10}
        onSetAutoLock={noop}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset wallet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('reset-confirm')).toBeNull()
    expect(onReset).not.toHaveBeenCalled()
  })

  it('calls onReset exactly once after the explicit second confirm', () => {
    const onReset = vi.fn()
    render(
      <SettingsScreen
        onLock={noop}
        onExport={noop}
        onReset={onReset}
        autoLockMin={10}
        onSetAutoLock={noop}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset wallet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset this wallet' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
