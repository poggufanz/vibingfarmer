// Cloudflare Pages Function → /api/faucet. Thin wrapper over ../../api/faucet.js.
// Requires `nodejs_compat` (already set in wrangler.jsonc): dynamically imports
// @stellar/stellar-sdk and reads process.env.VF_FAUCET_SECRET / SOROBAN_TOKEN_ADDRESS.
import handler from '../../api/faucet.js'
import { toPagesFunction } from '../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(handler)
