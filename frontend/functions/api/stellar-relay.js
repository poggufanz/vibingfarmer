// Cloudflare Pages Function → /api/stellar-relay
// Thin wrapper over the Soroban fee-bump relay (../../api/stellar-relay.js).
// Requires the `nodejs_compat` flag (already set in wrangler.jsonc) — the handler
// dynamically imports `@stellar/stellar-sdk` and reads process.env.STELLAR_* secrets.
import handler from '../../api/stellar-relay.js'
import { toPagesFunction } from '../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
