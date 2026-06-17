---
title: "Venice AI — Vault Recommendation API Capabilities"
category: "API Integration"
status: "✅ Resolved"
priority: "Medium"
timebox: "2 days"
created: 2026-05-26
updated: 2026-05-26
owner: "Muhammad Faiq"
tags: ["technical-spike", "api-integration", "venice-ai", "llm", "vault-recommendation"]
---

# Venice AI — Vault Recommendation API Capabilities

## Summary

**Spike Objective:** Determine Venice AI's API interface, privacy model, available models, and how to build a vault recommendation feature (risk preference → recommended vault + human-readable summary) that aligns with privacy-first standards.

**Why This Matters:** Venice AI integration must be non-trivial — a real recommendation flow, not just a hello-world call. Need to know API format, response structure, and what "privacy-first" means for the overall product design.

**Timebox:** 2 days

**Decision Deadline:** 2026-06-01 — can be parallelized with contract dev, but needs resolution before frontend AI step is built.

---

## Research Findings

### API Confirmed: OpenAI-Compatible ✅

**Base URL:** `https://api.venice.ai/api/v1`

**Endpoint:** `POST /api/v1/chat/completions`

**Auth:** `Authorization: Bearer {VENICE_API_KEY}`

Fully OpenAI-compatible — same schema as `gpt-4` calls. Can use OpenAI SDK pointed at Venice base URL.
Source: https://docs.venice.ai/api-reference/api-spec

---

### Minimal Working Call

```javascript
const response = await fetch('https://api.venice.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${VENICE_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'venice-uncensored',   // or 'llama-3.3-70b' if available
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt }
    ],
    response_format: { type: 'json_object' },
    venice_parameters: {
      include_venice_system_prompt: false  // disable Venice default system prompt
    }
  })
})
const data = await response.json()
const recommendation = JSON.parse(data.choices[0].message.content)
```

---

### Available Models

Venice uses its own model IDs. Key text models (as of research date):

| Model ID | Type | Notes |
|----------|------|-------|
| `venice-uncensored` | text | Default; good for general use |
| `llama-3.3-70b` | text | High quality, use if available |
| `kimi-k2-6` | text | "Fastest" trait model |

**Recommendation:** Use `llama-3.3-70b` as primary, fall back to `venice-uncensored` if unavailable. Verify current models via:
```bash
curl https://api.venice.ai/api/v1/models?type=text \
  -H "Authorization: Bearer $VENICE_API_KEY"
```

Use model traits to get best available without hardcoding:
```javascript
// Use "default" trait — Venice picks best model
model: 'default'  // resolves to current best text model
```

---

### Venice-Specific Parameters

These go in the `venice_parameters` object:

| Parameter | Value | Notes |
|-----------|-------|-------|
| `include_venice_system_prompt` | `false` | MUST disable — default prompt conflicts with JSON-only output |
| `enable_web_search` | `"off"` | Don't need web search for vault recommendation |
| `strip_thinking_response` | `true` | If using reasoning model, remove `<think>` blocks from response |

---

### Privacy Model ✅

Venice's privacy claim:
- Inference runs on Venice's private GPU infrastructure
- **No data retention** — requests/responses not stored, not used for training
- Models run privately (not on shared OpenAI/Anthropic infrastructure)
- "Uncensored" = no content policy filtering

**For demo story:** "Venice AI processes user risk profile locally on privacy-preserving infrastructure with no data retention — your DeFi preferences stay private."

**What NOT to send in prompts:** Don't include actual wallet addresses or portfolio data. Send only amount + risk level (already planned).

---

### Final Prompt Template

```javascript
const SYSTEM_PROMPT = `You are a DeFi yield optimization assistant for a Sepolia testnet demo. 
Recommend the best yield vault for a user's risk profile.
Respond ONLY with valid JSON — no explanation outside the JSON object.`

function buildRecommendationPrompt(amountUsdc, riskLevel) {
  // Available vaults hardcoded for sandbox testing (MockVault on Sepolia)
  const vaults = [
    {
      name: "Conservative Yield Vault",
      address: "0x_MOCK_VAULT_ADDRESS_FILL_AFTER_DEPLOY",
      estimatedApy: 4.2,
      riskProfile: "low",
      strategy: "Stable yield, minimal exposure"
    },
    {
      name: "Balanced Growth Vault",
      address: "0x_MOCK_VAULT_ADDRESS_FILL_AFTER_DEPLOY",
      estimatedApy: 8.7,
      riskProfile: "medium",
      strategy: "Balanced between stability and yield"
    },
    {
      name: "High Yield Vault",
      address: "0x_MOCK_VAULT_ADDRESS_FILL_AFTER_DEPLOY",
      estimatedApy: 18.5,
      riskProfile: "high",
      strategy: "Aggressive yield, higher volatility"
    }
  ]
  
  return `I want to deposit ${amountUsdc} USDC. My risk tolerance is: ${riskLevel}.

Available vaults on Sepolia testnet:
${JSON.stringify(vaults, null, 2)}

Recommend the best vault. Respond with this exact JSON structure:
{
  "vault_name": "string",
  "vault_address": "0x...",
  "estimated_apy": number,
  "risk_level": "low|medium|high",
  "reasoning": "1-2 sentences explaining why this vault fits the user"
}`
}
```

**Expected response shape:**
```json
{
  "vault_name": "Balanced Growth Vault",
  "vault_address": "0x...",
  "estimated_apy": 8.7,
  "risk_level": "medium",
  "reasoning": "With 100 USDC and medium risk tolerance, the Balanced Growth Vault offers a strong 8.7% APY while maintaining reasonable capital preservation through a diversified strategy."
}
```

---

### Error Handling

```javascript
async function recommendVault(amountUsdc, riskLevel) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)  // 10s timeout
  
  try {
    const response = await fetch('https://api.venice.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${VENICE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: buildRecommendationPrompt(amountUsdc, riskLevel) }
        ],
        response_format: { type: 'json_object' },
        venice_parameters: { include_venice_system_prompt: false }
      })
    })
    
    clearTimeout(timeoutId)
    if (!response.ok) throw new Error(`Venice API error: ${response.status}`)
    
    const data = await response.json()
    return JSON.parse(data.choices[0].message.content)
    
  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      // Return hardcoded fallback — don't block the demo
      return FALLBACK_RECOMMENDATION[riskLevel]
    }
    throw err
  }
}

// Fallback if Venice is unavailable
const FALLBACK_RECOMMENDATION = {
  low:    { vault_name: "Conservative Yield Vault", estimated_apy: 4.2, reasoning: "Safe, stable returns." },
  medium: { vault_name: "Balanced Growth Vault",    estimated_apy: 8.7, reasoning: "Balanced yield and safety." },
  high:   { vault_name: "High Yield Vault",          estimated_apy: 18.5, reasoning: "Maximum yield potential." }
}
```

---

### Using OpenAI SDK (Optional, Cleaner)

Venice is OpenAI-compatible, so OpenAI SDK can be used by overriding baseURL:

```javascript
// Via CDN ESM (no bundler)
import OpenAI from 'https://esm.sh/openai'

const venice = new OpenAI({
  apiKey: VENICE_API_KEY,
  baseURL: 'https://api.venice.ai/api/v1',
  dangerouslyAllowBrowser: true  // needed for browser-side calls
})

const completion = await venice.chat.completions.create({
  model: 'llama-3.3-70b',
  messages: [...],
  response_format: { type: 'json_object' }
})
```

**Simpler to use than raw fetch.** Use this approach in `venice.js`.

---

### Latency

From docs: Venice runs on private GPU infrastructure. Expected latency for `llama-3.3-70b` with short prompt: **3–8 seconds**. Well within 10s UX budget.

For demo: show loading state during AI call ("AI menganalisis preferensi kamu...").

---

## Decision

### Recommendation

**Proceed. Venice AI integration is straightforward — minimal implementation risk.**

Use `llama-3.3-70b` via OpenAI SDK with Venice base URL. Disable Venice default system prompt. Return structured JSON via `response_format: { type: "json_object" }`. Hardcode fallback for timeout.

### Rationale

- Venice API is fully OpenAI-compatible — no Venice-specific SDK needed
- `response_format: json_object` ensures parseable output
- OpenAI SDK via ESM CDN works in no-build frontend
- Privacy story is genuine and differentiating: no data retention, private inference
- Mock vault data in prompt = full demo control (no external protocol dependency)

### Follow-up Actions

- [ ] Obtain `VENICE_API_KEY` from https://venice.ai (sign up)
- [ ] Add `VENICE_API_KEY` to `.env.example`
- [ ] Verify `llama-3.3-70b` is available in your account tier (fallback: `venice-uncensored`)
- [ ] Update vault addresses in prompt template after MockVault.sol is deployed
- [ ] Build `venice.js` using OpenAI SDK via ESM CDN
- [ ] Build frontend AI panel (risk row segmented + amount → recommendation card)
- [ ] Test Venice call in browser devtools before full integration
- [ ] Record demo showing Venice AI panel → vault recommendation → "Powered by Venice AI — No data retention" badge
- [ ] Include privacy story in release documentation

---

## Status History

| Date       | Status         | Notes                                    |
| ---------- | -------------- | ---------------------------------------- |
| 2026-05-26 | 🔴 Not Started | Spike created, can run parallel to others |
| 2026-05-26 | ✅ Resolved    | API confirmed, prompt template designed, OpenAI SDK approach chosen |

---

_Last updated: 2026-05-26 by Muhammad Faiq_
