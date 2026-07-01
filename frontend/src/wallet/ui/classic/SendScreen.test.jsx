// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SendScreen from './SendScreen.jsx'

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
})
