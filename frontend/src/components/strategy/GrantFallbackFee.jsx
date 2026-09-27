// frontend/src/components/strategy/GrantFallbackFee.jsx
// P1 G10: display-only fallback fee on the grant review screen — what the grant costs when
// the relay is down and the owner pays it themselves. The number comes from a simulated
// grant-shaped transaction (stellar/grantFeeEstimate.js); a failed simulation renders as
// "unavailable", never a guess. Relay/direct submission logic is untouched.
import { useEffect, useState } from 'react'
import { estimateGrantFallbackFee } from '../../stellar/grantFeeEstimate.js'

export default function GrantFallbackFee({
  owner,
  agentCount,
  budgets,
  durationSeconds,
  estimate = estimateGrantFallbackFee,
}) {
  const [state, setState] = useState({ status: 'loading', feeXlm: null })
  const budgetsKey = JSON.stringify(budgets ?? null)

  useEffect(() => {
    let dead = false
    setState({ status: 'loading', feeXlm: null })
    let parsed = null
    try {
      parsed = JSON.parse(budgetsKey)
    } catch {
      parsed = null
    }
    estimate({ owner, agentCount, budgets: parsed, durationSeconds }).then((out) => {
      if (dead) return
      setState(out ? { status: 'ready', feeXlm: out.feeXlm } : { status: 'unavailable', feeXlm: null })
    })
    return () => {
      dead = true
    }
  }, [owner, agentCount, budgetsKey, durationSeconds, estimate])

  if (state.status === 'loading') return <p>Estimating fallback network fee…</p>
  if (state.status === 'ready')
    return (
      <p>
        If the relay is down, you pay the network fee yourself: {state.feeXlm} (simulated
        estimate, not a quote).
      </p>
    )
  return <p>Fallback network fee estimate unavailable.</p>
}
