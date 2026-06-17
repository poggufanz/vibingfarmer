// Cloudflare Pages Functions adapter.
//
// The proxies in this directory (ai / search / relay) are written as Node-style
// `(req, res)` handlers so they run inside the Vite dev/preview middleware
// (see vite.config.js). Cloudflare Pages Functions instead use the Web Fetch
// signature `onRequest(context) -> Response`. Rather than fork the carefully
// reviewed handler logic (esp. relay.js security), this shim wraps an existing
// handler so the SAME code runs unchanged on Pages.
//
// What it bridges:
//   • context.request (Web Request)  → a minimal Node-ish `req`
//       - headers   : lowercased plain object (handlers read req.headers.origin etc.)
//       - body      : pre-parsed JSON object, so readBody() takes its fast path and
//                     never touches the Node `Buffer`/stream branch
//       - x-real-ip : injected from Cloudflare's `CF-Connecting-IP` so the per-IP
//                     rate limiter in _guard.js keys on the true client IP
//   • context.env (Pages vars/secrets) → process.env, so handlers keep reading
//                     process.env.* with no changes (call-time reads; nodejs_compat
//                     also auto-populates process.env at startup for module-level reads)
//   • a buffering `res` (statusCode/setHeader/end) → a Web `Response`
//
// Files prefixed with `_` are import-only — Pages never routes them.

/**
 * Wrap a Node-style `(req, res)` handler as a Cloudflare Pages `onRequest` handler.
 * @param {(req: any, res: any) => any} handler
 * @returns {(context: { request: Request, env: Record<string, unknown> }) => Promise<Response>}
 */
export function toPagesFunction(handler) {
  return async function onRequest(context) {
    const { request, env } = context

    // Surface Pages vars/secrets to process.env for call-time reads in the handlers.
    if (typeof process !== 'undefined' && process.env && env) {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === 'string') process.env[k] = v
      }
    }

    // ── Web Request → Node-ish req ──
    const headers = {}
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    // _guard.clientIp() prefers x-real-ip; Cloudflare's authoritative client IP
    // is CF-Connecting-IP. Map it so the rate-limit bucket keys on the real client.
    const cfIp = request.headers.get('cf-connecting-ip')
    if (cfIp && !headers['x-real-ip']) headers['x-real-ip'] = cfIp

    let body
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        const text = await request.text()
        body = text ? JSON.parse(text) : {}
      } catch {
        body = {} // malformed body → handler validation rejects it downstream
      }
    }

    const req = { method: request.method, headers, body, url: request.url }

    // ── buffering res → Web Response ──
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

    // The handler resolves the body via res.end(). If it throws before ending,
    // fail closed with a generic 502 (never leak internal error detail).
    const ran = Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        console.error('[pages-fn] handler error:', err?.message || err)
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
