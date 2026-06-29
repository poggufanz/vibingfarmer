import { runCeremony } from '../src/wallet/passkey.js'

const params = new URLSearchParams(location.search)
const challenge = params.get('challenge')
const rpId = params.get('rpId')

;(async () => {
  try {
    const out = await runCeremony({ kind: 'get', challenge, rpId })
    const tabId = (await chrome.tabs.getCurrent())?.id
    chrome.runtime.sendMessage({
      type: 'CEREMONY_RESULT',
      tabId,
      assertion: {
        authenticatorData: Array.from(out.authenticatorData),
        clientDataJSON: out.clientDataJSON,
        signature: Array.from(out.signature),
      },
    })
    window.close()
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'CEREMONY_ERROR', error: String(e) })
  }
})()
