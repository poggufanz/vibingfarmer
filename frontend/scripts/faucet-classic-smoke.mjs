// frontend/scripts/faucet-classic-smoke.mjs
//
// Closes the gap the unit tests can't: a LIVE classic-G top-up end-to-end —
//   fresh G keypair -> Friendbot (XLM) -> change_trust(USDC) -> getTestUsdc loop -> USDC balance > 0
// This is the exact path the classic-home "Get test USDC" button runs, minus the popup. Proves the
// faucet's new G-address branch + SAC transfer land on a real trustline (a G with NO trustline would
// fail at simulate — fail-closed — so a passing run confirms both the trustline and the dispense).
//
// Run (needs the dev server up for /api/faucet + VF_FAUCET_SECRET configured):
//   cd frontend && VF_RELAY_URL=http://localhost:5173 npx vite-node scripts/faucet-classic-smoke.mjs --submit
//
// Headless + no Face-ID: classic wallets sign locally with a raw ed25519 keypair (unlike the passkey
// path), so the whole flow runs in Node with no WebAuthn.
import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Horizon,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE, HORIZON_URL } from '../src/stellar/config.js'
import { VF_TESTNET_ISSUER } from '../src/wallet/trustline.js'
import { getTestUsdc } from '../src/wallet/faucet.js'

const FRIENDBOT = 'https://friendbot.stellar.org'
const RELAY_ORIGIN = process.env.VF_RELAY_URL || 'http://localhost:5173'
const horizon = new Horizon.Server(HORIZON_URL)

// getTestUsdc posts to the relative FAUCET_PROXY_URL with no Origin (Node has neither). Rewrite to
// the running dev server's absolute URL and inject the dev Origin the guard's allowlist trusts —
// the same forged-Origin seam m3plus-fund-approve-deposit-smoke.mjs uses for the relay.
const smokeFetch = (_url, opts) =>
  fetch(RELAY_ORIGIN + '/api/faucet', {
    ...opts,
    headers: { ...(opts?.headers || {}), origin: RELAY_ORIGIN },
  })

async function fundFriendbot(pubkey) {
  const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pubkey)}`)
  if (!res.ok) throw new Error(`Friendbot funding failed (${res.status}) for ${pubkey}`)
}

async function addTrustline(kp) {
  const acc = await horizon.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', VF_TESTNET_ISSUER) }))
    .setTimeout(120)
    .build()
  tx.sign(kp)
  const res = await horizon.submitTransaction(tx)
  return res.hash
}

async function usdcBalance(pubkey) {
  const acc = await horizon.loadAccount(pubkey)
  const row = acc.balances.find(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === VF_TESTNET_ISSUER
  )
  return row ? row.balance : null
}

async function main() {
  console.log('=== faucet classic-G smoke: friendbot -> trustline -> getTestUsdc ===')
  const kp = Keypair.random()
  console.log('account:', kp.publicKey())

  await fundFriendbot(kp.publicKey())
  console.log('friendbot: funded (XLM)')

  console.log('trustline:', await addTrustline(kp))

  const r = await getTestUsdc({ to: kp.publicKey(), amount: 300n * 10n ** 7n, fetchImpl: smokeFetch })
  console.log('faucet:', {
    dispensed: (Number(r.dispensed) / 1e7).toString() + ' USDC',
    calls: r.calls,
    capped: r.capped,
    lastHash: r.lastHash,
  })

  // Horizon can lag a beat behind the SAC transfer — poll briefly before asserting.
  let bal = null
  for (let i = 0; i < 10; i++) {
    bal = await usdcBalance(kp.publicKey())
    if (bal && Number(bal) > 0) break
    await new Promise((res) => setTimeout(res, 1500))
  }
  console.log('USDC balance:', bal)
  if (!bal || Number(bal) <= 0) throw new Error('USDC balance did not increase — dispense failed')
  console.log('PASS — classic-G faucet top-up landed on-chain.')
}

if (process.argv.includes('--submit')) {
  main().catch((e) => {
    console.error('smoke error:', e?.response?.data?.extras?.result_codes ?? e?.message ?? e)
    process.exitCode = 1
  })
} else {
  console.log('dry: module loaded. Pass --submit to run live (needs dev server + VF_FAUCET_SECRET).')
}
