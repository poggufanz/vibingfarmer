// Server-side Tavily proxy. Keeps TAVILY_API_KEY off the client bundle.
// Mirrors api/ai.js: POST-only, origin allowlist, key server-side, input caps.
// Used by both the Vite dev/preview middleware and serverless deploys.
import { applyCors, rateLimit } from './_guard.js'

const TAVILY_URL = 'https://api.tavily.com/search'

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body // pre-parsed (serverless)
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    return res.end(JSON.stringify({ error: 'Method not allowed' }))
  }

  // Origin allowlist + per-IP rate limit (Origin alone is forgeable → not auth)
  if (!applyCors(req, res)) return
  if (!rateLimit(req, res, { max: 30, windowMs: 60_000, bucket: 'search' })) return

  const key = process.env.TAVILY_API_KEY
  if (!key) {
    res.statusCode = 503
    return res.end(JSON.stringify({ error: 'Search proxy not configured' }))
  }

  try {
    const { query, search_depth, max_results, include_answer } = await readBody(req)

    // Input validation — reject oversized/malformed queries
    if (typeof query !== 'string' || query.length === 0 || query.length > 500) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ error: 'Invalid query' }))
    }

    const upstream = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        search_depth: search_depth === 'advanced' ? 'advanced' : 'basic',
        max_results: Math.min(Number(max_results) || 3, 5),
        include_answer: include_answer !== false,
        include_raw_content: false,
      }),
    })
    const text = await upstream.text()
    res.statusCode = upstream.status
    res.setHeader('Content-Type', 'application/json')
    res.end(text)
  } catch {
    res.statusCode = 502
    res.end(JSON.stringify({ error: 'Search proxy failed' }))
  }
}
