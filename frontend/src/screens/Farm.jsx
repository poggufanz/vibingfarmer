// frontend/src/screens/Farm.jsx
// Deposit -> Farm screen: presentational shell around allocateBasePools (AI preview) and
// runFarmFlow (the actual burn -> relay -> poll pipeline). Container/presentational split per
// this project's web patterns — all side effects live in the two imported functions, not here.
import { useState, useEffect, useCallback } from 'react'
import { allocateBasePools } from '../strategist.js'
import { runFarmFlow } from '../crossChainFarm.js'
import { toBaseUnits } from '../stellar/format.js'

export default function Farm({
  amount,
  riskLevel,
  nPools,
  stellarWallet,
  baseRecipientAddress,
  sessionKeyAddress,
  serializedApproval,
  allocations: providedAllocations = null,
}) {
  // When the caller already computed an allocation (CrossChainFarmFlow does, at mandate time,
  // and derived the session-key caps from it), it MUST be reused verbatim here: allocateBasePools
  // is LLM-backed with no determinism guarantee, so a second call could pick a pool or amount
  // outside the mandate's on-chain policy and the deposit would revert. No prop = the original
  // standalone behavior (allocate on mount).
  const [allocations, setAllocations] = useState(providedAllocations)
  const [events, setEvents] = useState([])
  const [status, setStatus] = useState('idle') // idle | allocating | running | done | error
  const [errorMessage, setErrorMessage] = useState(null)

  useEffect(() => {
    if (providedAllocations) {
      setAllocations(providedAllocations)
      return undefined
    }
    let cancelled = false
    setStatus('allocating')
    allocateBasePools({ amount, riskLevel, nPools }).then((result) => {
      if (!cancelled) {
        setAllocations(result)
        setStatus('idle')
      }
    })
    return () => {
      cancelled = true
    }
  }, [amount, riskLevel, nPools, providedAllocations])

  const onEvent = useCallback((name, data) => {
    setEvents((prev) => [...prev, { name, data, at: Date.now() }])
    if (name === 'farm-failed') setErrorMessage(data.error)
  }, [])

  const startFarming = useCallback(async () => {
    setStatus('running')
    setErrorMessage(null)
    try {
      const result = await runFarmFlow({
        stellarWallet,
        baseRecipientAddress,
        sessionKeyAddress,
        serializedApproval,
        allocations,
        amountUnits: toBaseUnits(amount),
        onEvent,
      })
      setStatus(result.finalStatus)
    } catch {
      setStatus('error')
    }
  }, [
    stellarWallet,
    baseRecipientAddress,
    sessionKeyAddress,
    serializedApproval,
    allocations,
    amount,
    onEvent,
  ])

  if (!allocations)
    return <div className="farm-screen farm-screen--loading">Building your allocation…</div>

  return (
    <section className="farm-screen">
      <h2>Farm plan</h2>
      <ul className="farm-allocation-list">
        {allocations.map((a) => (
          <li key={a.pool}>
            <span className="farm-allocation-protocol">{a.protocol}</span>
            <span className="farm-allocation-amount">{a.amount.toFixed(2)} USDC</span>
            <span className="farm-allocation-apy">{a.expectedApy}% APY</span>
          </li>
        ))}
      </ul>

      <button type="button" onClick={startFarming} disabled={status === 'running'}>
        Start Farming
      </button>

      {errorMessage && (
        <p className="farm-error" role="alert">
          {errorMessage}
        </p>
      )}
      {status !== 'idle' && status !== 'running' && !errorMessage && (
        <p className="farm-status">{status}</p>
      )}

      <ol className="farm-event-log">
        {events.map((e) => (
          <li key={`${e.name}-${e.at}`}>{e.name}</li>
        ))}
      </ol>
    </section>
  )
}
