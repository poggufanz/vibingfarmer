// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import Pager from './Pager.jsx'

afterEach(cleanup)

describe('Pager', () => {
  it('renders nothing when everything fits on one page', () => {
    const { container } = render(<Pager page={0} pages={1} onPage={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
  it('navigates and disables at bounds', () => {
    const onPage = vi.fn()
    render(<Pager page={0} pages={3} onPage={onPage} />)
    expect(screen.getByRole('button', { name: /previous page/i }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /next page/i }))
    expect(onPage).toHaveBeenCalledWith(1)
    expect(screen.getByText('1 / 3')).toBeTruthy()
  })
})
