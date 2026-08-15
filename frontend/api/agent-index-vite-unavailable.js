export default function handler(_req, res, _next) {
  res.statusCode = 503
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify({ error: 'Agent index requires Pages+D1; use npm run pages:dev' }))
}
