# 1ShotPay Integration

Two main integration patterns:

1. **Client-side** — Embeds the 1ShotPay passkey wallet in your app via an iframe. The parent site uses the client SDK to trigger one-time payments, subscriptions, or 402-protected fetches from the iframe wallet.
2. **Server-side** — Uses your 1ShotPay **UserId** and **API Token** (from your account: **Advanced Settings** under your user profile). The server creates **pay links**; the user opens the link in a new tab, completes payment, then returns to your app.

Use this guide when implementing either path. Prefer TypeScript and the official SDK packages below.

---

## Client-Side Integration

### Overview

- Mounts an **iframe** in your application (the 1ShotPay wallet UI).
- Parent page invokes wallet actions via **@1shotapi/1shotpay-client-sdk** (e.g. one-time payment, subscription delegation, or paying for 402-protected API calls).

### Install

```bash
yarn add @1shotapi/1shotpay-client-sdk @1shotapi/1shotpay-common
```

Import shared types (`BigNumberString`, `ELocale`, `EVMAccountAddress`, `UnixTimestamp`, `USDCAmount`, etc.) from `@1shotapi/1shotpay-common` when needed.

### Quick Start

```ts
import { OneShotPayClient } from "@1shotapi/1shotpay-client-sdk";
import {
  BigNumberString,
  ELocale,
  EVMAccountAddress,
  UnixTimestamp,
  USDCAmount,
} from "@1shotapi/1shotpay-common";

const wallet = new OneShotPayClient();

await wallet.initialize("Wallet", [], ELocale.English).match(
  () => undefined,
  (err) => {
    throw err;
  },
);

wallet.show();   // show iframe modal
wallet.hide();   // hide iframe modal
```

### Key APIs

- **OneShotPayClient** — Main entry: `initialize()`, `getStatus()`, `signIn()`, `signOut()`, `getAccountAddress()`, `getERC3009Signature()`, `getSubscription()`, `getPermitSignature()`, `x402Fetch()`, `show()`, `hide()`, `getVisible()`.
- **Visibility** — `show()` / `hide()` control the iframe modal; `getVisible()` returns whether it is shown.
- **Iframe events** — `closeFrame` (user closes UI), `registrationRequired` (open registration URL in a new tab).

### One-Time Payment (ERC-3009 signature)

Use when you need a transfer signature for a fixed amount to a recipient:

```ts
const result = await wallet
  .getERC3009Signature(
    "Some recipient",                    // 1ShotPay counterparty title
    EVMAccountAddress("0x..."),          // destination address
    BigNumberString("1"),                // amount in atomic USDC (1e6 = $1)
    UnixTimestamp(1715222400),           // valid before timestamp 
    UnixTimestamp(1715222400),           // valid after timestamp
  )
  .match(
    (ok) => ok,
    (err) => {
      throw err;
    },
  );
```

### Pay for 402-Protected API (x402Fetch)

For x402-gated URLs, the client can pay and fetch directly from the user's 1ShotPay balance:

```ts
const response = await wallet
  .x402Fetch("https://api.example.com/paid-resource")
  .match(
    (ok) => ok,
    (err) => {
      throw err;
    },
  );
if (response.ok) {
  const data = await response.json();
  // use data
}
```

### Subscription (delegation)

Pass at least one of `amountPerDay`, `amountPerWeek`, or `amountPerMonth`. Store the resulting delegation in 1Shot API using `wallets.createDelegation` and execute on an appropriate schedule using `contractMethods.executeAsDelegator` or batch many subscription payments using `contractMethods.executeBatchAsDelegator`:

```ts
const delegation = await wallet
  .getSubscription(
    "Premium plan",                         // Name of the subscription the user sees
    "Monthly access to premium features",   // Description to show the user
    EVMAccountAddress("0x..."),             // The address funds will be sent to
    null,                                   // Max amount per day in USDC atomic units
    null,                                   // Max amount per week in USDC atomic units
    USDCAmount("9.99"),                     // Max amount per month in USDC atomic units
  )
  .match(
    (ok) => ok,
    (err) => {
      throw err;
    },
  );
```

### Client-Side Conventions

- Handle `Result` / `ResultAsync` with `.match(okFn, errFn)` (or equivalent) so the UI can show pending/success/failure.
- Listen for `closeFrame` and `registrationRequired` if you need to react when the user closes the wallet or must complete registration in a new tab.

---

## Server-Side Integration

### Overview

- Requires the application developer to provide **UserId** and **API Token** from their 1ShotPay account (**Advanced Settings** under user profile).
- Server creates **pay links** with a hosted checkout URL. User opens the URL in a new tab, submits payment, then is redirected back to the original application (or a URL you control).
- Pay links are both human and agent payable. The human-payable link pattern is `https://1shotpay.com/link/{payLinkId}` while the x402 agent payable link pattern is `https://1shotpay.com/api/link/{payLinkId}`.

### Install

```bash
yarn add @1shotapi/1shotpay-server-sdk @1shotapi/1shotpay-common
```

Import shared types (`UserId`, `DecimalAmount`, `PayLinkId`, `AjaxError`, `URLString`, `UnixTimestamp`, etc.) from `@1shotapi/1shotpay-common`.

### Quick Start

```ts
import { DecimalAmount, UserId } from "@1shotapi/1shotpay-common";
import { OneShotPayServer } from "@1shotapi/1shotpay-server-sdk";

const server = new OneShotPayServer(
  UserId(process.env.ONESHOT_USER_ID ?? ""),
  process.env.ONESHOT_API_TOKEN ?? "",
);

// 1) Create a pay link
server
  .createPayLink(DecimalAmount(0.01), "Example checkout")
  .andThen((payLink) => {
    // 2) Present payLink.url to the user (new tab, redirect, QR, etc.)
    console.log("Pay link:", payLink.url);
    // 3) Wait for payment (often in a background job)
    return server.waitForPayLinkPayment(payLink.id);
  })
  .match(
    (paidPayLink) => console.log("Paid!", paidPayLink),
    (err) => console.error("Payment failed:", err),
  );
```

### Integration Flow

1. **Create a pay link** with `createPayLink(amount, description, options?)`. Returns an `IPayLink` with a hosted checkout `url`.
2. **Present the link** to the user (new tab, redirect, QR code, etc.).
3. **Wait for completion** with `waitForPayLinkPayment(payLinkId)`. In production, run this in a **background job or worker** so your HTTP route can return the URL immediately while you poll for payment completion.

### Construction

```ts
import { ELocale, UserId } from "@1shotapi/1shotpay-common";
import { OneShotPayServer } from "@1shotapi/1shotpay-server-sdk";

const server = new OneShotPayServer(
  UserId(process.env.ONESHOT_USER_ID ?? ""),
  process.env.ONESHOT_API_TOKEN ?? "",
  ELocale.English, // optional; default
);
```

- **userId**: Your 1ShotPay user id (from Advanced Settings).
- **apiToken**: Your 1ShotPay API token / client secret (from Advanced Settings).
- **locale** (optional): Used for the hosted pay link URL; defaults to `ELocale.English`.

### createPayLink(amount, description, options?)

Creates a pay link and returns `IPayLink` (includes `.url` for the hosted checkout).

```ts
import {
  DecimalAmount,
  UnixTimestamp,
  URLString,
  UserId,
} from "@1shotapi/1shotpay-common";

server
  .createPayLink(DecimalAmount(0.03), "3Use Widget", {
    mediaUrl: URLString("https://example.com/widget.png"),
    reuseable: false,
    expirationTimestamp: UnixTimestamp(Math.floor(Date.now() / 1000) + 60 * 15),
    requestedPayerUserId: UserId("..."),
    closeOnComplete: true, // append ?closeOnComplete=true (e.g. for embedded flows),
  })
  .match(
    (payLink) => {
      console.log("Pay link id:", payLink.id);
      console.log("Hosted URL:", payLink.url);
    },
    (err) => console.error("createPayLink failed:", err),
  );
```

### getPayLink(payLinkId)

Fetches the current state of a pay link.

```ts
import { PayLinkId } from "@1shotapi/1shotpay-common";

server.getPayLink(PayLinkId("...")).match(
  (payLink) => console.log("Status:", payLink.status, "URL:", payLink.url),
  (err) => console.error("getPayLink failed:", err),
);
```

### waitForPayLinkPayment(payLinkId)

Polls until the pay link is paid, then returns the paid `IPayLink`. Use in a worker/background job so the request thread can return the URL to the client immediately.

```ts
server.waitForPayLinkPayment(payLinkId).match(
  (paidPayLink) => console.log("Paid:", paidPayLink),
  (err) => console.error("waitForPayLinkPayment failed:", err),
);
```

### Server-Side Conventions

- **neverthrow** — Methods return `ResultAsync<T, AjaxError>`. Use `.map()`, `.andThen()`, and `.match(okFn, errFn)` for explicit error handling.
- **Branded types** — Use `UserId`, `DecimalAmount`, `PayLinkId`, `URLString`, etc. from `@1shotapi/1shotpay-common` so IDs and amounts are type-safe.
- **async/await** — Use `resultAsyncToPromise()` from `@1shotapi/1shotpay-common` to convert `ResultAsync` to `Promise` and throw on error if you prefer async/await over chaining.

### Config

| Variable               | Description                                  |
|------------------------|----------------------------------------------|
| `ONESHOT_USER_ID`      | 1ShotPay user id (Advanced Settings)         |
| `ONESHOT_API_TOKEN`    | 1ShotPay API token (Advanced Settings)       |

---

## Security Notes

- **Client** — Never expose server credentials (UserId, API Token) in client bundles. The client SDK talks to the iframe wallet; secrets stay on the server.
- **Server** — Store UserId and API Token in environment variables or a secrets manager; validate callback and redirect URLs against an allowlist when configuring pay links.
- **Signatures** — Treat payment signatures and delegations as sensitive and short-lived.

---

## 1ShotPay MCP Tools

Use the 1ShotPay MCP server `https://1shotpay.com/mcp` in agentic settings. It provides two primary tools.

- **Agent wallets** — A tool for creating x402-compatible payment headers to spend from the user's 1ShotPay balance.
- **Generate pay links** — A tool for generating human and agent payable pay links fromthe user's 1ShotPay account.
