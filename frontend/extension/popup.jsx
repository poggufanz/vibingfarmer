import React from 'react'
import { createRoot } from 'react-dom/client'

function Popup() {
  function testCeremony() {
    chrome.runtime.sendMessage({
      type: 'SIGN_REQUEST',
      challenge: 'test-challenge',
      rpId: location.hostname || 'localhost',
    })
  }

  return (
    <div style={{ padding: 16, minWidth: 200 }}>
      <h2 style={{ margin: '0 0 12px' }}>VF Wallet</h2>
      <button onClick={testCeremony}>Test ceremony</button>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Popup />)
