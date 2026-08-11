// frontend/src/wallet/ui/classic/OnboardingScreen.jsx
// VF Wallet Task 9. This screen used to be a 3-slide marketing carousel ("Coordination Swarm",
// "Secure Boundaries", "Sponsored Relaying") that named jargon (ed25519 session-key, sponsored
// relaying) never explained in plain language, and animated every slide on entry -- both live
// rejection-checklist violations VF Wallet Task 8 deliberately deferred to this task. It is now
// the Standard-vs-Passkey branch: the ONE fork point that happens before backup/recovery
// instructions ever diverge (WalletOnboarding.jsx renders it only for `view: 'choose'`), in plain
// language, no jargon, no entry animation, no gradient.
export default function OnboardingScreen({ onChooseStandard, onChoosePasskey }) {
  return (
    <div className="pc-choice-group">
      <section className="pc-choice">
        <h2>Standard</h2>
        <p>
          Unlock with a password you choose. You back up a 12-word recovery phrase yourself — if you
          lose both the password and the phrase, no one can recover your funds.
        </p>
        <button type="button" className="pc-button pc-button--secondary" onClick={onChooseStandard}>
          Use a Standard wallet
        </button>
      </section>
      <section className="pc-choice">
        <h2>Passkey</h2>
        <p>
          Unlock with your device or password-manager passkey — Face ID, fingerprint, Windows Hello,
          or a synced passkey. Nothing to write down, but recovery depends on that passkey staying
          available.
        </p>
        <button type="button" className="pc-button pc-button--secondary" onClick={onChoosePasskey}>
          Use a Passkey wallet
        </button>
      </section>
    </div>
  )
}
