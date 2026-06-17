// frontend/src/redeem.test.js
import { describe, it, expect } from 'vitest'
import {
  buildTransferCalldata,
  encodeRedeemExecution,
  buildRedeemArrays,
  SINGLE_DEFAULT_MODE,
} from './redeem.js'

const DEPOSITOR = '0x00000000000000000000000000000000000000ff'

describe('buildTransferCalldata', () => {
  it('encodes erc20 transfer(recipient, amount) with the transfer selector', () => {
    const data = buildTransferCalldata({
      recipient: '0x0000000000000000000000000000000000000001',
      amount: 1000000n,
    })
    expect(data.startsWith('0xa9059cbb')).toBe(true) // transfer(address,uint256)
  })

  it('accepts a string amount and coerces to bigint', () => {
    const data = buildTransferCalldata({ recipient: DEPOSITOR, amount: '500000' })
    expect(data.startsWith('0xa9059cbb')).toBe(true)
  })
})

describe('encodeRedeemExecution', () => {
  it('packs a single ERC-7579 execution (target | value | transfer-calldata)', () => {
    const exec = encodeRedeemExecution({ recipient: DEPOSITOR, amount: 1000000n })
    // ends with the transfer selector inside the packed callData
    expect(exec.includes('a9059cbb')).toBe(true)
    expect(exec.startsWith('0x')).toBe(true)
  })
})

describe('buildRedeemArrays', () => {
  it('returns the three redeemDelegations arrays, each length 1', () => {
    const out = buildRedeemArrays({
      permissionContext: '0xCTX',
      recipient: DEPOSITOR,
      amount: 1000000n,
    })
    expect(out.permissionContexts).toEqual(['0xCTX'])
    expect(out.modes).toEqual([SINGLE_DEFAULT_MODE])
    expect(out.executionCallDatas).toHaveLength(1)
    expect(out.executionCallDatas[0].includes('a9059cbb')).toBe(true)
  })

  it('SINGLE_DEFAULT_MODE is 32 zero bytes', () => {
    expect(SINGLE_DEFAULT_MODE).toBe('0x' + '00'.repeat(32))
  })
})
