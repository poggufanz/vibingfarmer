// Cloudflare Pages Functions adapter.
//
// The API proxies are Node-style `(req, res)` handlers so the same reviewed implementation runs
// in Vite dev/preview and in Pages Functions. This shim bridges Fetch Request/Response values to
// that small Node-ish surface without placing Pages bindings in process.env.

export const MAX_REQUEST_BODY_BYTES = 64 * 1024

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function declaredLengthExceeds(request) {
  const raw = request.headers.get('content-length')
  if (raw === null || raw.trim() === '') return false
  const length = Number(raw)
  return Number.isFinite(length) && length >= 0 && length > MAX_REQUEST_BODY_BYTES
}

async function readBodyWithinLimit(request) {
  if (declaredLengthExceeds(request)) return { tooLarge: true }
  if (!request.body) return { text: '' }

  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      total += chunk.byteLength
      if (total > MAX_REQUEST_BODY_BYTES) {
        // A client can race the boundary with a stream whose cancellation rejects. The byte
        // ceiling remains authoritative even when the transport refuses cancellation.
        try {
          await reader.cancel()
        } catch {
          /* still over the hard limit */
        }
        return { tooLarge: true }
      }
      chunks.push(chunk)
    }
  } catch {
    // Never turn a transport/read failure into an empty JSON object: that would invoke the
    // business handler after a failed boundary read. The adapter maps this to a generic 400.
    return { error: 'stream' }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes) }
}

/**
 * Wrap a Node-style `(req, res)` handler as a Cloudflare Pages `onRequest` handler.
 * @param {(req: any, res: any) => any} handler
 * @returns {(context: { request: Request, env: Record<string, unknown> }) => Promise<Response>}
 */
export function toPagesFunction(handler) {
  return async function onRequest(context) {
    const { request, env = {} } = context

    // Preserve compatibility for legacy handlers that still read string vars from process.env,
    // but never copy object bindings such as VF_DB. Cross-chain and Agent Index code reads the
    // request-local req.env object, so a prior Pages request cannot leak its configuration.
    if (typeof process !== 'undefined' && process.env) {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') process.env[key] = value
      }
    }

    const headers = {}
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    // Cloudflare's header is authoritative. Overwrite an attacker-supplied x-real-ip and remove
    // it entirely when CF-Connecting-IP is absent so Pages rate limits fail closed.
    const cfIp = request.headers.get('cf-connecting-ip')
    if (cfIp && cfIp.trim()) headers['x-real-ip'] = cfIp.trim()
    else delete headers['x-real-ip']

    let body
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const read = await readBodyWithinLimit(request)
      if (read.tooLarge) return jsonResponse(413, { error: 'Request body too large' })
      if (read.error) return jsonResponse(400, { error: 'Invalid request' })
      try {
        body = read.text ? JSON.parse(read.text) : {}
      } catch {
        return jsonResponse(400, { error: 'Invalid request' })
      }
    }

    // Pages bindings remain identical object references on the request; this is essential for
    // D1. URL is copied byte-for-byte, including encoded path/query spelling.
    const req = { method: request.method, headers, body, url: request.url, env }

    let statusCode = 200
    const resHeaders = new Headers()
    let ended = false
    let resolveDone
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })

    const res = {
      get statusCode() {
        return statusCode
      },
      set statusCode(value) {
        statusCode = value
      },
      setHeader(key, value) {
        if (String(key).toLowerCase() === 'set-cookie') {
          const values = Array.isArray(value) ? value : [value]
          for (const cookie of values) resHeaders.append('Set-Cookie', String(cookie))
          return
        }
        resHeaders.set(key, String(value))
      },
      getHeader(key) {
        return resHeaders.get(key)
      },
      end(chunk) {
        if (ended) return
        ended = true
        resolveDone(chunk == null ? '' : chunk)
      },
    }

    const ran = Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        // Keep provider/request errors out of the edge log stream. The stable code is enough for
        // aggregation; the response remains generic and callers cannot inject raw sentinels.
        console.error('[pages-fn] PAGE_HANDLER_FAILED')
        if (!ended) {
          statusCode = 502
          ended = true
          resolveDone(JSON.stringify({ error: 'Server error' }))
        }
      })

    const responseBody = await done
    await ran
    return new Response(responseBody, { status: statusCode, headers: resHeaders })
  }
}

export const _test = { declaredLengthExceeds, readBodyWithinLimit, jsonResponse }
