import { useEffect, useState } from 'react'

export default function ReceiveScreen({ publicKey }) {
  const [src, setSrc] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    import('./qr.js').then(({ addressQrDataUrl }) => addressQrDataUrl(publicKey).then(setSrc))
  }, [publicKey])
  return (
    <div className="vf-screen vf-receive">
      <h2>Receive</h2>
      {src && <img className="vf-qr" src={src} alt="Wallet address QR" width={180} height={180} />}
      <code className="vf-address-full">{publicKey}</code>
      <button
        className="vf-btn"
        onClick={() => {
          navigator.clipboard?.writeText(publicKey)
          setCopied(true)
        }}
      >
        {copied ? 'Copied' : 'Copy address'}
      </button>
    </div>
  )
}
