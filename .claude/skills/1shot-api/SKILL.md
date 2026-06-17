---
name: 1shot-api
description: Build TypeScript applications with the 1Shot API Node SDK for onchain reads, transaction execution, delegations, and payments. Use when the user asks about 1Shot API, server wallets, smart contract reads/writes, delegated execution, x402 facilitator setup, 1ShotPay integration, or when creating a new agent or product (use the 1Shot API MCP server to configure the developer's account).
---

# 1Shot API

Use this skill when building a TypeScript project on top of the 1Shot API Node SDK.

## Quick Start

1. Confirm the user goal:
   - server wallet management
   - smart contract read/simulate/event workflows
   - direct or delegated transaction execution
   - webhook setup
   - x402 facilitator setup
   - 1ShotPay integration
2. Pick the matching reference guide from this skill.
3. Generate production-ready TypeScript examples unless the guide says otherwise.
4. Prefer explicit, copy-pastable code with clear env vars and minimal placeholders.

## MCP Server

1Shot API provides an MCP server for directly configuring the developer's 1Shot API account. **Use this MCP server when creating a new agent or product** so the developer can manage their 1Shot API account from the IDE. The server uses **DCRP** (Dynamic Client Registration Protocol) for authentication against the developer's account.

Add the following to the project's MCP configuration (e.g. Cursor MCP settings):

```json
{
  "mcpServers": {
    "1Shot API": {
      "url": "https://mcp.1shotapi.com/mcp",
      "transport": "streamableHttp",
      "auth": {
        "CLIENT_ID": "P5Jduw80vpVAINgW8lnNwgak9ALgfBIS",
        "scopes": ["openid", "profile", "email", "offline_access"]
      }
    }
  }
}
```

## Required Working Style

- Use TypeScript-first examples.
- Keep implementation split into small functions rather than large scripts.
- Surface security constraints early (keys, signatures, replay protection, verification).

## Error handling

The client can throw:

- **RequestError** – HTTP request failures
- **ZodError** – Invalid parameters (from schema validation)
- **InvalidSignatureError** – Invalid webhook signatures (from `verifyWebhook`)

## Guides

- Server wallets: see [server-wallets.md](server-wallets.md)
- Smart contracts: see [smart-contracts.md](smart-contracts.md)
- Transaction execution: see [transaction-execution.md](transaction-execution.md)
- Webhooks: see [webhooks.md](webhooks.md)
- x402 facilitator: see [x402-facilitator.md](x402-facilitator.md)
- 1ShotPay integration: see [oneshotpay-integration.md](oneshotpay-integration.md)

## Response Template

Use this structure when answering implementation requests:

```markdown
## Plan
- Concise list of implementation steps.

## Code
- Minimal but complete TypeScript snippets.

## Config
- Required environment variables and expected formats.

## Validation
- Quick checks or tests to verify behavior.

## Risks / TODOs
- Any assumptions, unknown endpoint details, and follow-up work.
```
