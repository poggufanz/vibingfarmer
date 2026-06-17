// Cloudflare Pages Function → /api/ai
// Thin wrapper: runs the existing Node-style proxy (../../api/ai.js) unchanged
// via the Pages adapter. Local Vite dev still uses the same handler through the
// middleware in vite.config.js — single source of truth.
import handler from '../../api/ai.js'
import { toPagesFunction } from '../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
