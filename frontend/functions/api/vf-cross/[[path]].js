// frontend/functions/api/vf-cross/[[path]].js
// Cloudflare Pages Function → /api/vf-cross/* (catch-all). Thin wrapper, same pattern as
// functions/api/ai.js.
import handler from '../../../api/vf-cross.js'
import { toPagesFunction } from '../../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
