// frontend/src/base/paymaster.js
// ZeroDev USDC-sponsored gas — the exact wiring proven in spikes/smart-sessions/session-test.mjs
// (createZeroDevPaymasterClient + kernelClient.paymaster.getPaymasterData ->
// sponsorUserOperation). Factored into its own module so both the session dispatch path
// (base/session.js) and the owner withdraw path (base/withdrawBatch.js) share one gasless
// wiring, rather than each hand-rolling it.
import { http } from 'viem'
import { createZeroDevPaymasterClient, createKernelAccountClient } from '@zerodev/sdk'
import { BASE_CHAIN, zerodevRpcUrl, ZERODEV_PROJECT_ID } from './config.js'

/**
 * @param {{ account: object, publicClient: object, projectId?: string, deps?: { makePaymasterClient?: Function, makeAccountClient?: Function } }} p
 * @returns {object} a kernelClient with gas sponsored in USDC via the ZeroDev paymaster
 */
export function createGaslessKernelClient({
  account,
  publicClient,
  projectId = ZERODEV_PROJECT_ID,
  deps = {},
}) {
  const {
    makePaymasterClient = createZeroDevPaymasterClient,
    makeAccountClient = createKernelAccountClient,
  } = deps
  const rpc = zerodevRpcUrl(BASE_CHAIN.id, projectId) // throws if projectId is empty
  const paymasterClient = makePaymasterClient({ chain: BASE_CHAIN, transport: http(rpc) })

  return makeAccountClient({
    account,
    chain: BASE_CHAIN,
    bundlerTransport: http(rpc),
    client: publicClient,
    paymaster: {
      getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
    },
  })
}
