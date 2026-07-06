// frontend/src/screens/Withdraw.jsx
// Withdraw -> Unwind screen: one tap -> owner-signed batched unwind (withdrawBatch.js) -> hand
// the tx hash to the relayer (relayerClient.js) -> poll to done. End state: USDC back at the
// user's own Stellar G-address (§6 step 8) — this screen never asks for a second signature.
import { useState, useCallback } from 'react'
import { signAndSubmitUnwind } from '../base/withdrawBatch.js'
import { postUnwind, pollFarmStatus } from '../base/relayerClient.js'

export default function Withdraw({
  ownerKernelAccount,
  publicClient,
  withdrawals,
  stellarRecipient,
  totalAssetsForBurn,
}) {
  const [status, setStatus] = useState('idle') // idle | signing | relaying | polling | done | error
  const [errorMessage, setErrorMessage] = useState(null)

  const startWithdraw = useCallback(async () => {
    setStatus('signing')
    setErrorMessage(null)
    try {
      const { unwindTxHash } = await signAndSubmitUnwind({
        ownerKernelAccount,
        publicClient,
        withdrawals,
        stellarRecipient,
        totalAssetsForBurn,
      })
      setStatus('relaying')
      const { jobId } = await postUnwind({ unwindTxHash, stellarRecipient })
      setStatus('polling')
      const final = await pollFarmStatus({ jobId })
      setStatus(final.status)
    } catch (err) {
      setStatus('error')
      setErrorMessage(err.message)
    }
  }, [ownerKernelAccount, publicClient, withdrawals, stellarRecipient, totalAssetsForBurn])

  return (
    <section className="withdraw-screen">
      <h2>Withdraw to Stellar</h2>
      <p>
        Unwinds every pool and bridges back to <code>{stellarRecipient}</code>.
      </p>
      <button
        type="button"
        onClick={startWithdraw}
        disabled={status !== 'idle' && status !== 'error'}
      >
        Withdraw
      </button>
      {errorMessage && (
        <p className="withdraw-error" role="alert">
          {errorMessage}
        </p>
      )}
      {status !== 'idle' && status !== 'error' && <p className="withdraw-status">{status}</p>}
    </section>
  )
}
