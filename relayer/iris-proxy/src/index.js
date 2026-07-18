// vf-iris-proxy: Circle Iris attestation proxy.
// Exists because the dev ISP TLS-intercepts *.circle.com (see relayer/SMOKE.md 2026-07-17) —
// Cloudflare egress is not subject to that block. Point the relayer's IRIS_URL at this worker.
// Fail-closed surface: GET only, /v2/messages/* only, fixed upstream — NOT an open proxy.
export default {
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return Response.json({ error: 'method not allowed' }, { status: 405 })
    }
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/v2/messages/')) {
      return Response.json({ error: 'not found' }, { status: 404 })
    }
    const upstream = env.IRIS_UPSTREAM || 'https://iris-api-sandbox.circle.com'
    const target = `${upstream}${url.pathname}${url.search}`
    const res = await fetch(target, { headers: { accept: 'application/json' } })
    // Re-wrap so upstream hop-by-hop headers never leak through.
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
    })
  },
}
