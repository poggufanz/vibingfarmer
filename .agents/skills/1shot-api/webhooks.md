# Webhooks

Use this guide when the user asks about 1Shot API webhooks: endpoints (URLs that receive payloads), triggers (rules that decide when to send), event names, key rotation (keys are created for each endpoint and used to verify authenticity of a callback), and delivery inspection.

The API separates **webhook endpoints** (destination URLs and keys) from **webhook triggers** (which events send to which endpoint, with optional contract-method filters).

## MCP Tool

When building an agent or product that leverages webhooks, endpoints and triggers can be configured directly from the 1Shot API MCP server. 

## Topics Covered

- Get available webhook event names
- Webhook triggers: list, create, update, delete
- Webhook endpoints: list, create, get, update, delete, rotate key
- Webhook deliveries and delivery attempts (per endpoint / per webhook)
- Verify incoming webhook signatures with `verifyWebhook`

## SDK Setup

```bash
npm install @1shotapi/client-sdk
```

```ts
import { OneShotClient } from "@1shotapi/client-sdk";

const client = new OneShotClient({
  apiKey: process.env.ONESHOT_API_KEY!,
  apiSecret: process.env.ONESHOT_API_SECRET!,
});
```

Assume `business_id` and endpoint/trigger IDs are UUIDs from the API.

---

## 4.1 Get available webhook event names

List event names that may trigger webhooks (e.g. `TransactionExecutionSuccess`, `TransactionExecutionFailure`).

```ts
const { events } = await client.webhooks.getEvents();
// events: ("TransactionExecutionFailure" | "TransactionExecutionSuccess" | ...)[]
```

---

## 4.2 Webhook triggers

Triggers bind an endpoint to one or more event names; optionally restrict by contract method IDs.

**List webhook triggers**

```ts
const { response, page, pageSize, totalResults } =
  await client.webhooks.listTriggers("your_business_id", {
    page: 1,
    pageSize: 25,
  });
```

**Create webhook trigger**

```ts
const trigger = await client.webhooks.createTrigger("your_business_id", {
  endpointId: "your_webhook_endpoint_id",
  eventNames: ["TransactionExecutionSuccess", "TransactionExecutionFailure"],
  name: "Transaction notifications",
  description: "Notify on success or failure",
  contractMethodIds: ["method_uuid_1", "method_uuid_2"], // optional
});
```

**Update webhook trigger**

```ts
const updated = await client.webhooks.updateTrigger("your_webhook_trigger_id", {
  eventNames: ["TransactionExecutionSuccess"],
  name: "Success only",
});
```

**Delete webhook trigger**

```ts
const { success } = await client.webhooks.deleteTrigger("your_webhook_trigger_id");
```

---

## 4.3 Webhook endpoints

Endpoints are the URLs that receive webhook payloads. Create returns a `publicKey` for verifying signatures.

**List webhook endpoints**

```ts
const { response, page, pageSize, totalResults } =
  await client.webhooks.listEndpoints("your_business_id", {
    page: 1,
    pageSize: 25,
  });
```

**Create webhook endpoint**

```ts
const endpoint = await client.webhooks.createEndpoint("your_business_id", {
  destinationUrl: "https://your-app.com/webhooks/1shot",
  name: "Production webhook",
  description: "Receives transaction and balance events",
});
// endpoint.id, endpoint.publicKey, endpoint.destinationUrl, etc.
```

**Get webhook endpoint**

```ts
const endpoint = await client.webhooks.getEndpoint("your_webhook_endpoint_id");
```

**Update webhook endpoint**

Name or description only; URL cannot be changed.

```ts
const updated = await client.webhooks.updateEndpoint("your_webhook_endpoint_id", {
  name: "Production (primary)",
  description: "Updated description",
});
```

**Delete webhook endpoint**

```ts
const { success } = await client.webhooks.deleteEndpoint("your_webhook_endpoint_id");
```

**Rotate webhook endpoint key**

Rotate the private key; use the returned `publicKey` to verify future webhook signatures.

```ts
const endpoint = await client.webhooks.rotateEndpointKey("your_webhook_endpoint_id");
// endpoint.publicKey is the new key; update your verification config
```

---

## 4.4 Webhook deliveries and attempts

**List webhooks for an endpoint**

List generated webhook deliveries for a specific endpoint.

```ts
const { response, page, pageSize, totalResults } =
  await client.webhooks.listWebhooksForEndpoint("your_webhook_endpoint_id", {
    page: 1,
    pageSize: 25,
  });
// response[].id, response[].eventName, response[].content, response[].status
```

**List delivery attempts for a webhook**

List attempts for a single webhook (e.g. to debug failures).

```ts
const { response, page, pageSize, totalResults } =
  await client.webhooks.listDeliveryAttempts("your_webhook_id", {
    page: 1,
    pageSize: 25,
  });
// response[].httpResponse, response[].clientResponse, response[].timestamp
```

---

## Webhook verification

1Shot API signs webhook payloads. Verify signatures using the SDK utility and the endpoint’s `publicKey`.

**Using the standalone function**

```ts
import { verifyWebhook } from "@1shotapi/client-sdk";
import express from "express";

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const body = req.body;
  const signature = body.signature;
  delete body.signature;

  if (!signature) {
    return res.status(400).json({ error: "Signature missing" });
  }

  const publicKey = "your_webhook_public_key";

  try {
    const isValid = verifyWebhook({
      body,
      signature,
      publicKey,
    });

    if (!isValid) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    return res.json({ message: "Webhook verified successfully" });
  } catch (error) {
    return res.status(403).json({ error: (error as Error).message });
  }
});
```

**Guidance**

- Store `publicKey` per endpoint (e.g. from create/rotate) and use it when verifying.
- After rotating an endpoint key, switch to the new `publicKey` for verification.
- Do not log raw signatures or full payloads; treat webhook bodies as sensitive.
