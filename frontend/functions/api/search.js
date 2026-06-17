// Cloudflare Pages Function → /api/search
// Thin wrapper over the existing Node-style proxy (../../api/search.js).
import handler from '../../api/search.js'
import { toPagesFunction } from '../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
