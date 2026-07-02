import { useState } from 'react'
import { signIn, listKeys, createKey, revokeKey } from './portalClient.js'
import { connectWallet } from './walletSign.js'

const ALL_SCOPES = ['strategy', 'market', 'tx', 'submit', 'scan']

export default function DevelopersPage() {
  const [session, setSession] = useState(null) // { jwt, address }
  const [keys, setKeys] = useState([])
  const [freshKey, setFreshKey] = useState(null) // { key, hint } — show-once modal
  const [scopes, setScopes] = useState(['market', 'scan'])
  const [env, setEnv] = useState('test')
  const [error, setError] = useState('')

  async function onConnect() {
    try {
      setError('')
      const { address, signChallenge } = await connectWallet()
      const jwt = await signIn({ account: address, signChallenge })
      setSession({ jwt, address })
      setKeys(await listKeys(jwt))
    } catch (e) {
      setError(e.message)
    }
  }

  async function onGenerate() {
    try {
      setError('')
      const out = await createKey(session.jwt, { scopes, env, rateLimit: 60 })
      setFreshKey(out)
      setKeys(await listKeys(session.jwt))
    } catch (e) {
      setError(e.message)
    }
  }

  async function onRevoke(id) {
    try {
      await revokeKey(session.jwt, id)
      setKeys(await listKeys(session.jwt))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="developers-page">
      <header>
        <h1>Developers</h1>
        <p>One VF API key unlocks strategy, risk scanning, and gasless deposit relay.</p>
      </header>
      {error && <p role="alert">{error}</p>}

      {!session ? (
        <button onClick={onConnect}>Connect wallet</button>
      ) : (
        <>
          <section aria-label="issue key">
            <fieldset>
              <legend>Scopes</legend>
              {ALL_SCOPES.map((s) => (
                <label key={s}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={() =>
                      setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
                    }
                  />
                  {s}
                </label>
              ))}
            </fieldset>
            <label>
              Environment
              <select value={env} onChange={(e) => setEnv(e.target.value)}>
                <option value="test">test</option>
                <option value="live">live</option>
              </select>
            </label>
            <button onClick={onGenerate} disabled={scopes.length === 0}>
              Generate key
            </button>
          </section>

          <section aria-label="your keys">
            {keys.map((k) => (
              <div className="document-row" key={k.id}>
                <code>{k.key_hint}</code>
                <span>{JSON.parse(k.scopes).join(' · ')}</span>
                <span>{k.enabled ? 'active' : 'revoked'}</span>
                {k.enabled ? <button onClick={() => onRevoke(k.id)}>Revoke</button> : null}
              </div>
            ))}
          </section>
        </>
      )}

      {freshKey && (
        <div role="dialog" aria-label="new api key">
          <p>Copy your key now — it will not be shown again.</p>
          <code>{freshKey.key}</code>
          <button onClick={() => navigator.clipboard.writeText(freshKey.key)}>Copy</button>
          <button onClick={() => setFreshKey(null)}>Done</button>
        </div>
      )}
    </div>
  )
}
