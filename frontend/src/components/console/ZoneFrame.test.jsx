// frontend/src/components/console/ZoneFrame.test.jsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ZoneFrame from './ZoneFrame.jsx'

describe('ZoneFrame', () => {
  it('renders region with title, hue and led state', () => {
    render(
      <ZoneFrame title="lifeboat" hue="danger" led="ok" meta={<span>armed</span>}>
        <div>body</div>
      </ZoneFrame>,
    )
    const region = screen.getByRole('region', { name: 'lifeboat' })
    expect(region.dataset.hue).toBe('danger')
    expect(region.querySelector('.zone-led').dataset.state).toBe('ok')
    expect(screen.getByText('body')).toBeTruthy()
    expect(screen.getByText('armed')).toBeTruthy()
  })
  it('pulses only when ledPulse', () => {
    const { container } = render(<ZoneFrame title="x" ledPulse led="accent" />)
    expect(container.querySelector('.zone-led').className).toContain('pulse')
  })
})
