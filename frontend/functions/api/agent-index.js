// Cloudflare Pages Function → /api/agent-index
// Thin wrapper: runs the existing Node-style handler (../../api/agent-index.js) unchanged via the
// Pages adapter, same pattern as functions/api/ai.js. `context.env.VF_DB` (the D1 binding) rides
// through as `req.env` — see api/_pagesAdapter.js.
import handler from '../../api/agent-index.js'
import { toPagesFunction } from '../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
