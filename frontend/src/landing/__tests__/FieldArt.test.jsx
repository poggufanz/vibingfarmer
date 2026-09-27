// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import FieldArt from '../sections/FieldArt.jsx'

afterEach(cleanup)

describe('FieldArt', () => {
  it('draws one fenced field with four crew-colored workers', () => {
    const { container } = render(<FieldArt />)
    const svg = container.querySelector('svg.vf-field')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.vf-field__fence').getAttribute('pathLength')).toBe('1')
    expect(container.querySelector('.vf-field__sig').getAttribute('pathLength')).toBe('1')
    const crews = [...container.querySelectorAll('.vf-field__crew')]
    expect(crews.map((crew) => crew.dataset.crew)).toEqual(['1', '2', '3', '4'])
    expect(container.querySelectorAll('.vf-field__fill')).toHaveLength(4)
    expect(container.querySelector('.vf-field__idle')).toBeNull()
  })

  it('adds the grant box, idle bay, sweep, radar and failure mark on the lifecycle stage', () => {
    const { container } = render(<FieldArt variant="stage" />)
    for (const part of ['grant', 'idle', 'sweep', 'radar', 'fail']) {
      expect(container.querySelector(`.vf-field__${part}`), part).not.toBeNull()
    }
  })
})
