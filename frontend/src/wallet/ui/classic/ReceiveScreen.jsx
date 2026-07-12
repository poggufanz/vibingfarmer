import { useEffect, useState } from 'react'

export default function ReceiveScreen({ publicKey }) {
  const [src, setSrc] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    import('./qr.js').then(({ addressQrDataUrl }) => addressQrDataUrl(publicKey).then(setSrc))
  }, [publicKey])

  const handleCopy = () => {
    navigator.clipboard?.writeText(publicKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="vf-screen vf-receive">
      <h2>Receive</h2>
      <p className="vf-hint">Scan or share your Stellar address</p>

      {src ? (
        <img className="vf-qr" src={src} alt="Wallet address QR" width={176} height={176} />
      ) : (
        <div
          style={{
            width: 176,
            height: 176,
            margin: '0 auto',
            borderRadius: 'var(--r-lg)',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-faint)',
            fontSize: '11px',
          }}
        >
          Loading QR…
        </div>
      )}

      <code className="vf-address-full">{publicKey}</code>

      <button
        className={`vf-btn ${copied ? 'primary' : ''}`}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
        }}
        onClick={handleCopy}
      >
        {copied ? (
          <span style={{ fontWeight: 'bold' }}>Copied to clipboard</span>
        ) : (
          <>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>Copy address</span>
          </>
        )}
      </button>
    </div>
  )
}
