import { describe, expect, it } from 'vitest'
import { concatHex, decodeFunctionData, encodeFunctionData } from 'viem'
import { KernelV3ExecuteAbi } from '@zerodev/sdk'
import { unwindJobCommitment } from './unwindCommitment.js'

const JOB_ID = 'ab'.repeat(16)
const COMMITMENT = '0x2a8c851ab65e5f08fe5af4d1b09eaf2bbd7156fe6561f537d30454905de12cb7'

describe('unwind job commitment', () => {
  it('matches the byte-exact cross-runtime domain vector', () => {
    expect(unwindJobCommitment(JOB_ID)).toBe(COMMITMENT)
    expect(unwindJobCommitment('cd'.repeat(16))).toBe(
      '0x958e958f211c1406f7bab1eb6f17b08bb7f460cf2f72f9d9a33126bc3932cac1'
    )
  })

  it('keeps the signed suffix outside Kernel v3 execute arguments', () => {
    const execMode = `0x${'00'.repeat(32)}`
    const executionData = '0x12345678aabbccdd'
    const canonicalCallData = encodeFunctionData({
      abi: KernelV3ExecuteAbi,
      functionName: 'execute',
      args: [execMode, executionData],
    })
    const signedCallData = concatHex([canonicalCallData, COMMITMENT])

    const decoded = decodeFunctionData({ abi: KernelV3ExecuteAbi, data: signedCallData })

    expect(decoded.functionName).toBe('execute')
    expect(decoded.args).toEqual([execMode, executionData])
    expect(signedCallData.endsWith(COMMITMENT.slice(2))).toBe(true)
    expect(signedCallData.slice(0, -64)).toBe(canonicalCallData)
  })
})
