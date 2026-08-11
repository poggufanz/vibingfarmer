// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SkillDetailModal from './SkillDetailModal.jsx'

afterEach(cleanup)

describe('SkillDetailModal network fee copy', () => {
  it('uses the canonical network-fee row and sponsored value', () => {
    render(
      <SkillDetailModal
        agent={{ name: 'Worker A', allocation: 10, vault: { protocol: 'blend' } }}
        skill={{
          target: { vault: 'CVAULT', chain: 'stellar-testnet' },
          steps: [],
          guards: { maxAmount: '10 USDC', expiresIn: '3600', revocable: true },
        }}
        state="pending"
        onClose={vi.fn()}
        onApprove={vi.fn()}
        onEdit={vi.fn()}
      />
    )

    expect(screen.getByText('Network fee')).toBeTruthy()
    expect(screen.getByText('Sponsored by fee-bump relay')).toBeTruthy()
    expect(screen.queryByText('Fee-bump sponsored')).toBeNull()
  })
})
