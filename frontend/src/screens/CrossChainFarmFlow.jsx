// frontend/src/screens/CrossChainFarmFlow.jsx
// Onboarding -> mandate -> Farm/Withdraw container (Approach C hybrid design, SP3 follow-up
// Item B). The Wallet Kit-connected `App` in app.jsx never touches this path — this is a
// separate, self-contained state machine dedicated to the passkey + ZeroDev session-key flow
// SP3 built (wallet/passkeyStellar.js, wallet/passkeyBase.js, wallet/mandate.js) but never wired
// anywhere. All state is local useState (no context/store), matching this project's existing
// screen container style (see Farm.jsx, Withdraw.jsx).
//
// Step order: onboard (two WebAuthn ceremonies -> Stellar + Base passkey wallets) -> mandate (AI
// allocation -> one ZeroDev session-key permission approval -> registered with the relayer
// exactly once via postMandate) -> farm (deposit) / withdraw (unwind), toggled by `view`.
//
// sessionPrivateKey never leaves the handleCreateMandate closure below: it is read from
// createMandate's return value, handed to postMandate, and discarded — never stored in state,
// never logged. postFarm (inside Farm -> crossChainFarm.js) never carries it (controller
// decision, plan Option 2). DEV-only exception: when import.meta.env.DEV, the same closure also
// mirrors the material onto window.__vfDevMandateFixture so scripts/smoke-mandate.mjs's
// out-of-policy scenarios (via src/dev/devDispatch.js) have real session material to exercise —
// stripped from production builds, see scripts/assert-no-dev-dispatch.mjs.
import { useState, useCallback } from 'react'
import { createStellarPasskeyWallet } from '../wallet/passkeyStellar.js'
import { createBaseSmartAccount } from '../wallet/passkeyBase.js'
import { createMandate } from '../wallet/mandate.js'
import { allocateBasePools } from '../strategist.js'
import { postMandate, quantizeAllocations } from '../base/relayerClient.js'
import { readPositions } from '../base/readPositions.js'
import Farm from './Farm.jsx'
import Withdraw from './Withdraw.jsx'

const MANDATE_TTL_SECONDS = 3600 // "set once" — one hour session-key window (spec §6 step 1)

const STEP = { ONBOARD: 'onboard', MANDATE: 'mandate', FARM: 'farm' }
const VIEW = { FARM: 'farm', WITHDRAW: 'withdraw' }

export default function CrossChainFarmFlow() {
  const [step, setStep] = useState(STEP.ONBOARD)
  const [view, setView] = useState(VIEW.FARM)

  const [email, setEmail] = useState('')
  const [onboardStatus, setOnboardStatus] = useState('idle') // idle | running | error
  const [onboardError, setOnboardError] = useState(null)
  const [stellarWallet, setStellarWallet] = useState(null)
  const [baseAccount, setBaseAccount] = useState(null)

  const [amount, setAmount] = useState(100)
  const [riskLevel, setRiskLevel] = useState('medium')
  const [nPools, setNPools] = useState(2)
  const [mandateStatus, setMandateStatus] = useState('idle') // idle | running | error
  const [mandateError, setMandateError] = useState(null)
  const [allocations, setAllocations] = useState(null)
  const [serializedApproval, setSerializedApproval] = useState(null)
  const [sessionKeyAddress, setSessionKeyAddress] = useState(null)

  const [positionsStatus, setPositionsStatus] = useState('idle') // idle | running | error
  const [positionsError, setPositionsError] = useState(null)
  const [positions, setPositions] = useState([])

  const handleOnboard = useCallback(async () => {
    setOnboardStatus('running')
    setOnboardError(null)
    try {
      const wallet = await createStellarPasskeyWallet({ email })
      const account = await createBaseSmartAccount({ passkeyName: email, mode: 'register' })
      setStellarWallet(wallet)
      setBaseAccount(account)
      setOnboardStatus('idle')
      setStep(STEP.MANDATE)
    } catch (err) {
      setOnboardStatus('error')
      // A message-less rejection must still surface — an empty error string renders NO alert
      // and is indistinguishable from a silent hang.
      setOnboardError(err?.message || String(err))
    }
  }, [email])

  const handleCreateMandate = useCallback(async () => {
    setMandateStatus('running')
    setMandateError(null)
    try {
      const allocs = quantizeAllocations(await allocateBasePools({ amount, riskLevel, nPools }))
      const pools = allocs.map((a) => ({ pool: a.pool, cap: a.amountBaseUnits }))
      const expiry = Math.floor(Date.now() / 1000) + MANDATE_TTL_SECONDS

      const mandate = await createMandate({
        kernelAccount: baseAccount.kernelAccount,
        publicClient: baseAccount.publicClient,
        passkeyValidator: baseAccount.passkeyValidator,
        pools,
        expiry,
      })

      // Registered with the relayer exactly ONCE, here — the farm dispatch itself never carries
      // sessionPrivateKey. The key lives only in this closure, from createMandate's return value
      // to this one postMandate call.
      await postMandate({
        serializedApproval: mandate.serializedApproval,
        sessionPrivateKey: mandate.sessionPrivateKey,
      })

      // DEV-only: hands the live session material to the smoke script's out-of-policy scenarios
      // (window.__vfDevDispatchRawCall). Statically stripped from production builds
      // (import.meta.env.DEV is compile-time false) — enforced by
      // scripts/assert-no-dev-dispatch.mjs postbuild.
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        window.__vfDevMandateFixture = {
          publicClient: baseAccount.publicClient,
          serializedApproval: mandate.serializedApproval,
          sessionPrivateKey: mandate.sessionPrivateKey,
          pool: allocs[0].pool,
        }
      }

      setAllocations(allocs)
      setSerializedApproval(mandate.serializedApproval)
      setSessionKeyAddress(mandate.sessionKeyAddress)
      setMandateStatus('idle')
      setStep(STEP.FARM)
    } catch (err) {
      setMandateStatus('error')
      setMandateError(err?.message || String(err))
    }
  }, [amount, riskLevel, nPools, baseAccount])

  const handleShowWithdraw = useCallback(async () => {
    setPositionsStatus('running')
    setPositionsError(null)
    try {
      const pools = allocations.map((a) => a.pool)
      const result = await readPositions({
        pools,
        account: baseAccount.address,
        publicClient: baseAccount.publicClient,
      })
      setPositions(result)
      setPositionsStatus('idle')
      setView(VIEW.WITHDRAW)
    } catch (err) {
      setPositionsStatus('error')
      setPositionsError(err?.message || String(err))
    }
  }, [allocations, baseAccount])

  if (step === STEP.ONBOARD) {
    return (
      <section className="cross-chain-farm-flow cross-chain-farm-flow--onboard">
        <h2>Connect your device</h2>
        <p>Creates a Stellar wallet and a Base smart account from the same passkey device.</p>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>
        <button
          type="button"
          onClick={handleOnboard}
          disabled={onboardStatus === 'running' || !email}
        >
          Create passkey wallets
        </button>
        {onboardError && (
          <p className="cross-chain-farm-flow-error" role="alert">
            {onboardError}
          </p>
        )}
      </section>
    )
  }

  if (step === STEP.MANDATE) {
    return (
      <section className="cross-chain-farm-flow cross-chain-farm-flow--mandate">
        <h2>Set your farming mandate</h2>
        <p>
          Stellar wallet: <code data-testid="stellar-wallet-address">{stellarWallet.address}</code>
        </p>
        <p>
          Base account: <code data-testid="base-account-address">{baseAccount.address}</code>
        </p>
        <label>
          Amount (USDC)
          <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </label>
        <label>
          Risk level
          <select value={riskLevel} onChange={(e) => setRiskLevel(e.target.value)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label>
          Number of pools
          <input type="number" value={nPools} onChange={(e) => setNPools(Number(e.target.value))} />
        </label>
        <button type="button" onClick={handleCreateMandate} disabled={mandateStatus === 'running'}>
          Create mandate
        </button>
        {mandateError && (
          <p className="cross-chain-farm-flow-error" role="alert">
            {mandateError}
          </p>
        )}
      </section>
    )
  }

  return (
    <div className="cross-chain-farm-flow cross-chain-farm-flow--farm">
      {view === VIEW.FARM && (
        <>
          <p>
            Mandate approval:{' '}
            <code data-testid="mandate-serialized-approval">
              {serializedApproval && serializedApproval.slice(0, 16)}…
            </code>
          </p>
          <Farm
            amount={amount}
            riskLevel={riskLevel}
            nPools={nPools}
            stellarWallet={stellarWallet}
            baseRecipientAddress={baseAccount.address}
            sessionKeyAddress={sessionKeyAddress}
            serializedApproval={serializedApproval}
            allocations={allocations}
          />
          <button
            type="button"
            onClick={handleShowWithdraw}
            disabled={positionsStatus === 'running'}
          >
            View positions / Withdraw
          </button>
          {positionsError && (
            <p className="cross-chain-farm-flow-error" role="alert">
              {positionsError}
            </p>
          )}
        </>
      )}
      {view === VIEW.WITHDRAW && (
        <Withdraw
          ownerKernelAccount={baseAccount.kernelAccount}
          publicClient={baseAccount.publicClient}
          withdrawals={positions}
          stellarRecipient={stellarWallet.address}
          totalAssetsForBurn={positions.reduce((sum, p) => sum + p.minAssets, 0n)}
        />
      )}
    </div>
  )
}
