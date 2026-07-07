// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import OnRampButton from './OnRampButton.jsx'
import { OnRamp } from './OnRamp.js'

afterEach(cleanup)

describe('<OnRampButton />', () => {
  it('calls OnRamp.open with the address + amount on click, then reports the result', async () => {
    const onResult = vi.fn()
    vi.spyOn(OnRamp, 'open').mockResolvedValue({ completed: true, network: 'stellar' })
    render(<OnRampButton address="GADDR" amount={25} onResult={onResult} />)
    screen.getByRole('button', { name: /fund with card/i }).click()
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ completed: true, network: 'stellar' })
    )
    expect(OnRamp.open).toHaveBeenCalledWith({ address: 'GADDR', amount: 25 })
  })

  it('shows an error message when the widget fails to open', async () => {
    vi.spyOn(OnRamp, 'open').mockRejectedValue(new Error('popup blocked'))
    render(<OnRampButton address="GADDR" />)
    screen.getByRole('button', { name: /fund with card/i }).click()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('popup blocked'))
  })

  it('disables the button when no address is available yet', () => {
    render(<OnRampButton address="" />)
    expect(screen.getByRole('button', { name: /fund with card/i }).disabled).toBe(true)
  })
})
