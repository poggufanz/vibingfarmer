// frontend/src/wallet/ui/classic/ReceiveScreen.jsx
// VF Wallet Task 10, Step 2 -- recomposed onto the shared pc-* primitives (WalletShell.jsx owns
// the CSS). Renders the QR + full address + copy confirmation; account type is already shown by
// WalletReceive.jsx's WalletShell wrapper (the account chip every screen gets when given
// `account`), so this leaf component does not duplicate it.
import { useEffect, useState } from 'react'

export default function ReceiveScreen({ publicKey }) {
  const [src, setSrc] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    import('./qr.js').then(({ addressQrDataUrl }) =>
      addressQrDataUrl(publicKey).then((url) => {
        if (!cancelled) setSrc(url)
      })
    )
    return () => {
      cancelled = true
    }
  }, [publicKey])

  const handleCopy = () => {
    navigator.clipboard?.writeText(publicKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div data-testid="receive-screen">
      <p className="pc-route-intro">Scan or share your Stellar address.</p>

      {src ? (
        <img src={src} alt="Wallet address QR" width={176} height={176} />
      ) : (
        <p className="pc-field-help">Loading QR…</p>
      )}

      <code className="pc-technical pc-address-full" data-testid="receive-address">
        {publicKey}
      </code>

      <button type="button" className="pc-button pc-button--primary" onClick={handleCopy}>
        {copied ? 'Copied to clipboard' : 'Copy address'}
      </button>
    </div>
  )
}
