// AI allocation strategy. LLM (DeepSeek, server key) with a deterministic equal-split
// fallback — the strategist NEVER blocks the flow (mirrors src/strategist.js philosophy).
import { z } from 'zod'
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
const MODEL = 'deepseek-v4-flash'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

const InputSchema = z.object({
  amountUsd: z.number().positive(),
  riskLevel: z.enum(['low', 'medium', 'high']),
  vaultCount: z.number().int().min(1).max(10),
})

export function equalSplit(protocols, vaultCount) {
  const picks = protocols.slice(0, Math.max(1, Math.min(vaultCount, protocols.length)))
  const base = Math.floor(100 / picks.length)
  return picks.map((protocol, i) => ({
    protocol,
    pct: i === 0 ? 100 - base * (picks.length - 1) : base,
  }))
}

export function parseLlmPlan(text, protocols) {
  try {
    const obj = JSON.parse(text)
    const allocations = obj?.allocations
    if (!Array.isArray(allocations) || allocations.length === 0) return null
    let sum = 0
    for (const a of allocations) {
      if (!protocols.includes(a.protocol)) return null
      if (typeof a.pct !== 'number' || a.pct <= 0) return null
      sum += a.pct
    }
    if (Math.abs(sum - 100) > 1) return null
    return { allocations, reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '' }
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'strategy' })
  if (!ctx) return
  const parsed = InputSchema.safeParse(req.body ?? {})
  if (!parsed.success) return json(res, 400, { error: 'Invalid strategy request' })
  const { amountUsd, riskLevel, vaultCount } = parsed.data
  const protocols = (process.env.VF_VAULT_CATALOG || 'blend-usdc')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (apiKey) {
    try {
      const upstream = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          model: MODEL,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are a conservative DeFi allocation strategist. Reply ONLY with JSON: ' +
                '{"allocations":[{"protocol":<string>,"pct":<number>}],"reasoning":<string>} — pcts sum to 100, ' +
                'protocols strictly from the given catalog.',
            },
            {
              role: 'user',
              content: `amountUsd=${amountUsd} riskLevel=${riskLevel} vaultCount=${vaultCount} catalog=${protocols.join(',')}`,
            },
          ],
        }),
      })
      if (upstream.ok) {
        const data = await upstream.json()
        const plan = parseLlmPlan(data?.choices?.[0]?.message?.content ?? '', protocols)
        if (plan) return json(res, 200, { ...plan, source: 'llm' })
      }
    } catch {
      // fall through to the deterministic fallback — never block
    }
  }
  json(res, 200, {
    allocations: equalSplit(protocols, vaultCount),
    reasoning: 'Equal split across the vetted catalog (deterministic fallback).',
    source: 'fallback',
  })
}
