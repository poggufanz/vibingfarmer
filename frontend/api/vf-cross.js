// frontend/api/vf-cross.js
// Production proxy: browser -> Pages Function (origin allowlist + rate limit, _guard.js) ->
// cloudflared tunnel -> relayer VM. Local dev does NOT use this (VITE_CROSS_RELAYER_BASE points
// straight at localhost:8788); this exists so the deployed app has a same-origin relayer path
// with the same guard posture as every other /api/* endpoint.
import { applyCors, rateLimit } from './_guard.js'

const TIMEOUT_MS = 30_000 // relayer's per-request work is async (fire-and-forget jobs), so responses are quick

function subPath(url) {
  const pathname = new URL(url, 'http://local').pathname
  const i = pathname.indexOf('/api/vf-cross')
  return (i >= 0 ? pathname.slice(i + '/api/vf-cross'.length) : pathname) || '/'
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export default async function handler(req, res, { fetchImpl = fetch } = {}) {
  if (!applyCors(req, res)) return
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end('')
  }
  if (!rateLimit(req, res, { max: 30, windowMs: 60_000, bucket: 'vf-cross' })) return

  const origin = process.env.RELAYER_ORIGIN
  if (!origin) return sendJson(res, 503, { error: 'relayer not configured' })

  const init = {
    method: req.method,
    headers: {
      'content-type': 'application/json',
      'x-vf-relayer-key': process.env.RELAYER_PROXY_KEY || '',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = JSON.stringify(req.body ?? {})

  try {
    const upstream = await fetchImpl(
      `${origin.replace(/\/$/, '')}/api/vf-cross${subPath(req.url)}`,
      init
    )
    const text = await upstream.text()
    res.statusCode = upstream.status
    res.setHeader('Content-Type', 'application/json')
    return res.end(text || '{}')
  } catch {
    // Never leak upstream/tunnel details to the browser.
    return sendJson(res, 502, { error: 'relayer unreachable' })
  }
}

export const _test = { subPath }
