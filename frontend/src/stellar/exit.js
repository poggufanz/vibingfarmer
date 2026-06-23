// frontend/src/stellar/exit.js
// Owner exit — sweep an agent's position back to the user via the Phase-1 owner_withdraw.
import { buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'

/** owner_withdraw(to) on the agent account — user-signed; redeems + sweeps to `to`. */
export async function ownerWithdraw({ owner, agentAddress, to }) {
  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: agentAddress,
    method: 'owner_withdraw',
    args: [{ addr: to || owner }],
  })
  const signed = await signTxXdr(xdr)
  return submitUserTx({ signedXdr: signed })
}
