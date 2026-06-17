// Cloudflare Pages Function → /api/relay
// Thin wrapper over the existing 1Shot Managed API proxy (../../api/relay.js).
// Requires the `nodejs_compat` flag (see wrangler.jsonc) — relay.js dynamically
// imports `@uxly/1shot-client` and `viem`, and reads process.env.* secrets.
import handler from '../../api/relay.js'
import { toPagesFunction } from '../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
