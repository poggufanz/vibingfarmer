import { VENICE_BASE_URL } from './config.js'

// Venice x402 — wallet-funded inference (Base mainnet, USDC).
// The browser does SIWE auth (MetaMask personal_sign, see signSiweForVenice in
// wallet.js) and this read-only balance check. Top-up is intentionally NOT done
// client-side: the official venice-x402-client SDK and x402/createPaymentHeader
// are private-key based (server/agent model) and the browser holds no raw key.
// Real USDC top-up on Base mainnet belongs to a server agent, not this UI.
// Docs: https://docs.venice.ai/guides/integrations/x402-venice-api

const BALANCE_TIMEOUT_MS = 8000

/**
 * @typedef {object} X402Balance
 * @property {boolean} canConsume       - whether the wallet can make paid requests now
 * @property {number}  balanceUsd        - current spendable balance (USD)
 * @property {number}  minimumTopUpUsd   - minimum top-up Venice suggests
 * @property {number}  suggestedTopUpUsd - suggested top-up amount
 * @property {number}  diemBalanceUsd    - DIEM-backed balance from a linked account, if any
 */

/**
 * Read the x402 prepaid balance for a wallet. Read-only, no funds move.
 * Fail-soft: returns null on any error so the caller treats balance as unknown
 * (and may still optimistically try x402 — the generateStrategy catch covers a 402).
 * @param {string} address - EVM (0x...) or Solana base58 address
 * @param {string} veniceAuth - base64 X-Sign-In-With-X header from signSiweForVenice()
 * @returns {Promise<X402Balance|null>}
 */
export async function getX402Balance(address, veniceAuth) {
  if (!address || !veniceAuth) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS)
  try {
    const res = await fetch(`${VENICE_BASE_URL}/x402/balance/${address}`, {
      method: 'GET',
      headers: { 'X-Sign-In-With-X': veniceAuth },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`x402 balance ${res.status}`)
    const d = await res.json()
    return {
      canConsume: Boolean(d.canConsume),
      balanceUsd: Number(d.balanceUsd ?? 0),
      minimumTopUpUsd: Number(d.minimumTopUpUsd ?? 0),
      suggestedTopUpUsd: Number(d.suggestedTopUpUsd ?? 0),
      diemBalanceUsd: Number(d.diemBalanceUsd ?? 0),
    }
  } catch (err) {
    console.warn('[x402] balance check failed:', err.message)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Decide whether to use the x402 wallet path for inference.
 * Only blocks when Venice explicitly reports the wallet cannot consume
 * (known-unfunded). Unknown (null) → allow, so a balance-endpoint outage does
 * not regress the existing optimistic behavior.
 * @param {X402Balance|null} balance - from getX402Balance()
 * @returns {boolean}
 */
export function canUseX402(balance) {
  return !(balance && balance.canConsume === false)
}
