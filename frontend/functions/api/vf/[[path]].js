// Cloudflare Pages catch-all → /api/vf/* (single wrapper; routing in api/vf/_router.js)
import vfRouter from '../../../api/vf/_router.js'
import { toPagesFunction } from '../../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(vfRouter)
