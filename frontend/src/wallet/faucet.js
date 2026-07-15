// frontend/src/wallet/faucet.js
// Client helper for the in-wallet "Get test USDC" button. The /api/faucet endpoint dispenses at
// most 100 USDC per call (server CAP_BASE_UNITS); a "top-up 300" therefore loops it. Sequential
// on purpose — the server's per-IP rate limit AND per-recipient daily accounting both assume one
// request at a time; Promise.all would race the daily reservation and trip the limiter.
//
// ponytail: client loop over the 100-cap endpoint. If 3 round-trips ever matters, the upgrade path
// is a server-side 'topup' action that dispenses up to the daily cap in one tx — raise CAP there.
import { FAUCET_PROXY_URL } from '../stellar/config.js'

// 7-decimal token. Mirrors the server's CAP_BASE_UNITS (100 USDC) — the most a single call yields.
export const PER_CALL_BASE_UNITS = 100n * 10n ** 7n

/**
 * Dispense `amount` (base units, bigint) of test USDC to `to` (G or C address) by looping the
 * 100-cap faucet. Stops early when the server reports its daily cap (HTTP 429). Never throws on a
 * reached-cap — returns what was dispensed so the UI can show partial success.
 *
 * @returns {Promise<{ dispensed: bigint, calls: number, lastHash: string|null, capped: boolean }>}
 * @throws on a non-429 HTTP failure (misconfig, forbidden origin, RPC reject) — the UI surfaces it.
 */
export async function getTestUsdc({ to, amount = PER_CALL_BASE_UNITS, fetchImpl = fetch }) {
  let target = typeof amount === 'bigint' ? amount : BigInt(amount)
  if (target <= 0n) target = PER_CALL_BASE_UNITS
  let dispensed = 0n
  let calls = 0
  let lastHash = null

  while (dispensed < target) {
    const perCall =
      target - dispensed < PER_CALL_BASE_UNITS ? target - dispensed : PER_CALL_BASE_UNITS
    const res = await fetchImpl(FAUCET_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dispense', to, amount: perCall.toString() }),
    })
    if (res.status === 429) return { dispensed, calls, lastHash, capped: true } // daily cap reached
    if (!res.ok) throw new Error(`Faucet failed (${res.status}): ${await res.text()}`)
    const out = await res.json()
    if (out?.configured === false) throw new Error('Faucet is not configured on this server.')
    dispensed += perCall
    calls += 1
    lastHash = out?.hash ?? lastHash
  }
  return { dispensed, calls, lastHash, capped: false }
}
