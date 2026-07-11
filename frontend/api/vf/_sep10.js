// SEP-10 web auth (stateless: the server signature on the challenge makes a nonce
// table unnecessary; replay window = the 300 s challenge timebounds + 1 h JWT).
import { Keypair, WebAuth } from '@stellar/stellar-sdk'

const TIMEOUT_SEC = 300

export async function buildChallenge({ account, signingSecret, homeDomain, networkPassphrase }) {
  const serverKp = Keypair.fromSecret(signingSecret)
  const transaction = WebAuth.buildChallengeTx(
    serverKp,
    account,
    homeDomain,
    TIMEOUT_SEC,
    networkPassphrase,
    homeDomain // web_auth_domain
  )
  return { transaction, network_passphrase: networkPassphrase }
}

export async function verifyChallenge({ signedXdr, signingSecret, homeDomain, networkPassphrase }) {
  try {
    const serverKp = Keypair.fromSecret(signingSecret)
    const { clientAccountID } = WebAuth.readChallengeTx(
      signedXdr,
      serverKp.publicKey(),
      networkPassphrase,
      homeDomain,
      homeDomain
    )
    // Throws unless the client account's signature is present and valid.
    WebAuth.verifyChallengeTxSigners(
      signedXdr,
      serverKp.publicKey(),
      networkPassphrase,
      [clientAccountID],
      homeDomain,
      homeDomain
    )
    return { ok: true, account: clientAccountID }
  } catch (err) {
    return { ok: false, error: err?.message || 'invalid challenge' }
  }
}
