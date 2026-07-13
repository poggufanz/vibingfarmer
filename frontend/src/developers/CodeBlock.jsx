import { useState } from 'react'

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

const CopyIcon = () => (
  <svg {...iconProps}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

const CheckIcon = () => (
  <svg {...iconProps}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

// Copy-to-clipboard code block. `code` is both rendered and copied, so the icon
// can never drift from what's on screen. `style` lands on the wrapper (spacing),
// `preStyle` on the <pre> (look). Copied state only shows on a real clipboard write.
export default function CodeBlock({ code, style, preStyle }) {
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked (insecure context / denied) — no false confirmation */
    }
  }

  return (
    <div className="codeblock" style={style}>
      <pre className="mono" style={preStyle}>
        {code}
      </pre>
      <button
        type="button"
        className={`codeblock-copy${copied ? ' is-copied' : ''}`}
        onClick={onCopy}
        aria-label={copied ? 'Copied to clipboard' : 'Copy code to clipboard'}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
}
