// @vitest-environment jsdom
// frontend/src/components/console/instruments/instruments.test.jsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Ekg from './Ekg.jsx'
import Dial from './Dial.jsx'
import Radar from './Radar.jsx'
import Gauge from './Gauge.jsx'

describe('Ekg', () => {
  it('labels itself with the cycle count', () => {
    render(<Ekg rows={[{ verdict: 'keep' }]} running width={200} height={50} />)
    expect(screen.getByRole('img', { name: /1 cycles/ })).toBeTruthy()
  })
})

describe('Dial', () => {
  it('shows tabular apr text (dual coding)', () => {
    render(<Dial aprPct={7.53} />)
    expect(screen.getByText('7.53%')).toBeTruthy()
  })
  it('renders -- when apr unknown', () => {
    render(<Dial aprPct={null} />)
    expect(screen.getByText('--')).toBeTruthy()
  })
})

describe('Radar', () => {
  const now = 1_000_000_000_000
  it('sweeps only when armed', () => {
    const { container, rerender } = render(<Radar events={[]} armed nowMs={now} />)
    expect(container.querySelector('.radar-sweep-line')).toBeTruthy()
    rerender(<Radar events={[]} armed={false} nowMs={now} />)
    expect(container.querySelector('.radar-sweep-line')).toBeFalsy()
  })
  it('draws one blip per recent derisk event', () => {
    const { container } = render(
      <Radar events={[{ type: 'derisk', txHash: 'ab', timestamp: now - 5000 }]} armed nowMs={now} />,
    )
    expect(container.querySelectorAll('circle.radar-blip')).toHaveLength(1)
  })
})

describe('Gauge', () => {
  it('fills segments by ratio', () => {
    const { container } = render(<Gauge value={50} max={100} segments={10} />)
    expect(container.querySelectorAll('.gauge-seg.on')).toHaveLength(5)
    expect(container.querySelectorAll('.gauge-seg')).toHaveLength(10)
  })
})
