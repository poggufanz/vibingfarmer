// Single-key HTTP client for the VF gateway. Replaces scattered provider calls:
// the wallet build ships ONE env var (VITE_VF_API_KEY) and zero upstream keys.
import { RelaySubmissionUnknownError } from '../stellar/relay.js'

export function makeVfClient({ apiKey, base = '/api/vf' }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
  async function call(path, { method = 'GET', body, submissionAware = false } = {}) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const out = await r.json().catch(() => ({}))
    if (submissionAware && out?.submission === 'unknown') {
      const result = Object.fromEntries(
        ['hash', 'status', 'relayer', 'duplicate']
          .filter((field) => Object.prototype.hasOwnProperty.call(out, field))
          .map((field) => [field, out[field]])
      )
      const error = new RelaySubmissionUnknownError(
        out.error || 'VF relay submission outcome is unknown',
        Object.keys(result).length > 0 ? result : null
      )
      error.httpStatus = r.status
      throw error
    }
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`)
    return out
  }
  return {
    strategy: (body) => call('/strategy', { method: 'POST', body }),
    eligibility: (body) => call('/eligibility', { method: 'POST', body }),
    vaultFacts: (protocol) => call(`/vault-facts?protocol=${encodeURIComponent(protocol)}`),
    prices: (coins) => call(`/prices?coins=${encodeURIComponent(coins)}`),
    buildTx: (body) => call('/build-tx', { method: 'POST', body }),
    simulate: (xdr) => call('/simulate', { method: 'POST', body: { xdr } }),
    submit: (xdr) => call('/submit', { method: 'POST', body: { xdr }, submissionAware: true }),
    scan: (body) => call('/scan', { method: 'POST', body }),
  }
}

export function vfClientFromEnv() {
  const apiKey = import.meta.env?.VITE_VF_API_KEY
  return apiKey ? makeVfClient({ apiKey }) : null
}
