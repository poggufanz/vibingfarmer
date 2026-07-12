// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import CodeBlock from './CodeBlock.jsx'

afterEach(cleanup)

describe('CodeBlock', () => {
  it('copies its exact code and confirms with the check state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<CodeBlock code="curl -s /api/vf/prices" />)
    fireEvent.click(screen.getByRole('button', { name: /copy code/i }))

    expect(writeText).toHaveBeenCalledWith('curl -s /api/vf/prices')
    await waitFor(() => expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy())
  })

  it('does not confirm when the clipboard write is rejected', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<CodeBlock code="secret" />)
    fireEvent.click(screen.getByRole('button', { name: /copy code/i }))

    await Promise.resolve()
    expect(screen.queryByRole('button', { name: /copied/i })).toBeNull()
  })
})
