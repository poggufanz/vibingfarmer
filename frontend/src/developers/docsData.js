// Static API reference. Source of truth: frontend/api/vf handlers (verified 2026-07-11).

// Scope groups — the product's permission model, reused as the docs' organizing spine.
// `grant` mirrors the human-readable note shown in the key permission picker.
export const SCOPES = [
  { id: 'strategy', grant: 'AI allocation using market context' },
  { id: 'market', grant: 'Read-only market data' },
  { id: 'tx', grant: 'Unsigned XDR only' },
  { id: 'submit', grant: 'Deposit-only fee-bump relay' },
  { id: 'scan', grant: 'Risk verdict' },
]

export const ERRORS = [
  {
    status: 401,
    error: 'Missing or invalid API key',
    when: 'Authorization: Bearer header is missing or invalid',
  },
  { status: 403, error: 'Out of scope', when: 'Key lacks the required scope' },
  {
    status: 429,
    error: 'Too many requests',
    when: 'Per-key rate limit exceeded; Retry-After header is set',
  },
  { status: 503, error: 'Daily budget exhausted', when: 'Global daily cap for the scope reached' },
]

export const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/vf/strategy',
    scope: 'strategy',
    desc: 'AI allocation strategy (DeepSeek, deterministic fallback).',
    req: `{ "amountUsd": 250, "riskLevel": "low" | "medium" | "high", "vaultCount": 3 }`,
    resp: `{ "allocations": [{ "protocol": "blend-usdc", "pct": 100 }], "reasoning": "…", "source": "llm" | "fallback" }`,
  },
  {
    method: 'POST',
    path: '/api/vf/scan',
    scope: 'scan',
    desc: 'Scan-before-send: classify target, check known vault, eligibility verdict. `eligibility` is present only when isKnownVault is true.',
    req: `{ "target": "C… | G…", "protocol": "blend-usdc" }`,
    resp: `{ "kind": "account" | "contract" | "invalid", "isKnownVault": true, "eligibility": { "protocol": "blend-usdc", "eligible": true, "yieldReality": { "ratio": 1.1, "verdict": "real" }, "security": { "score": 82, "auditGate": "pass" }, "reasons": [], "isFixture": false, "facts": { … } } }`,
  },
  {
    method: 'POST',
    path: '/api/vf/build-tx',
    scope: 'tx',
    desc: 'Build an unsigned vault deposit transaction. Signing stays client-side.',
    req: `{ "kind": "deposit", "from": "G…", "amount": "25000000" }`,
    resp: `{ "xdr": "AAAA…" }`,
  },
  {
    method: 'POST',
    path: '/api/vf/simulate',
    scope: 'tx',
    desc: 'Simulate a transaction on Soroban without submitting.',
    req: `{ "xdr": "AAAA…" }`,
    resp: `{ "ok": true, "latestLedger": 123456 }\n\nThe "error" key is present only when ok=false.`,
  },
  {
    method: 'POST',
    path: '/api/vf/submit',
    scope: 'submit',
    desc: 'Gasless relay: fee-bumps and submits a pre-signed transaction.',
    req: `{ "xdr": "AAAA…" }`,
    resp: `{ "hash": "…", "status": "PENDING", "relayer": "G…" }`,
  },
  {
    method: 'GET',
    path: '/api/vf/prices?coins=coingecko:stellar,coingecko:usd-coin',
    scope: 'market',
    desc: 'Current prices via DeFiLlama coins API.',
    req: null,
    resp: `{ "coins": { "coingecko:stellar": { "price": 0.4, "symbol": "XLM", "decimals": 7, "timestamp": 1752200000 } } }`,
  },
  {
    method: 'GET',
    path: '/api/vf/vault-facts?protocol=blend-usdc',
    scope: 'market',
    desc: 'Vault facts (APY, cap, fees) for a protocol.',
    req: null,
    resp: `{ "protocol": "blend-usdc", "isFixture": false, "facts": { … } }`,
  },
  {
    method: 'POST',
    path: '/api/vf/eligibility',
    scope: 'market',
    desc: 'Deposit eligibility verdict for a vault at an amount.',
    req: `{ "vault": "C…", "amount": "25000000", "protocol": "blend-usdc" }`,
    resp: `{ "allow": true, "verdict": { "protocol": "blend-usdc", "eligible": true, "yieldReality": { … }, "security": { … }, "reasons": [], "isFixture": false, "facts": { … } }, "reasons": [] }`,
  },
]
