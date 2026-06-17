# x402 Facilitator

Use this guide when integrating x402 payments with 1Shot API: provisioning, token setup, and facilitator configuration in a TypeScript/Node service compatible with the Coinbase x402 npm suite. Both V1 and V2 x402 payments are supported but V2 is recommended. 

## Prerequisites

1. **Server wallet** — Provision a server wallet on the target EVM network (see [server-wallets.md](server-wallets.md)). Remind the developer to deposit sufficient gas into the server wallet to cover payment transaction costs; the 1Shot API gas station can convert USDC into gas on supported chains.
2. **EIP-3009 token** — Import an EIP-3009 compatible token (exposes `transferWithAuthorization`) into your 1Shot API account. In the 1Shot Prompts directory, filter by the x402 category, open the token, then under "Write Functions" select `transferWithAuthorization` and click "Add to My Contract Methods", or use "Create Contract Methods for All Functions". See the [smart contracts](smart-constracts.md) skills for how to search and import smart contract functions.
   - **Signature / ABI compatibility** — EIP-3009 defines `transferWithAuthorization` with a signature as separate `v`, `r`, and `s` parameters. Some tokens (e.g. USDC) also expose an overload that takes a single signature bytes string. 1Shot API requires the **v, r, s** form to be present in the token’s contract ABI. The x402 `/verify` and `/settle` endpoints accept the signature in the format specified by the x402 standard; 1Shot API splits that signature into v, r, and s and calls `transferWithAuthorization` accordingly. This allows support for tokens such as PYUSD.

## Install

```bash
npm install @1shotapi/x402-facilitator
```

## External x402 Core packages

```bash
## Express middleware integration for the x402 Payment Protocol
npm install @x402/express
## EVM implementation of the x402 payment protocol using the Exact payment scheme with EIP-3009 TransferWithAuthorization.
npm install @x402/evm
## Core implementation of the x402 payment protocol 
npm install @x402/core
```

## Package exports

- **create1ShotAPIFacilitatorClient** — An `HTTPFacilitatorClient` for use with `@x402` middleware

## Environment contract

| Variable | Required | Purpose |
|----------|----------|---------|
| `ONESHOT_API_KEY` | Yes | API key from 1Shot API business account |
| `ONESHOT_API_SECRET` | Yes | API secret from 1Shot API business account |


> [!NOTE]
> For browser-based agent wallets, configure your x402 resource endpoints so they are not blocked by restrictive cross-origin rules. For example, disable CORS middleware that denies third-party origins, or set permissive `Access-Control-Allow-*` headers on those routes. Otherwise, the browser blocks client-side code from reaching resources required for the x402 flow.

```javascript
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { create1ShotAPIFacilitatorClient } from "@1shotapi/x402-facilitator";

const app = express();
const facilitatorClient = create1ShotAPIFacilitatorClient({
  apiKey: process.env.ONESHOT_API_KEY,
  apiSecret: process.env.ONESHOT_API_SECRET,
});

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing required environment variable: EVM_ADDRESS");
  process.exit(1);
}

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: evmAddress,
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      "eip155:84532",
      new ExactEvmScheme(),
    ),
  ),
);

app.get("/weather", (_, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
```
