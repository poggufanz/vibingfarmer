// "Fund with card" button — opens the on-ramp widget and delivers USDC to `address`.
// Optional path; the default product flow is bring-your-own-USDC (see
// docs/superpowers/specs/2026-07-04-approach-c-hybrid-cross-chain-design.md §2).
import { useState, useCallback } from 'react'
import { OnRamp } from './OnRamp.js'
import './transak.js' // side-effect import: registers the default (Stellar-direct) provider
import './coinbase.js' // side-effect import: registers the documented Base fallback provider

/**
 * @param {object} props
 * @param {string} props.address    destination Stellar G… address
 * @param {number} [props.amount]   optional preset USD amount
 * @param {(result: import('./OnRamp.js').OnRampResult) => void} [props.onResult]
 */
export default function OnRampButton({ address, amount, onResult }) {
  const [status, setStatus] = useState('idle') // idle | opening | done | error
  const [error, setError] = useState(null)

  const handleClick = useCallback(async () => {
    setStatus('opening')
    setError(null)
    try {
      const result = await OnRamp.open({ address, amount })
      setStatus('done')
      onResult?.(result)
    } catch (e) {
      setStatus('error')
      setError(e?.message || 'On-ramp failed to open')
    }
  }, [address, amount, onResult])

  return (
    <div className="onramp-button">
      <button type="button" onClick={handleClick} disabled={status === 'opening' || !address}>
        {status === 'opening' ? 'Opening…' : 'Fund with card'}
      </button>
      {status === 'error' && (
        <p role="alert" className="onramp-error">
          {error}
        </p>
      )}
    </div>
  )
}
