// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import DocsSection from './DocsSection.jsx'
import { ENDPOINTS } from './docsData.js'

afterEach(cleanup)

describe('DocsSection', () => {
  it('renders auth header, error table, and all endpoints', () => {
    render(<DocsSection />)
    expect(screen.getByText(/Authorization: Bearer vf_/)).toBeTruthy()
    expect(screen.getByText(/Daily budget exhausted/)).toBeTruthy()
    for (const e of ENDPOINTS) expect(screen.getByText(e.path)).toBeTruthy()
    expect(ENDPOINTS).toHaveLength(8)
  })
})
