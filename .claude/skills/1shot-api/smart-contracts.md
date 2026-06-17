# Smart Contracts

Use this guide when the user asks for Smart Contract interactions with the 1Shot Node SDK.

## Topics Covered

- search smart contracts library
- assure methods associated with a smart contract in the smart contract library
- imported function management
- read function execution
- write simulation
- imported event management
- event querying with indexed arguments

## MCP Tool

When building an agent or product that will interact with specific smart contract functions and events, use the 1Shot API MCP server to manage smart contract functions directly in the developers account. 

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

Assume you have:

- `businessId`: your 1Shot business UUID
- `walletId`: server wallet UUID to associate with imported methods when needed
- `chainId`: target chain (for example, `8453` for Base mainnet)

## 1) Search Smart Contracts from Prompt Library

Search the smart contract library for application appropriate contracts using natural language or known identifiers. The methods on a smart contract must be imported to the developer's business before they can be called by the sdk.

```ts
const prompts = await client.contractMethods.search("USDC on Base", {
  chainId: 8453,
});
// prompts[].promptId, prompts[].name, etc.
```

## 2) Assure Methods Associated With an Existing Smart Contract Prompt

Ensure methods are imported/available for a contract and business so they can be called by the sdk.

```ts
const methods = await client.contractMethods.assureContractMethodsFromPrompt(
  businessId,
  {
    chainId: 8453,
    contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    walletId, // default wallet to link to methods, wallet must be for same network id
    promptId: "prompt_uuid", // chosen prompt id from search
  }
);
```

### Create a New Contract Method (Without Prompt Library)

Define a contract method from scratch by supplying the ABI-style details:

```ts
// Create a new contract method
const newMethod = await client.contractMethods.create("your_business_id", {
  chainId: 1,
  contractAddress: "0x...",
  walletId: "your_wallet_id", // wallet to be linked to method
  name: "Transfer Tokens", // human-readable name of the function call
  description: "Transfers ERC20 tokens to a recipient",
  functionName: "transfer", // this name must be the exact abi function name
  stateMutability: "nonpayable", // important for differentiating from readable, writeable and payable functions
  inputs: [ // the input names do not need to match the abi, but the type and index must match exactly, the input names are used to pass input arguments when reading or writing to this function. names should be human meaningful for usability
    { name: "recipient", type: "address", index: 0 },
    { name: "amount", type: "uint256", index: 1 },
  ],
  outputs: [],
});
```

## 3) Functions

### List Imported Functions

```ts
const { response, page, pageSize, totalResults } =
  await client.contractMethods.list(businessId, {
    chainId: 8453, // filter on the network id
    contractAddress: "0x...", // filter on specific contract addresses
    page: 1, // pagination
    pageSize: 20, // page size
    status: "live", // filter on archived methods, "live" is default
  });
```

### Update Imported Function Details

All parameters are optional; only include the fields you want to change.

```ts
const updated = await client.contractMethods.update("your_contract_method_id", {
  chainId: 8453,           // network id for the method
  contractAddress: "0x...", // contract address
  walletId: "another_wallet_id", // default wallet to use when executing this method
  name: "Transfer USDC",
  description: "Sends USDC to a recipient",
  functionName: "transfer", // ABI function name, only edit if the abi is wrong and needs to be corrected
  stateMutability: "nonpayable", // ContractMethodStateMutability: "view" | "pure" | "nonpayable" | "payable", only edit if the abi is incorrect and needs to be changed
  callbackUrl: "https://your-app.com/callback", // for receiving real-time webhook callbacks on transaction status. NOTE: this will configure both the webhook endpoint and associated event triggers
});
```

### Read From Read Functions

For smart contract view functions:

```ts
const balance = await client.contractMethods.read(
  "your_contract_method_id", // e.g. balanceOf
  { // input arguments that match the names returned by the list call
    owner: "0x1234567890123456789012345678901234567890",
  }
);
```

### Simulate Write Functions

Test if a write method transaction is likely to succeed before execution (useful for write functions that require signature inputs, the result can contain event logs that help explain why a transaction would fail):

```ts
const result = await client.contractMethods.test(
  "your_contract_method_id",
  { amount: "1000000", recipient: "0x..." },
  { value: "0" }
);
// result.success, result.data, etc.
```

### Estimate Gas

Get an estimate for the amount of gas used for a transaction before execution. This is important for write functions that may consume a large fraction of a blocks gas limit.

```ts
// Estimate gas for an execution
const estimate = await client.contractMethods.estimate(
  "your_contract_method_id",
  { amount: "1000000", recipient: "0x..." }
);
```

## 4) Events

### Create a Contract Event

Define a contract event to monitor by supplying the chain, contract, and event name from the ABI. 1Shot API will only let you create events for verified smart contracts.

```ts
const newEvent = await client.contractEvents.create(businessId, {
  chainId: 8453,
  contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  name: "USDC Transfers",
  description: "Search for transfer events between specific addresses",
  eventName: "Transfer", // exact name as in the contract ABI event name without input arguments
});
```

### List Imported Events

```ts
const { response, page, pageSize, totalResults } =
  await client.contractEvents.list(businessId, {
    chainId: 8453,
    contractAddress: "0x...",
    page: 1,
    pageSize: 20,
  });
```

### Update Imported Event Details

```ts
const updated = await client.contractEvents.update("your_contract_event_id", {
  name: "Transfer", // exact name of the event in the contract abi
  description: "ERC20 Transfer(indexed from, indexed to, value)",
});
```

### Query Events With Indexed Arguments

`startBlock` and `endBlock` are optional but recommended. If there are too many events returned by a query, the call will fail. 

```ts
const { logs } = await client.contractEvents.searchLogs(
  "your_contract_event_id",
  {
    startBlock: "120000", // optional : Oldest block to search
    endBlock: "130000",   // optional: newest block to search
    topics: { // indexed arguments that can be used to filter results (obtained from event list)
      from: "0x1234567890123456789012345678901234567890",
      to: "0xabcdef0123456789abcdef0123456789abcdef01",
    },
  }
);
// logs[].eventName, logs[].blockNumber, logs[].topics, etc.
```

## Validation And Safety Checks

- Validate `chainId` and `contractAddress` before assure/list/read/test/log queries.
- Keep wallet-to-method assignment explicit when updating method metadata.
- Use read/test methods before execute flows to reduce runtime failures.
- For log queries, constrain `startBlock` and `endBlock` to avoid oversized scans.
