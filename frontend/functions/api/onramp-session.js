// Cloudflare Pages Function → /api/onramp-session
// Thin wrapper over the Transak session proxy (../../api/onramp-session.js).
import handler from '../../api/onramp-session.js'
import { toPagesFunction } from '../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
