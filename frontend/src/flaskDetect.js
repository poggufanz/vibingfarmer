// flaskDetect.js
// Detects MetaMask version and Flask availability.
// Called before any ERC-7715 operation (wallet_requestExecutionPermissions).

/**
 * Detect the installed MetaMask flavor + version and whether it supports ERC-7715.
 * Never throws — returns a descriptor object.
 * @returns {Promise<{type:'none'|'flask'|'stable', isFlask:boolean, supportsERC7715:boolean, version?:string, clientVersion?:string}>}
 */
export async function detectMetaMaskVersion() {
  if (!window.ethereum) {
    return { type: 'none', isFlask: false, supportsERC7715: false }
  }

  try {
    // Method 1: canonical Flask flag (Flask's inpage provider sets this).
    let isFlask = window.ethereum.isMetaMaskFlask === true

    // web3_clientVersion → Flask reports e.g. "MetaMask/v13.9.0-flask.0".
    // Also drives the version shown in the ConnectCard badge.
    let clientVersion
    try { clientVersion = await window.ethereum.request({ method: 'web3_clientVersion' }) } catch {}

    // Method 2: clientVersion explicitly tags "flask" (covers builds where the
    // property is missing). Deliberately NOT matching plain "metamask/" — stable
    // reports that too and it would misclassify every wallet as Flask.
    if (!isFlask && String(clientVersion).toLowerCase().includes('flask')) isFlask = true

    // Method 3: multi-wallet injection — Flask sitting in the providers array.
    if (!isFlask && Array.isArray(window.ethereum.providers)) {
      isFlask = window.ethereum.providers.some((p) => p?.isMetaMaskFlask === true)
    }

    const versionMatch = String(clientVersion).match(/v(\d+)\.(\d+)/i)
    const major = versionMatch ? parseInt(versionMatch[1]) : 0
    const minor = versionMatch ? parseInt(versionMatch[2]) : 0

    // ERC-7715 needs Flask 13.5+. Fail OPEN on an unknown/unparsable version so a
    // real Flask user is never blocked over a version-string quirk.
    const versionOk = !versionMatch || major > 13 || (major === 13 && minor >= 5)
    const supportsERC7715 = isFlask && versionOk

    return {
      type: isFlask ? 'flask' : 'stable',
      isFlask,
      supportsERC7715,
      version: versionMatch ? `${major}.${minor}` : 'unknown',
      clientVersion,
    }
  } catch {
    // Detection itself threw — fail OPEN (assume Flask) so legitimate Flask users
    // are never blocked. A stable user instead hits a clear error at permission time.
    return { type: 'flask', isFlask: true, supportsERC7715: true, version: 'unknown' }
  }
}

/**
 * Throw FLASK_REQUIRED:<type> when the wallet can't do ERC-7715.
 * Call before wallet_requestExecutionPermissions.
 * @returns {Promise<object>} the detection result when supported
 */
export async function requireFlask() {
  const result = await detectMetaMaskVersion()
  if (!result.supportsERC7715) {
    throw new Error(`FLASK_REQUIRED:${result.type}`)
  }
  return result
}
