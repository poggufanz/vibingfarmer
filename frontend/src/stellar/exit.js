// frontend/src/stellar/exit.js
// Owner exit — sweep an agent's position back to the user via the Phase-1 owner_withdraw.
import { buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'

/** owner_withdraw(to) on the agent account — user-signed; redeems + sweeps to `to`. */
export async function ownerWithdraw({ owner, agentAddress, to }) {
  // By-agent, not by-vault: naming the wrong agent is not a harmless no-op, it invokes an account
  // the caller may not own. Never let a caller reach the chain without saying which agent.
  if (!agentAddress) throw new Error('ownerWithdraw requires an agentAddress.')
  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: agentAddress,
    method: 'owner_withdraw',
    args: [{ addr: to || owner }],
  })
  const signed = await signTxXdr(xdr)
  const res = await submitUserTx({ signedXdr: signed })
  // Callers zero the position on resolve, so an unconfirmed exit must not resolve.
  if (res.status !== 'SUCCESS') throw new Error(`The exit was not confirmed: ${res.status}.`)
  return res
}
