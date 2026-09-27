// frontend/src/components/money/VaultProtection.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). "Vault protection": the lifeboat mandate's own
// truth, surfaced honestly. Exercised via MyMoneyRoute.test.jsx (this file has no dedicated test
// per the brief's Files list) -- every assertion below is covered there.
//
// Consumes ONLY `model.protection` (buildMyMoneyModel's own `resolveProtection` output,
// myMoneyModel.js:112-132,145-149): `{state, authority, mandateExpiry, urgentRenewal,
// ownerIsAuthority}`. Lifeboat is a SINGLE vault-wide mandate, never per-owner
// (automationEvidence.js:65-67's own comment) -- this component never implies "your protection",
// only ever "the vault's protection".
//
// Step 2's "one state-aware primary action" rule means the actual Renew vault protection BUTTON
// lives in exactly one place: MoneyHero, via choosePrimaryMoneyAction's own precedence
// (myMoneyModel.js:337-343, rule 4 -- itself already gated on `ownerIsAuthority`). This section
// only ever DESCRIBES that same gating in plain text; it never renders a second, duplicate button
// for the identical action (MyMoneyRoute.test.jsx's own guard catches a regression here: two
// buttons named "Renew vault protection" on one page is not two real actions, it is one action
// wired twice).
import { formatUtcSeconds } from './formatUtc.js'

// `tone` drives the status lamp; the live-region role keeps StatusNotice's own rule
// (warning -> alert, info -> status) so assistive tech hears the same urgency as before.
const STATE_COPY = Object.freeze({
  engaged: {
    statusState: 'warning',
    tone: 'warn',
    title: 'Engaged',
    body: 'The vault has been de-risked under the lifeboat mandate.',
  },
  armed: {
    statusState: 'info',
    tone: 'live',
    title: 'Armed',
    body: 'The lifeboat mandate is armed and ready if the vault needs de-risking.',
  },
  disarmed: {
    statusState: 'warning',
    tone: 'warn',
    title: 'Disarmed',
    body: 'The lifeboat mandate has lapsed and needs renewal.',
  },
  unavailable: {
    statusState: 'info',
    tone: 'idle',
    title: 'Status unavailable',
    body: 'The vault protection state could not be confirmed right now.',
  },
})

export function VaultProtection({ protection }) {
  const copy = STATE_COPY[protection?.state] ?? STATE_COPY.unavailable
  const renewalDue = protection?.urgentRenewal === true
  const ownerCanRenew = renewalDue && protection?.ownerIsAuthority === true
  const authorityBlocked = renewalDue && protection?.ownerIsAuthority === false
  const expiry = formatUtcSeconds(protection?.mandateExpiry)

  return (
    <section
      className="pc-money-section"
      aria-labelledby="vault-protection-heading"
      data-pocket-enter
    >
      <header>
        <h2 id="vault-protection-heading">Vault protection</h2>
        <p className="pc-money-section-lede">Emergency de-risk for the whole vault.</p>
      </header>
      <div className="pc-money-panel">
        <div
          className="pc-protection-state"
          data-tone={copy.tone}
          role={copy.statusState === 'warning' ? 'alert' : 'status'}
        >
          <span className="pc-lamp pc-lamp--large" aria-hidden="true" />
          <div>
            <p className="pc-protection-title">{copy.title}</p>
            <p>{copy.body}</p>
          </div>
        </div>

        <dl className="pc-readouts pc-readouts--facts">
          <div className="pc-readout">
            <dt>Configured authority</dt>
            <dd>
              {protection?.authority ? (
                <code className="pc-technical">{protection.authority}</code>
              ) : (
                'Unavailable'
              )}
            </dd>
          </div>
          <div className="pc-readout">
            <dt>Mandate expiry</dt>
            <dd className={expiry === 'Unavailable' ? undefined : 'pc-technical'}>{expiry}</dd>
          </div>
        </dl>

        {ownerCanRenew && (
          <p className="pc-money-callout" data-tone="warn">
            Renewal is due. Use the Renew vault protection action above to renew it.
          </p>
        )}
        {authorityBlocked && (
          <p className="pc-money-callout" data-tone="warn">
            Renewal is due, but only the configured authority (
            {protection.authority || 'unavailable'}) can renew it.
          </p>
        )}

        <p className="pc-money-footnote">
          This protection is vault-wide. It covers every depositor in the vault, not just your own
          funds, and only the vault's configured authority can renew it.
        </p>
      </div>
    </section>
  )
}
