// frontend/src/base/session.test.js
import { describe, test, expect, vi } from 'vitest'
import { reconstructSessionClient } from './session.js'

describe('reconstructSessionClient', () => {
  test('deserializes the approval with the REAL session signer, then wraps it gaslessly', async () => {
    const fakeAccount = { address: '0xSESSIONACCOUNT' }
    const fakeKernelClient = { account: fakeAccount }
    const deps = {
      keyToAccount: vi.fn(() => ({ address: '0xSESSIONKEY' })),
      deserialize: vi.fn(async (_client, _entryPoint, _kernelVersion, approval, signer) => {
        expect(approval).toBe('serialized-approval-blob')
        expect(signer.address).toBe('0xSESSIONKEY')
        return fakeAccount
      }),
      makeGaslessClient: vi.fn(({ account }) => {
        expect(account).toBe(fakeAccount)
        return fakeKernelClient
      }),
    }

    const client = await reconstructSessionClient({
      publicClient: {},
      serializedApproval: 'serialized-approval-blob',
      sessionPrivateKey: '0xSESSIONPRIVKEY',
      deps,
    })

    expect(client).toBe(fakeKernelClient)
  })
})
