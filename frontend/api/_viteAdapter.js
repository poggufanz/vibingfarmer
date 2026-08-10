// Vite's Connect server does not provide the parsed `req.body` that Pages Functions receive.
// Parse only the raw Node stream here, before a proxy can construct an upstream request or touch
// any other dependency. Keep this ceiling aligned with the Pages adapter's edge limit.
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

function jsonError(res, status, error) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error }))
}

function declaredLength(req) {
  const raw = req.headers?.['content-length'] ?? req.headers?.['Content-Length']
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const length = Number(raw)
  return Number.isSafeInteger(length) && length >= 0 ? length : NaN
}

async function readRawBody(req) {
  const length = declaredLength(req)
  if (Number.isNaN(length)) return { error: 'invalid' }
  if (length !== null && length > MAX_REQUEST_BODY_BYTES) return { tooLarge: true }
  if (!req || typeof req.on !== 'function') return { error: 'invalid' }

  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let settled = false
    const cleanup = () => {
      req.removeListener?.('data', onData)
      req.removeListener?.('end', onEnd)
      req.removeListener?.('error', onError)
      req.removeListener?.('aborted', onAborted)
    }
    const settle = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const onData = (chunk) => {
      if (settled) return
      const bytes = Buffer.from(chunk)
      total += bytes.byteLength
      if (total > MAX_REQUEST_BODY_BYTES) {
        req.pause?.()
        settle({ tooLarge: true })
        return
      }
      chunks.push(bytes)
    }
    const onEnd = () => settle({ text: Buffer.concat(chunks).toString('utf8') })
    const onError = () => settle({ error: 'stream' })
    const onAborted = () => settle({ error: 'stream' })
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/**
 * Add bounded JSON parsing to a Node-style Vite/Connect middleware.
 * @param {(req: any, res: any, next?: Function) => any} handler
 * @returns {(req: any, res: any, next?: Function) => Promise<any>}
 */
export function withJsonBody(handler) {
  return async function viteJsonBodyMiddleware(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.body !== undefined) {
      return handler(req, res, next)
    }

    const read = await readRawBody(req)
    if (read.tooLarge) {
      jsonError(res, 413, 'Request body too large')
      return
    }
    if (read.error) {
      jsonError(res, 400, 'Invalid request')
      return
    }

    try {
      req.body = read.text ? JSON.parse(read.text) : {}
    } catch {
      jsonError(res, 400, 'Invalid request')
      return
    }
    return handler(req, res, next)
  }
}

export const _test = { declaredLength, readRawBody, jsonError }
