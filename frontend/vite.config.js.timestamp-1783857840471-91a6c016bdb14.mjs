var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// api/_guard.js
function allowedOrigins() {
  const fromEnv = process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",").map((o) => o.trim()) : [];
  return [...isProd ? [] : DEV_ORIGINS, ...fromEnv].filter(Boolean);
}
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (!allowedOrigins().includes(origin)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
}
function clientIp(req) {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const xff = req.headers["x-forwarded-for"];
  if (TRUST_PROXY_HOPS > 0 && typeof xff === "string" && xff.trim()) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) {
      const idx = parts.length - TRUST_PROXY_HOPS;
      return parts[idx >= 0 ? idx : 0];
    }
  }
  return req.socket?.remoteAddress || "unknown";
}
function prune(now) {
  for (const [k, v] of _buckets) {
    if (now >= v.resetAt) _buckets.delete(k);
  }
}
function rateLimit(req, res, { max = 30, windowMs = 6e4, bucket = "default" } = {}) {
  const now = Date.now();
  if (_buckets.size > MAX_BUCKETS) prune(now);
  const key = `${bucket}:${clientIp(req)}`;
  const entry = _buckets.get(key);
  if (!entry || now >= entry.resetAt) {
    _buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) {
    const retry = Math.ceil((entry.resetAt - now) / 1e3);
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Retry-After", String(retry));
    res.end(JSON.stringify({ error: "Too many requests" }));
    return false;
  }
  entry.count += 1;
  return true;
}
var isProd, DEV_ORIGINS, _buckets, MAX_BUCKETS, TRUST_PROXY_HOPS;
var init_guard = __esm({
  "api/_guard.js"() {
    isProd = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
    DEV_ORIGINS = [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://localhost:4173"
    ];
    _buckets = /* @__PURE__ */ new Map();
    MAX_BUCKETS = 5e3;
    TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  }
});

// api/stellar-relay.js
var stellar_relay_exports = {};
__export(stellar_relay_exports, {
  RelayError: () => RelayError,
  _clearSeen: () => _clearSeen,
  assertVaultDeposit: () => assertVaultDeposit,
  default: () => handler3,
  feeBumpAndSubmit: () => feeBumpAndSubmit
});
function _clearSeen() {
  _seen.clear();
}
function pruneSeen(now) {
  for (const [k, v] of _seen) if (now - v.at > SEEN_TTL_MS) _seen.delete(k);
}
function parseAllowlist(raw) {
  return (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
}
function assertVaultDeposit(inner, vaultAddr, sdk, tokenAddr = "", agentAllowlist = "", accountWasmHash = "", routerAddr = "") {
  if (!vaultAddr) return;
  const ops = inner.operations || [];
  if (ops.length !== 1 || ops[0].type !== "invokeHostFunction") {
    throw new RelayError("relay sponsors a single contract invocation only");
  }
  const hf = ops[0].func;
  const kind = hf.switch().name;
  if (kind === "hostFunctionTypeCreateContractV2") {
    const exec = hf.createContractV2().executable();
    const isPinnedWasm = accountWasmHash && exec.switch().name === "contractExecutableWasm" && exec.wasmHash().toString("hex") === accountWasmHash;
    if (!isPinnedWasm) {
      throw new RelayError("relay sponsors smart-account deploys of the pinned wasm only");
    }
    return;
  }
  if (kind !== "hostFunctionTypeInvokeContract") {
    throw new RelayError("inner op is not a contract invocation");
  }
  const ic = hf.invokeContract();
  const contract = sdk.Address.fromScAddress(ic.contractAddress()).toString();
  const fnName = ic.functionName().toString();
  if (contract === vaultAddr) {
    if (fnName !== "deposit" && fnName !== "redeem") {
      throw new RelayError("inner tx is not a vault deposit/redeem");
    }
    return;
  }
  if (routerAddr && contract === routerAddr) {
    if (fnName !== "grant" && fnName !== "pull") {
      throw new RelayError("inner tx is not a router grant/pull");
    }
    return;
  }
  if (tokenAddr && contract === tokenAddr && fnName === "transfer") {
    const from = sdk.Address.fromScVal(ic.args()[0]).toString();
    if (!parseAllowlist(agentAllowlist).includes(from)) {
      throw new RelayError("relay sponsors allowlisted agent-account transfers only");
    }
    return;
  }
  throw new RelayError("inner tx does not target the vault");
}
async function pollResult(rpcServer, hash, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    const r = await rpcServer.getTransaction(hash);
    if (r.status && r.status !== "NOT_FOUND") return r;
    if (intervalMs) await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { status: "PENDING" };
}
async function feeBumpAndSubmit({
  xdr,
  secret,
  passphrase,
  vaultAddr,
  tokenAddr = "",
  agentAllowlist = "",
  accountWasmHash = "",
  routerAddr = "",
  sdk,
  rpcServer,
  pollTries = 10,
  pollIntervalMs = 2e3
}) {
  const { TransactionBuilder, FeeBumpTransaction, Keypair: Keypair2 } = sdk;
  const inner = TransactionBuilder.fromXDR(xdr, passphrase);
  if (inner instanceof FeeBumpTransaction) {
    throw new RelayError("inner tx is already fee-bumped");
  }
  assertVaultDeposit(inner, vaultAddr, sdk, tokenAddr, agentAllowlist, accountWasmHash, routerAddr);
  const innerHash = inner.hash().toString("hex");
  const now = Date.now();
  if (_seen.size > SEEN_MAX) pruneSeen(now);
  const prev = _seen.get(innerHash);
  if (prev) {
    if (prev.state === "done") return { ...prev.out, status: "duplicate" };
    throw new RelayError("inner tx already in flight");
  }
  _seen.set(innerHash, { state: "in-flight", at: now });
  try {
    const kp = Keypair2.fromSecret(secret);
    if (inner.source === kp.publicKey()) inner.sign(kp);
    const baseFee = (BigInt(inner.fee) + FEE_MARGIN).toString();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(kp, baseFee, inner, passphrase);
    feeBump.sign(kp);
    const send2 = await rpcServer.sendTransaction(feeBump);
    if (send2.status === "ERROR") {
      throw new RelayError("RPC rejected the fee-bump submission");
    }
    const result = await pollResult(rpcServer, send2.hash, pollTries, pollIntervalMs);
    const out = { hash: send2.hash, status: result.status, relayer: kp.publicKey() };
    _seen.set(innerHash, { state: "done", out, at: Date.now() });
    return out;
  } catch (e) {
    _seen.delete(innerHash);
    throw e;
  }
}
async function readBody3(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
function bad(res, msg) {
  res.statusCode = 400;
  return res.end(JSON.stringify({ error: msg }));
}
async function handler3(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }
  if (!applyCors(req, res)) return;
  if (!rateLimit(req, res, { max: 15, windowMs: 6e4, bucket: "stellar-relay" })) return;
  res.setHeader("Content-Type", "application/json");
  const secret = RELAYER_SECRET();
  if (!secret) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: "Stellar relay not configured", configured: false }));
  }
  try {
    const body = await readBody3(req);
    const mod = await import("file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js");
    const sdk = {
      TransactionBuilder: mod.TransactionBuilder,
      FeeBumpTransaction: mod.FeeBumpTransaction,
      Keypair: mod.Keypair,
      Address: mod.Address
    };
    if (body.action === "wallet") {
      return res.end(JSON.stringify({ address: mod.Keypair.fromSecret(secret).publicKey() }));
    }
    if (body.action === "submit" || !body.action && typeof body.xdr === "string") {
      if (typeof body.xdr !== "string" || !body.xdr) return bad(res, "Invalid xdr");
      const rpcServer = new mod.rpc.Server(RPC_URL());
      try {
        const out = await feeBumpAndSubmit({
          xdr: body.xdr,
          secret,
          passphrase: PASSPHRASE(),
          vaultAddr: VAULT_ADDR(),
          tokenAddr: TOKEN_ADDR(),
          agentAllowlist: AGENT_ALLOWLIST(),
          accountWasmHash: ACCOUNT_WASM_HASH(),
          routerAddr: ROUTER_ADDR(),
          sdk,
          rpcServer
        });
        return res.end(JSON.stringify(out));
      } catch (e) {
        if (e instanceof RelayError && /in flight/.test(e.message)) {
          res.statusCode = 409;
          return res.end(JSON.stringify({ error: e.message }));
        }
        throw e;
      }
    }
    return bad(res, "Unknown action");
  } catch (err) {
    console.error("[api/stellar-relay] error:", err?.message || err);
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: "Stellar relay failed" }));
  }
}
var PASSPHRASE, RPC_URL, RELAYER_SECRET, VAULT_ADDR, TOKEN_ADDR, ROUTER_ADDR, AGENT_ALLOWLIST, ACCOUNT_WASM_HASH, FEE_MARGIN, RelayError, _seen, SEEN_MAX, SEEN_TTL_MS;
var init_stellar_relay = __esm({
  "api/stellar-relay.js"() {
    init_guard();
    PASSPHRASE = () => process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
    RPC_URL = () => process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
    RELAYER_SECRET = () => process.env.STELLAR_RELAYER_SECRET || "";
    VAULT_ADDR = () => process.env.SOROBAN_VAULT_ADDRESS || "";
    TOKEN_ADDR = () => process.env.SOROBAN_TOKEN_ADDRESS || "";
    ROUTER_ADDR = () => process.env.SOROBAN_ROUTER_ADDRESS || "";
    AGENT_ALLOWLIST = () => process.env.SOROBAN_AGENT_ALLOWLIST || "";
    ACCOUNT_WASM_HASH = () => process.env.SOROBAN_ACCOUNT_WASM_HASH || "a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e";
    FEE_MARGIN = 1000000n;
    RelayError = class extends Error {
    };
    _seen = /* @__PURE__ */ new Map();
    SEEN_MAX = 5e3;
    SEEN_TTL_MS = 30 * 6e4;
  }
});

// vite.config.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/vite/dist/node/index.js";
import react from "file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@vitejs/plugin-react/dist/index.js";

// api/ai.js
init_guard();
var DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
var ALLOWED_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash"
];
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }
  if (!applyCors(req, res)) return;
  if (!rateLimit(req, res, { max: 30, windowMs: 6e4, bucket: "ai" })) return;
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: "AI proxy not configured" }));
  }
  try {
    const { model, messages, response_format } = await readBody(req);
    if (!ALLOWED_MODELS.includes(model)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Model not allowed" }));
    }
    if (!Array.isArray(messages) || messages.length > 10) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Invalid messages" }));
    }
    for (const msg of messages) {
      if (typeof msg.content === "string" && msg.content.length > 1e5) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "Message too long" }));
      }
    }
    const upstream = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, response_format })
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", "application/json");
    res.end(text);
  } catch {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "AI proxy failed" }));
  }
}

// api/search.js
init_guard();
var TAVILY_URL = "https://api.tavily.com/search";
async function readBody2(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
async function handler2(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }
  if (!applyCors(req, res)) return;
  if (!rateLimit(req, res, { max: 30, windowMs: 6e4, bucket: "search" })) return;
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: "Search proxy not configured" }));
  }
  try {
    const { query, search_depth, max_results, include_answer } = await readBody2(req);
    if (typeof query !== "string" || query.length === 0 || query.length > 500) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Invalid query" }));
    }
    const upstream = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        search_depth: search_depth === "advanced" ? "advanced" : "basic",
        max_results: Math.min(Number(max_results) || 3, 5),
        include_answer: include_answer !== false,
        include_raw_content: false
      })
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", "application/json");
    res.end(text);
  } catch {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "Search proxy failed" }));
  }
}

// vite.config.js
init_stellar_relay();

// api/faucet.js
init_guard();
var PASSPHRASE2 = () => process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
var RPC_URL2 = () => process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
var FAUCET_SECRET = () => process.env.VF_FAUCET_SECRET || "";
var TOKEN_ADDR2 = () => process.env.SOROBAN_TOKEN_ADDRESS || "";
var CAP_BASE_UNITS = 100n * 10n ** 7n;
var DEFAULT_BASE_UNITS = 10n * 10n ** 7n;
var PER_RECIPIENT_DAILY_CAP = 300n * 10n ** 7n;
var GLOBAL_DAILY_CAP = 5000n * 10n ** 7n;
var DAY_MS = 24 * 60 * 60 * 1e3;
var _spent = /* @__PURE__ */ new Map();
var _globalTotal = 0n;
var _globalWindowStart = 0;
function effectiveAmount(amount) {
  return amount && BigInt(amount) > 0n ? BigInt(amount) > CAP_BASE_UNITS ? CAP_BASE_UNITS : BigInt(amount) : DEFAULT_BASE_UNITS;
}
function reserveDaily(to, amount, now = Date.now()) {
  if (now - _globalWindowStart > DAY_MS) {
    _globalWindowStart = now;
    _globalTotal = 0n;
  }
  const rec = _spent.get(to);
  const valid = rec && now - rec.windowStart <= DAY_MS;
  const prior = valid ? rec.total : 0n;
  if (prior + amount > PER_RECIPIENT_DAILY_CAP) return false;
  if (_globalTotal + amount > GLOBAL_DAILY_CAP) return false;
  _spent.set(to, { total: prior + amount, windowStart: valid ? rec.windowStart : now });
  _globalTotal += amount;
  return true;
}
var FaucetError = class extends Error {
};
async function dispenseToken({
  secret,
  token,
  to,
  amount,
  passphrase,
  sdk,
  rpcServer,
  pollTries = 10,
  pollIntervalMs = 1500
}) {
  const { Keypair: Keypair2, TransactionBuilder, Contract, Address, xdr, BASE_FEE, rpc } = sdk;
  const capped = effectiveAmount(amount);
  const kp = Keypair2.fromSecret(secret);
  const source = await rpcServer.getAccount(kp.publicKey());
  const op = new Contract(token).call(
    "transfer",
    Address.fromString(kp.publicKey()).toScVal(),
    Address.fromString(to).toScVal(),
    xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString("0"),
        lo: xdr.Uint64.fromString(capped.toString())
      })
    )
  );
  const raw = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase }).addOperation(op).setTimeout(60).build();
  const sim = await rpcServer.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(sim)) throw new FaucetError(`faucet sim failed: ${sim.error}`);
  const prepared = rpc.assembleTransaction(raw, sim).build();
  prepared.sign(kp);
  const sent = await rpcServer.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new FaucetError("RPC rejected the faucet transfer");
  for (let i = 0; i < pollTries; i++) {
    const r = await rpcServer.getTransaction(sent.hash);
    if (r.status && r.status !== "NOT_FOUND") return { hash: sent.hash, status: r.status };
    if (pollIntervalMs) await new Promise((res) => setTimeout(res, pollIntervalMs));
  }
  return { hash: sent.hash, status: "PENDING" };
}
async function readBody4(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
function bad2(res, msg) {
  res.statusCode = 400;
  return res.end(JSON.stringify({ error: msg }));
}
function tooMany(res, msg) {
  res.statusCode = 429;
  return res.end(JSON.stringify({ error: msg }));
}
async function handler4(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }
  if (!applyCors(req, res)) return;
  if (!rateLimit(req, res, { max: 3, windowMs: 6e4, bucket: "faucet" })) return;
  res.setHeader("Content-Type", "application/json");
  const secret = FAUCET_SECRET();
  if (!secret) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: "Faucet not configured", configured: false }));
  }
  try {
    const body = await readBody4(req);
    if (body.action !== "dispense") return bad2(res, "Unknown action");
    if (typeof body.to !== "string" || !body.to) return bad2(res, "Invalid recipient");
    const token = TOKEN_ADDR2();
    if (!token) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: "Faucet token unset", configured: false }));
    }
    const mod = await import("file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js");
    if (!mod.StrKey.isValidContract(body.to)) return bad2(res, "Invalid recipient");
    if (!reserveDaily(body.to, effectiveAmount(body.amount)))
      return tooMany(res, "Daily faucet cap reached");
    const sdk = {
      Keypair: mod.Keypair,
      TransactionBuilder: mod.TransactionBuilder,
      Contract: mod.Contract,
      Address: mod.Address,
      xdr: mod.xdr,
      BASE_FEE: mod.BASE_FEE,
      rpc: mod.rpc
    };
    const rpcServer = new mod.rpc.Server(RPC_URL2());
    const out = await dispenseToken({
      secret,
      token,
      to: body.to,
      amount: body.amount,
      passphrase: PASSPHRASE2(),
      sdk,
      rpcServer
    });
    return res.end(JSON.stringify(out));
  } catch (err) {
    console.error("[api/faucet] error:", err?.message || err);
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: "Faucet failed" }));
  }
}

// api/vf/auth-challenge.js
init_guard();
import { StrKey } from "file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js";

// api/vf/_sep10.js
import { Keypair, WebAuth } from "file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js";
var TIMEOUT_SEC = 300;
async function buildChallenge({ account, signingSecret, homeDomain, networkPassphrase }) {
  const serverKp = Keypair.fromSecret(signingSecret);
  const transaction = WebAuth.buildChallengeTx(
    serverKp,
    account,
    homeDomain,
    TIMEOUT_SEC,
    networkPassphrase,
    homeDomain
    // web_auth_domain
  );
  return { transaction, network_passphrase: networkPassphrase };
}
async function verifyChallenge({ signedXdr, signingSecret, homeDomain, networkPassphrase }) {
  try {
    const serverKp = Keypair.fromSecret(signingSecret);
    const { clientAccountID } = WebAuth.readChallengeTx(
      signedXdr,
      serverKp.publicKey(),
      networkPassphrase,
      homeDomain,
      homeDomain
    );
    WebAuth.verifyChallengeTxSigners(
      signedXdr,
      serverKp.publicKey(),
      networkPassphrase,
      [clientAccountID],
      homeDomain,
      homeDomain
    );
    return { ok: true, account: clientAccountID };
  } catch (err) {
    return { ok: false, error: err?.message || "invalid challenge" };
  }
}

// api/vf/auth-challenge.js
var json = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};
async function handler5(req, res) {
  if (!rateLimit(req, res, { max: 20, windowMs: 6e4, bucket: "vf-auth" })) return;
  const signingSecret = process.env.VF_AUTH_SIGNING_KEY;
  if (!signingSecret)
    return json(res, 503, { configured: false, error: "Portal auth not configured" });
  const account = new URL(req.url, "http://local").searchParams.get("account") || "";
  if (!StrKey.isValidEd25519PublicKey(account)) return json(res, 400, { error: "Invalid account" });
  const out = await buildChallenge({
    account,
    signingSecret,
    homeDomain: process.env.VF_HOME_DOMAIN || "localhost:5173",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
  });
  json(res, 200, out);
}

// api/vf/auth-token.js
init_guard();

// api/vf/_jwt.js
var enc = new TextEncoder();
var b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var b64uJson = (obj) => b64u(enc.encode(JSON.stringify(obj)));
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
async function signJwt(payload, secret, ttlSec) {
  const iat = Math.floor(Date.now() / 1e3);
  const body = { ...payload, iat, exp: iat + ttlSec };
  const head = b64uJson({ alg: "HS256", typ: "JWT" });
  const data = `${head}.${b64uJson(body)}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return `${data}.${b64u(sig)}`;
}
async function verifyJwt(token, secret, nowMs = Date.now()) {
  try {
    const [h, p, s] = String(token).split(".");
    if (!h || !p || !s) return null;
    const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
    const sig = Uint8Array.from(
      atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad),
      (c) => c.charCodeAt(0)
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      sig,
      enc.encode(`${h}.${p}`)
    );
    if (!ok) return null;
    const payload = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.exp !== "number" || nowMs / 1e3 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// api/vf/auth-token.js
var json2 = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};
async function handler6(req, res) {
  if (!rateLimit(req, res, { max: 20, windowMs: 6e4, bucket: "vf-auth" })) return;
  const signingSecret = process.env.VF_AUTH_SIGNING_KEY;
  const jwtSecret = process.env.VF_JWT_SECRET;
  if (!signingSecret || !jwtSecret)
    return json2(res, 503, { configured: false, error: "Portal auth not configured" });
  const signedXdr = req.body?.transaction;
  if (typeof signedXdr !== "string" || !signedXdr)
    return json2(res, 400, { error: "Missing transaction" });
  const v = await verifyChallenge({
    signedXdr,
    signingSecret,
    homeDomain: process.env.VF_HOME_DOMAIN || "localhost:5173",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
  });
  if (!v.ok) return json2(res, 401, { error: "Challenge verification failed" });
  json2(res, 200, { token: await signJwt({ sub: v.account }, jwtSecret, 3600) });
}

// api/vf/keys.js
import { z } from "file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/zod/index.js";

// api/vf/_db.js
function memoryStore() {
  const rows = /* @__PURE__ */ new Map();
  const counters = /* @__PURE__ */ new Map();
  const usage = /* @__PURE__ */ new Map();
  const pub = ({ key_hash: _omit, ...rest }) => rest;
  return {
    _usage: usage,
    keys: {
      async insert(row) {
        rows.set(row.id, { ...row });
      },
      async getByHash(hash) {
        for (const r of rows.values()) if (r.key_hash === hash) return { ...r };
        return null;
      },
      async list(owner) {
        return [...rows.values()].filter((r) => r.owner === owner).map(pub);
      },
      async revoke(id, owner) {
        const r = rows.get(id);
        if (!r || r.owner !== owner) return false;
        r.enabled = 0;
        return true;
      },
      async touch(id, ts) {
        const r = rows.get(id);
        if (r) r.last_used_at = ts;
      }
    },
    counters: {
      async bump(keyId, windowStart) {
        const k = `${keyId}|${windowStart}`;
        const n = (counters.get(k) || 0) + 1;
        counters.set(k, n);
        return n;
      },
      async pruneBefore(ts) {
        for (const k of counters.keys()) if (Number(k.split("|")[1]) < ts) counters.delete(k);
      }
    },
    usage: {
      async log(keyId, day, endpoint) {
        const k = `${keyId}|${day}|${endpoint}`;
        usage.set(k, (usage.get(k) || 0) + 1);
      }
    }
  };
}
function d1Store(db) {
  return {
    keys: {
      async insert(r) {
        await db.prepare(
          `INSERT INTO api_keys (id, key_hash, key_hint, owner, scopes, rate_limit, expires_at, enabled, created_at, last_used_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          r.id,
          r.key_hash,
          r.key_hint,
          r.owner,
          r.scopes,
          r.rate_limit,
          r.expires_at,
          r.enabled,
          r.created_at,
          r.last_used_at
        ).run();
      },
      async getByHash(hash) {
        return await db.prepare(`SELECT * FROM api_keys WHERE key_hash = ?`).bind(hash).first() ?? null;
      },
      async list(owner) {
        const { results } = await db.prepare(
          `SELECT id, key_hint, owner, scopes, rate_limit, expires_at, enabled, created_at, last_used_at
             FROM api_keys WHERE owner = ? ORDER BY created_at DESC`
        ).bind(owner).all();
        return results ?? [];
      },
      async revoke(id, owner) {
        const r = await db.prepare(`UPDATE api_keys SET enabled = 0 WHERE id = ? AND owner = ?`).bind(id, owner).run();
        return (r.meta?.changes ?? 0) > 0;
      },
      async touch(id, ts) {
        await db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(ts, id).run();
      }
    },
    counters: {
      async bump(keyId, windowStart) {
        const row = await db.prepare(
          `INSERT INTO usage_counters (key_id, window_start, count) VALUES (?,?,1)
             ON CONFLICT(key_id, window_start) DO UPDATE SET count = count + 1
             RETURNING count`
        ).bind(keyId, windowStart).first();
        return row?.count ?? 1;
      },
      async pruneBefore(ts) {
        await db.prepare(`DELETE FROM usage_counters WHERE window_start < ?`).bind(ts).run();
      }
    },
    usage: {
      async log(keyId, day, endpoint) {
        await db.prepare(
          `INSERT INTO usage_log (key_id, day, endpoint, count) VALUES (?,?,?,1)
             ON CONFLICT(key_id, day, endpoint) DO UPDATE SET count = count + 1`
        ).bind(keyId, day, endpoint).run();
      }
    }
  };
}
var _devStore = null;
function storeFrom(req) {
  const db = req?.env?.VF_DB;
  if (db) return d1Store(db);
  if (!_devStore) _devStore = memoryStore();
  return _devStore;
}

// api/vf/_keystore.js
var SCOPES = ["strategy", "market", "tx", "submit", "scan"];
var B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(bytes, width) {
  let num = 0n;
  for (const b of bytes) num = num << 8n | BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B62[Number(num % 62n)] + out;
    num /= 62n;
  }
  return width ? out.padStart(width, "0") : out || "0";
}
function generateKey(env) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `vf_${env}_${base62(bytes, 43)}`;
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function issueKey(store, { owner, scopes, rateLimit: rateLimit2, env, expiresAt }) {
  const key = generateKey(env);
  const idBytes = new Uint8Array(8);
  crypto.getRandomValues(idBytes);
  const id = `vfk_${base62(idBytes)}`;
  const hint = key.slice(0, 12) + "\u2026";
  await store.keys.insert({
    id,
    key_hash: await sha256Hex(key),
    key_hint: hint,
    owner,
    scopes: JSON.stringify(scopes),
    rate_limit: rateLimit2,
    expires_at: expiresAt ?? null,
    enabled: 1,
    created_at: Math.floor(Date.now() / 1e3),
    last_used_at: null
  });
  return { id, key, hint };
}
async function verifyKey(store, plaintext, nowMs = Date.now()) {
  if (typeof plaintext !== "string" || !/^vf_(test|live)_[0-9A-Za-z]{32,}$/.test(plaintext)) {
    return { ok: false, reason: "malformed" };
  }
  const row = await store.keys.getByHash(await sha256Hex(plaintext));
  if (!row) return { ok: false, reason: "unknown" };
  if (!row.enabled) return { ok: false, reason: "revoked" };
  if (row.expires_at && nowMs / 1e3 > row.expires_at) return { ok: false, reason: "expired" };
  return { ok: true, keyId: row.id, scopes: JSON.parse(row.scopes), rateLimit: row.rate_limit };
}
async function revokeKey(store, id, owner) {
  return store.keys.revoke(id, owner);
}

// api/vf/_vfauth.js
var WINDOW_MS = 6e4;
var send = (res, status, obj, headers = {}) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
  return null;
};
var bearer = (req) => {
  const h = req.headers?.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
};
async function requireVfKey(req, res, store, { scope, endpoint = scope, nowMs = Date.now() }) {
  const token = bearer(req);
  if (!token) return send(res, 401, { error: "Missing API key" });
  const v = await verifyKey(store, token, nowMs);
  if (!v.ok) return send(res, 401, { error: "Invalid API key" });
  if (!v.scopes.includes(scope)) return send(res, 403, { error: "Out of scope" });
  const windowStart = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const count = await store.counters.bump(v.keyId, windowStart);
  if (count > v.rateLimit) {
    const retry = Math.ceil((windowStart + WINDOW_MS - nowMs) / 1e3);
    return send(res, 429, { error: "Too many requests" }, { "Retry-After": String(retry) });
  }
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const dayStart = Date.parse(day);
  const cap = Number(process.env.VF_GLOBAL_DAILY_CAP || 5e3);
  const globalCount = await store.counters.bump(`__global:${scope}`, dayStart);
  if (globalCount > cap) return send(res, 503, { error: "Daily budget exhausted" });
  await store.usage.log(v.keyId, day, endpoint);
  await store.keys.touch(v.keyId, Math.floor(nowMs / 1e3));
  await store.counters.pruneBefore(
    windowStart - 2 * WINDOW_MS > dayStart ? dayStart : windowStart - 2 * WINDOW_MS
  );
  return { keyId: v.keyId, scopes: v.scopes };
}
async function requireJwt(req, res) {
  const secret = process.env.VF_JWT_SECRET;
  if (!secret) return send(res, 503, { configured: false, error: "Portal auth not configured" });
  const payload = await verifyJwt(bearer(req), secret);
  if (!payload?.sub) return send(res, 401, { error: "Invalid session" });
  return payload;
}

// api/vf/keys.js
var json3 = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};
var IssueSchema = z.object({
  scopes: z.array(z.enum(SCOPES)).nonempty(),
  env: z.enum(["test", "live"]),
  rateLimit: z.number().int().min(1).max(600).default(60),
  expiresAt: z.number().int().positive().nullable().default(null)
});
async function listKeys(req, res) {
  const session = await requireJwt(req, res);
  if (!session) return;
  json3(res, 200, { keys: await storeFrom(req).keys.list(session.sub) });
}
async function createKey(req, res) {
  const session = await requireJwt(req, res);
  if (!session) return;
  const parsed = IssueSchema.safeParse(req.body ?? {});
  if (!parsed.success) return json3(res, 400, { error: "Invalid key request" });
  const { scopes, env, rateLimit: rateLimit2, expiresAt } = parsed.data;
  const out = await issueKey(storeFrom(req), {
    owner: session.sub,
    scopes,
    rateLimit: rateLimit2,
    env,
    expiresAt
  });
  json3(res, 200, out);
}
async function deleteKey(req, res) {
  const session = await requireJwt(req, res);
  if (!session) return;
  const id = req.body?.id;
  if (typeof id !== "string" || !id) return json3(res, 400, { error: "Missing id" });
  const ok = await revokeKey(storeFrom(req), id, session.sub);
  if (!ok) return json3(res, 404, { error: "Key not found" });
  json3(res, 200, { revoked: true });
}

// src/strategy/vaultFactsSnapshot.js
var CAPTURED_AT = Date.parse("2026-06-28T00:00:00Z");
var f = (value) => ({ value, source: "snapshot", asOf: CAPTURED_AT });
var audited = (over) => ({
  annualizedDistributed: f(1e6),
  protocolRevenue: f(105e4),
  audit: f("audited"),
  ageDays: f(365),
  tvl: f(25e6),
  adminKey: f("timelock_multisig"),
  // Lifeboat F8 facts — PLACEHOLDER snapshot values (same provenance discipline as above);
  // verify via refreshVaultFacts.mjs before the demo.
  oracleType: f("circuit_breaker"),
  collateralLiquidityDepthUsd: f(1e6),
  poolClass: f("curated"),
  supplierConcentrationPct: f(25),
  ...over
});
var SNAPSHOT = {
  // The product's own vetted vault (single-chain Stellar/Soroban Blend USDC). Same
  // PLACEHOLDER-provenance discipline as the rest — refresh before demo.
  "blend-usdc": { facts: audited(), meta: { label: "Blend USDC (Stellar)" } },
  "aave-v3": { facts: audited(), meta: { label: "Aave v3 (mainnet)" } },
  "morpho-blue": {
    facts: audited({ tvl: f(12e6), adminKey: f("multisig") }),
    meta: { label: "Morpho Blue (mainnet)" }
  },
  "pendle-v2": {
    facts: audited({ ageDays: f(540), tvl: f(8e6) }),
    meta: { label: "Pendle (mainnet)" }
  },
  fluid: {
    facts: audited({ tvl: f(5e6), adminKey: f("multisig") }),
    meta: { label: "Fluid (mainnet)" }
  },
  // Controlled demo fixture — illustrates rejection. NOT a real vault.
  hyperfarm: {
    facts: {
      annualizedDistributed: f(1e7),
      protocolRevenue: f(3e6),
      audit: f("none"),
      ageDays: f(4),
      tvl: f(5e4),
      adminKey: f("eoa"),
      oracleType: f("vwap_no_breaker"),
      collateralLiquidityDepthUsd: f(4e4),
      poolClass: f("community"),
      supplierConcentrationPct: f(80)
    },
    meta: { isFixture: true, label: "demo fixture \u2014 illustrates rejection" }
  }
};

// src/strategy/vaultFactsLive.js
var TTL_MS = 6 * 60 * 60 * 1e3;
var overlays = null;
function getLiveOverlay(protocol) {
  return overlays?.[protocol] ?? null;
}

// src/strategy/vaultFacts.js
function resolve(protocol) {
  const entry = SNAPSHOT[protocol];
  if (!entry) throw new Error(`no eligibility facts for protocol: ${protocol}`);
  const live = getLiveOverlay(protocol);
  const merged = live ? applyRefresh(entry, live.refreshed, live.asOf) : entry;
  return { protocol, isFixture: !!entry.meta?.isFixture, facts: merged.facts };
}
function applyRefresh(entry, refreshed, nowMs) {
  const facts = { ...entry.facts };
  for (const [k, value] of Object.entries(refreshed)) {
    if (value === void 0 || value === null) continue;
    facts[k] = { value, source: "live", asOf: nowMs };
  }
  return { ...entry, facts };
}

// api/vf/vault-facts.js
async function handler7(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: "market" });
  if (!ctx) return;
  const protocol = new URL(req.url, "http://local").searchParams.get("protocol") || "blend-usdc";
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(resolve(protocol)));
}

// src/strategy/eligibilityGate.js
var PONZI_RATIO_MAX = 1.5;
var SECURITY_MIN = 60;
var AGE_CAP_DAYS = 180;
var TVL_FLOOR = 1e5;
var TVL_CAP = 1e8;
var AGE_WEIGHT = 0.3;
var TVL_WEIGHT = 0.4;
var ADMIN_WEIGHT = 0.3;
var ADMIN_LEVELS = { timelock_multisig: 1, multisig: 0.7, timelock: 0.5, eoa: 0 };
var MAX_FACT_AGE_MS = 30 * 864e5;
var MAX_TOKEN_AGE_MS = 15 * 6e4;
var MIN_COLLATERAL_LIQUIDITY_USD = 25e4;
var MAX_SUPPLIER_CONCENTRATION_PCT = 40;
var ORACLE_TYPES_OK = ["circuit_breaker"];
var REQUIRED_FACTS = [
  "annualizedDistributed",
  "protocolRevenue",
  "audit",
  "ageDays",
  "tvl",
  "adminKey",
  // Lifeboat F8 extension — maps the YieldBlox post-mortem (oracle misconfiguration on a
  // community pool) onto pre-entry screening. Fail-closed like everything else here.
  "oracleType",
  "collateralLiquidityDepthUsd",
  "poolClass",
  "supplierConcentrationPct"
];
function factPresent(field, nowMs) {
  if (!field || field.value == null) return false;
  if (typeof field.asOf !== "number") return false;
  return nowMs - field.asOf <= MAX_FACT_AGE_MS;
}
function allRequiredFactsPresent(facts, nowMs) {
  return REQUIRED_FACTS.every((k) => factPresent(facts?.[k], nowMs));
}
function pos(field) {
  const v = field?.value;
  return typeof v === "number" && v > 0 ? v : null;
}
function yieldReality(facts) {
  const dist = pos(facts?.annualizedDistributed);
  const rev = pos(facts?.protocolRevenue);
  if (dist == null || rev == null) {
    return { ratio: null, verdict: "unknown", inputs: { dist, rev } };
  }
  const ratio = dist / rev;
  return { ratio, verdict: ratio < PONZI_RATIO_MAX ? "real" : "ponzi", inputs: { dist, rev } };
}
var clamp01 = (x) => Math.max(0, Math.min(1, x));
function securityScore(facts) {
  const auditGate = facts?.audit?.value === "audited" ? "pass" : "fail";
  const ageSig = clamp01((facts?.ageDays?.value ?? 0) / AGE_CAP_DAYS);
  const tvl = facts?.tvl?.value ?? 0;
  const tvlSig = tvl <= 0 ? 0 : clamp01(
    (Math.log10(tvl) - Math.log10(TVL_FLOOR)) / (Math.log10(TVL_CAP) - Math.log10(TVL_FLOOR))
  );
  const adminSig = ADMIN_LEVELS[facts?.adminKey?.value] ?? 0;
  const score = Math.round(
    100 * (AGE_WEIGHT * ageSig + TVL_WEIGHT * tvlSig + ADMIN_WEIGHT * adminSig)
  );
  return { score, auditGate, components: { age: ageSig, tvl: tvlSig, adminKey: adminSig } };
}
function evaluate(input, nowMs = Date.now()) {
  const { protocol, facts, isFixture = false } = input;
  const reasons = [];
  const present = allRequiredFactsPresent(facts, nowMs);
  if (!present) reasons.push("missing or stale required data");
  const yr = yieldReality(facts);
  if (yr.verdict === "ponzi")
    reasons.push(`yield/revenue ratio ${yr.ratio.toFixed(2)} (ponzi >= ${PONZI_RATIO_MAX})`);
  if (yr.verdict === "unknown") reasons.push("yield/revenue unverifiable");
  const sec = securityScore(facts);
  if (sec.auditGate === "fail") reasons.push("unaudited (audit gate)");
  if (sec.score < SECURITY_MIN)
    reasons.push(`security ${sec.score}/100 (our weighting) below ${SECURITY_MIN}`);
  if (facts?.poolClass?.value != null && facts.poolClass.value !== "curated")
    reasons.push("community-managed pool");
  if (facts?.oracleType?.value != null && !ORACLE_TYPES_OK.includes(facts.oracleType.value))
    reasons.push("oracle without circuit breaker");
  if (facts?.collateralLiquidityDepthUsd?.value != null && facts.collateralLiquidityDepthUsd.value < MIN_COLLATERAL_LIQUIDITY_USD)
    reasons.push("thin collateral liquidity");
  if (facts?.supplierConcentrationPct?.value != null && facts.supplierConcentrationPct.value > MAX_SUPPLIER_CONCENTRATION_PCT)
    reasons.push("supplier concentration too high");
  const adminKnown = ADMIN_LEVELS[facts?.adminKey?.value] != null;
  if (present && !adminKnown) reasons.push("unrecognized governance key (unverifiable)");
  const lifeboatScreenOk = facts?.poolClass?.value === "curated" && ORACLE_TYPES_OK.includes(facts?.oracleType?.value) && (facts?.collateralLiquidityDepthUsd?.value ?? 0) >= MIN_COLLATERAL_LIQUIDITY_USD && (facts?.supplierConcentrationPct?.value ?? 101) <= MAX_SUPPLIER_CONCENTRATION_PCT;
  const eligible = present && adminKnown && lifeboatScreenOk && yr.verdict === "real" && sec.auditGate === "pass" && sec.score >= SECURITY_MIN;
  return { protocol, eligible, yieldReality: yr, security: sec, reasons, isFixture, facts };
}

// api/vf/eligibility.js
var bigintSafe = (_, v) => typeof v === "bigint" ? v.toString() : v;
var json4 = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj, bigintSafe));
};
async function handler8(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), {
    scope: "market",
    endpoint: "eligibility"
  });
  if (!ctx) return;
  const { vault, amount, protocol } = req.body ?? {};
  let amt;
  try {
    amt = BigInt(amount);
  } catch {
    return json4(res, 400, { error: "Invalid amount" });
  }
  if (typeof vault !== "string" || !vault) return json4(res, 400, { error: "Missing vault" });
  const { facts } = resolve(protocol || "blend-usdc");
  const verdict = evaluate({ vault, amount: amt, facts });
  json4(res, 200, {
    allow: verdict.eligible ?? false,
    verdict,
    reasons: verdict.reasons ?? []
  });
}

// api/vf/prices.js
var DEFAULT_COINS = "coingecko:stellar,coingecko:usd-coin";
async function handler9(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: "market" });
  if (!ctx) return;
  const coins = new URL(req.url, "http://local").searchParams.get("coins") || DEFAULT_COINS;
  res.setHeader("Content-Type", "application/json");
  try {
    const upstream = await fetch(
      `https://coins.llama.fi/prices/current/${encodeURIComponent(coins)}`,
      { signal: AbortSignal.timeout(5e3) }
    );
    if (!upstream.ok) throw new Error("bad status");
    res.statusCode = 200;
    res.end(JSON.stringify(await upstream.json()));
  } catch {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "upstream" }));
  }
}

// api/vf/build-tx.js
var json5 = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};
async function buildDepositCore({ from, amount, vault, passphrase, rpcServer }) {
  const { Contract, TransactionBuilder, Address, nativeToScVal, BASE_FEE } = await import("file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js");
  const account = await rpcServer.getAccount(from);
  const contract = new Contract(vault);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase }).addOperation(
    contract.call("deposit", new Address(from).toScVal(), nativeToScVal(amount, { type: "i128" }))
  ).setTimeout(300).build();
  const prepared = await rpcServer.prepareTransaction(tx);
  return { xdr: prepared.toXDR() };
}
async function handler10(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: "tx" });
  if (!ctx) return;
  const { kind, from, amount } = req.body ?? {};
  const vault = process.env.SOROBAN_VAULT_ADDRESS || "";
  if (!vault) return json5(res, 503, { configured: false, error: "Vault not configured" });
  const { StrKey: StrKey3 } = await import("file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js");
  let amt;
  try {
    amt = BigInt(amount);
  } catch {
    return json5(res, 400, { error: "Invalid amount" });
  }
  if (kind !== "deposit" || !StrKey3.isValidEd25519PublicKey(from || "") || amt <= 0n) {
    return json5(res, 400, { error: "Invalid build request" });
  }
  try {
    const { rpc } = await import("file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js");
    const rpcServer = new rpc.Server(
      process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org"
    );
    const out = await buildDepositCore({
      from,
      amount: amt,
      vault,
      passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
      rpcServer
    });
    json5(res, 200, out);
  } catch {
    json5(res, 502, { error: "upstream" });
  }
}

// api/vf/simulate.js
var json6 = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};
async function simulateCore({ xdr, passphrase, rpcServer, parse }) {
  const tx = parse(xdr, passphrase);
  const sim = await rpcServer.simulateTransaction(tx);
  return {
    ok: !sim.error,
    error: sim.error ? "simulation failed" : void 0,
    latestLedger: sim.latestLedger
  };
}
async function handler11(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: "tx" });
  if (!ctx) return;
  const xdr = req.body?.xdr;
  if (typeof xdr !== "string" || !xdr) return json6(res, 400, { error: "Missing xdr" });
  try {
    const sdk = await import("file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js");
    const rpcServer = new sdk.rpc.Server(
      process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org"
    );
    const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
    const out = await simulateCore({
      xdr,
      passphrase,
      rpcServer,
      parse: (x, p) => sdk.TransactionBuilder.fromXDR(x, p)
    });
    json6(res, 200, out);
  } catch {
    json6(res, 502, { error: "upstream" });
  }
}

// api/vf/submit.js
var json7 = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};
async function submitCore({ xdr, deps }) {
  return deps.relay({ xdr });
}
async function handler12(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: "submit" });
  if (!ctx) return;
  const xdr = req.body?.xdr;
  if (typeof xdr !== "string" || !xdr) return json7(res, 400, { error: "Missing xdr" });
  const secret = process.env.STELLAR_RELAYER_SECRET || "";
  if (!secret) return json7(res, 503, { configured: false, error: "Relay not configured" });
  try {
    const sdk = await import("file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js");
    const { feeBumpAndSubmit: feeBumpAndSubmit2 } = await Promise.resolve().then(() => (init_stellar_relay(), stellar_relay_exports));
    const rpcServer = new sdk.rpc.Server(
      process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org"
    );
    const out = await submitCore({
      xdr,
      deps: {
        relay: ({ xdr: x }) => feeBumpAndSubmit2({
          xdr: x,
          secret,
          passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
          vaultAddr: process.env.SOROBAN_VAULT_ADDRESS || "",
          sdk,
          rpcServer
        })
      }
    });
    json7(res, 200, out);
  } catch {
    json7(res, 502, { error: "upstream" });
  }
}

// api/vf/scan.js
import { StrKey as StrKey2 } from "file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js";
var bigintSafe2 = (_, v) => typeof v === "bigint" ? v.toString() : v;
async function handler13(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: "scan" });
  if (!ctx) return;
  const target = String(req.body?.target || "");
  const protocol = req.body?.protocol || "blend-usdc";
  const kind = StrKey2.isValidEd25519PublicKey(target) ? "account" : StrKey2.isValidContract(target) ? "contract" : "invalid";
  const isKnownVault = kind === "contract" && target === (process.env.SOROBAN_VAULT_ADDRESS || "");
  const out = { kind, isKnownVault };
  if (isKnownVault) {
    const { facts } = resolve(protocol);
    out.eligibility = evaluate({ vault: target, amount: 10000000n, facts });
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(out, bigintSafe2));
}

// api/vf/strategy.js
import { z as z2 } from "file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/node_modules/zod/index.js";
var DEEPSEEK_URL2 = "https://api.deepseek.com/v1/chat/completions";
var MODEL = "deepseek-v4-flash";
var json8 = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};
var InputSchema = z2.object({
  amountUsd: z2.number().positive(),
  riskLevel: z2.enum(["low", "medium", "high"]),
  vaultCount: z2.number().int().min(1).max(10)
});
function equalSplit(protocols, vaultCount) {
  const picks = protocols.slice(0, Math.max(1, Math.min(vaultCount, protocols.length)));
  const base = Math.floor(100 / picks.length);
  return picks.map((protocol, i) => ({
    protocol,
    pct: i === 0 ? 100 - base * (picks.length - 1) : base
  }));
}
function parseLlmPlan(text, protocols) {
  try {
    const obj = JSON.parse(text);
    const allocations = obj?.allocations;
    if (!Array.isArray(allocations) || allocations.length === 0) return null;
    let sum = 0;
    for (const a of allocations) {
      if (!protocols.includes(a.protocol)) return null;
      if (typeof a.pct !== "number" || a.pct <= 0) return null;
      sum += a.pct;
    }
    if (Math.abs(sum - 100) > 1) return null;
    return { allocations, reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "" };
  } catch {
    return null;
  }
}
async function handler14(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: "strategy" });
  if (!ctx) return;
  const parsed = InputSchema.safeParse(req.body ?? {});
  if (!parsed.success) return json8(res, 400, { error: "Invalid strategy request" });
  const { amountUsd, riskLevel, vaultCount } = parsed.data;
  const protocols = (process.env.VF_VAULT_CATALOG || "blend-usdc").split(",").map((s) => s.trim()).filter(Boolean);
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey) {
    try {
      const upstream = await fetch(DEEPSEEK_URL2, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8e3),
        body: JSON.stringify({
          model: MODEL,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: 'You are a conservative DeFi allocation strategist. Reply ONLY with JSON: {"allocations":[{"protocol":<string>,"pct":<number>}],"reasoning":<string>} \u2014 pcts sum to 100, protocols strictly from the given catalog.'
            },
            {
              role: "user",
              content: `amountUsd=${amountUsd} riskLevel=${riskLevel} vaultCount=${vaultCount} catalog=${protocols.join(",")}`
            }
          ]
        })
      });
      if (upstream.ok) {
        const data = await upstream.json();
        const plan = parseLlmPlan(data?.choices?.[0]?.message?.content ?? "", protocols);
        if (plan) return json8(res, 200, { ...plan, source: "llm" });
      }
    } catch {
    }
  }
  json8(res, 200, {
    allocations: equalSplit(protocols, vaultCount),
    reasoning: "Equal split across the vetted catalog (deterministic fallback).",
    source: "fallback"
  });
}

// api/vf/_router.js
var routes = {
  "GET /auth/challenge": handler5,
  "POST /auth/token": handler6,
  "GET /keys": listKeys,
  "POST /keys": createKey,
  "DELETE /keys": deleteKey,
  "GET /vault-facts": handler7,
  "POST /eligibility": handler8,
  "GET /prices": handler9,
  "POST /build-tx": handler10,
  "POST /simulate": handler11,
  "POST /submit": handler12,
  "POST /scan": handler13,
  "POST /strategy": handler14
};
function subPath(req) {
  const pathname = new URL(req.url, "http://local").pathname;
  const i = pathname.indexOf("/api/vf");
  return (i >= 0 ? pathname.slice(i + "/api/vf".length) : pathname) || "/";
}
async function ensureBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return;
  if (req.body && typeof req.body === "object") return;
  const chunks = [];
  try {
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    req.body = raw ? JSON.parse(raw) : {};
  } catch {
    req.body = {};
  }
}
async function vfRouter(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end("");
  }
  await ensureBody(req);
  const handler16 = routes[`${req.method} ${subPath(req)}`];
  if (!handler16) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Not found" }));
  }
  return handler16(req, res);
}

// api/onramp-session.js
init_guard();
var API_KEY = () => process.env.TRANSAK_API_KEY || "";
var ACCESS_TOKEN = () => process.env.TRANSAK_ACCESS_TOKEN || "";
var ENVIRONMENT = () => process.env.TRANSAK_ENVIRONMENT || "STAGING";
var REFERRER_DOMAIN = () => process.env.TRANSAK_REFERRER_DOMAIN || "localhost";
var SESSION_API_URL = {
  STAGING: "https://api-gateway-stg.transak.com/api/v2/auth/session",
  PRODUCTION: "https://api-gateway.transak.com/api/v2/auth/session"
};
function isStellarAddress(addr) {
  return typeof addr === "string" && /^G[A-Z2-7]{55}$/.test(addr);
}
function bad3(res, msg) {
  res.statusCode = 400;
  return res.end(JSON.stringify({ error: msg }));
}
function buildWidgetParams({ address, amount }) {
  const params = {
    apiKey: API_KEY(),
    referrerDomain: REFERRER_DOMAIN(),
    productsAvailed: "BUY",
    network: "stellar",
    cryptoCurrencyCode: "USDC",
    walletAddress: address,
    disableWalletAddressForm: true
  };
  if (amount) {
    params.fiatCurrency = "USD";
    params.fiatAmount = amount;
  }
  return params;
}
async function readBody5(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
async function handler15(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }
  if (!applyCors(req, res)) return;
  if (!rateLimit(req, res, { max: 10, windowMs: 6e4, bucket: "onramp-session" })) return;
  res.setHeader("Content-Type", "application/json");
  const apiKey = API_KEY();
  const accessToken = ACCESS_TOKEN();
  if (!apiKey || !accessToken) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: "On-ramp not configured", configured: false }));
  }
  try {
    const body = await readBody5(req);
    const provider = body.provider || "transak";
    if (provider === "coinbase-base") {
      res.statusCode = 501;
      return res.end(
        JSON.stringify({ error: "coinbase-base provider not yet implemented", configured: false })
      );
    }
    if (provider !== "transak") {
      return bad3(res, "Unknown provider");
    }
    if (!isStellarAddress(body.address)) return bad3(res, "Invalid Stellar address");
    if (body.amount != null && (typeof body.amount !== "number" || body.amount <= 0)) {
      return bad3(res, "Invalid amount");
    }
    const widgetParams = buildWidgetParams({ address: body.address, amount: body.amount });
    const sessionUrl = SESSION_API_URL[ENVIRONMENT()] || SESSION_API_URL.STAGING;
    const upstream = await fetch(sessionUrl, {
      method: "POST",
      headers: { "access-token": accessToken, "content-type": "application/json" },
      body: JSON.stringify({ widgetParams })
    });
    if (!upstream.ok) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "On-ramp session request failed" }));
    }
    const data = await upstream.json();
    const widgetUrl = data?.response?.widgetUrl || data?.widgetUrl;
    if (!widgetUrl) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "On-ramp session response missing widgetUrl" }));
    }
    return res.end(JSON.stringify({ widgetUrl }));
  } catch (err) {
    console.error("[api/onramp-session] error:", err?.message || err);
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: "On-ramp session failed" }));
  }
}

// vite.config.js
var __vite_injected_original_import_meta_url = "file:///mnt/B47ED1067ED0C272/project/vibingfarmer/frontend/vite.config.js";
var repoRoot = path.resolve(path.dirname(fileURLToPath(__vite_injected_original_import_meta_url)), "..");
var vite_config_default = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  if (env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
  if (env.TAVILY_API_KEY) process.env.TAVILY_API_KEY = env.TAVILY_API_KEY;
  if (env.ALLOWED_ORIGIN) process.env.ALLOWED_ORIGIN = env.ALLOWED_ORIGIN;
  if (env.STELLAR_RELAYER_SECRET) process.env.STELLAR_RELAYER_SECRET = env.STELLAR_RELAYER_SECRET;
  if (env.SOROBAN_RPC_URL) process.env.SOROBAN_RPC_URL = env.SOROBAN_RPC_URL;
  if (env.STELLAR_NETWORK_PASSPHRASE)
    process.env.STELLAR_NETWORK_PASSPHRASE = env.STELLAR_NETWORK_PASSPHRASE;
  if (env.SOROBAN_VAULT_ADDRESS) process.env.SOROBAN_VAULT_ADDRESS = env.SOROBAN_VAULT_ADDRESS;
  if (env.VF_FAUCET_SECRET) process.env.VF_FAUCET_SECRET = env.VF_FAUCET_SECRET;
  if (env.SOROBAN_TOKEN_ADDRESS) process.env.SOROBAN_TOKEN_ADDRESS = env.SOROBAN_TOKEN_ADDRESS;
  if (env.SOROBAN_AGENT_ALLOWLIST) process.env.SOROBAN_AGENT_ALLOWLIST = env.SOROBAN_AGENT_ALLOWLIST;
  if (env.SOROBAN_ROUTER_ADDRESS) process.env.SOROBAN_ROUTER_ADDRESS = env.SOROBAN_ROUTER_ADDRESS;
  if (env.VF_AUTH_SIGNING_KEY) process.env.VF_AUTH_SIGNING_KEY = env.VF_AUTH_SIGNING_KEY;
  if (env.VF_JWT_SECRET) process.env.VF_JWT_SECRET = env.VF_JWT_SECRET;
  if (env.VF_HOME_DOMAIN) process.env.VF_HOME_DOMAIN = env.VF_HOME_DOMAIN;
  if (env.VF_GLOBAL_DAILY_CAP) process.env.VF_GLOBAL_DAILY_CAP = env.VF_GLOBAL_DAILY_CAP;
  if (env.VF_VAULT_CATALOG) process.env.VF_VAULT_CATALOG = env.VF_VAULT_CATALOG;
  if (env.TRANSAK_API_KEY) process.env.TRANSAK_API_KEY = env.TRANSAK_API_KEY;
  if (env.TRANSAK_ACCESS_TOKEN) process.env.TRANSAK_ACCESS_TOKEN = env.TRANSAK_ACCESS_TOKEN;
  if (env.TRANSAK_ENVIRONMENT) process.env.TRANSAK_ENVIRONMENT = env.TRANSAK_ENVIRONMENT;
  if (env.TRANSAK_REFERRER_DOMAIN) process.env.TRANSAK_REFERRER_DOMAIN = env.TRANSAK_REFERRER_DOMAIN;
  const apiProxyPlugin = {
    name: "api-proxy",
    configureServer(s) {
      s.middlewares.use("/api/vf", vfRouter);
      s.middlewares.use("/api/ai", handler);
      s.middlewares.use("/api/search", handler2);
      s.middlewares.use("/api/stellar-relay", handler3);
      s.middlewares.use("/api/faucet", handler4);
      s.middlewares.use("/api/onramp-session", handler15);
    },
    configurePreviewServer(s) {
      s.middlewares.use("/api/vf", vfRouter);
      s.middlewares.use("/api/ai", handler);
      s.middlewares.use("/api/search", handler2);
      s.middlewares.use("/api/stellar-relay", handler3);
      s.middlewares.use("/api/faucet", handler4);
      s.middlewares.use("/api/onramp-session", handler15);
    }
  };
  return {
    plugins: [react(), apiProxyPlugin],
    root: ".",
    build: {
      outDir: "dist",
      rollupOptions: {
        external: [],
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("framer-motion")) return "motion";
            return void 0;
          }
        }
      }
    },
    server: {
      historyApiFallback: true,
      // frontend/src/stellar/vaultReads.js imports keeper/src/apr.js via a relative cross-package
      // path (T2 Fix 3 dedup) — that file lives outside this Vite root ('.' == frontend/), so the
      // default fs.allow boundary 403s it under `vite dev`. Widen to the repo root so /@fs/ can
      // reach it; `vite build` (Rollup) and vitest are unaffected — this only bounds the dev server.
      fs: {
        allow: [repoRoot]
      }
    },
    preview: {
      historyApiFallback: true
    },
    optimizeDeps: {
      include: ["react-force-graph-2d"]
    },
    // Vitest-only env. base/config.js and src/config.js's BASE_POOL_CATALOG fail loudly at module
    // load on a missing 0x address (deliberate — see their docstrings). Tests import those modules
    // statically without real deployments, so provide throwaway placeholder addresses here; a
    // per-test vi.stubEnv still overrides these (config.test.js relies on that). Never used by
    // `vite dev`/`vite build` — this key is read only under vitest.
    test: {
      env: {
        VITE_YIELD_ROUTER_ADDRESS: "0x1111111111111111111111111111111111111111",
        VITE_BASE_POOL_1_ADDRESS: "0x1111111111111111111111111111111111111112",
        VITE_BASE_POOL_2_ADDRESS: "0x1111111111111111111111111111111111111113",
        VITE_BASE_POOL_3_ADDRESS: "0x1111111111111111111111111111111111111114"
      }
    }
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiYXBpL19ndWFyZC5qcyIsICJhcGkvc3RlbGxhci1yZWxheS5qcyIsICJ2aXRlLmNvbmZpZy5qcyIsICJhcGkvYWkuanMiLCAiYXBpL3NlYXJjaC5qcyIsICJhcGkvZmF1Y2V0LmpzIiwgImFwaS92Zi9hdXRoLWNoYWxsZW5nZS5qcyIsICJhcGkvdmYvX3NlcDEwLmpzIiwgImFwaS92Zi9hdXRoLXRva2VuLmpzIiwgImFwaS92Zi9fand0LmpzIiwgImFwaS92Zi9rZXlzLmpzIiwgImFwaS92Zi9fZGIuanMiLCAiYXBpL3ZmL19rZXlzdG9yZS5qcyIsICJhcGkvdmYvX3ZmYXV0aC5qcyIsICJzcmMvc3RyYXRlZ3kvdmF1bHRGYWN0c1NuYXBzaG90LmpzIiwgInNyYy9zdHJhdGVneS92YXVsdEZhY3RzTGl2ZS5qcyIsICJzcmMvc3RyYXRlZ3kvdmF1bHRGYWN0cy5qcyIsICJhcGkvdmYvdmF1bHQtZmFjdHMuanMiLCAic3JjL3N0cmF0ZWd5L2VsaWdpYmlsaXR5R2F0ZS5qcyIsICJhcGkvdmYvZWxpZ2liaWxpdHkuanMiLCAiYXBpL3ZmL3ByaWNlcy5qcyIsICJhcGkvdmYvYnVpbGQtdHguanMiLCAiYXBpL3ZmL3NpbXVsYXRlLmpzIiwgImFwaS92Zi9zdWJtaXQuanMiLCAiYXBpL3ZmL3NjYW4uanMiLCAiYXBpL3ZmL3N0cmF0ZWd5LmpzIiwgImFwaS92Zi9fcm91dGVyLmpzIiwgImFwaS9vbnJhbXAtc2Vzc2lvbi5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvX2d1YXJkLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvX2d1YXJkLmpzXCI7Ly8gU2hhcmVkIGd1YXJkIGZvciB0aGUgc2VydmVybGVzcyBBUEkgcHJveGllcyAoYWkgLyByZWxheSAvIHNlYXJjaCkuXHJcbi8vIEZpbGVzIHByZWZpeGVkIHdpdGggYF9gIGFyZSBOT1Qgcm91dGVkIGJ5IFZlcmNlbCBcdTIwMTQgaW1wb3J0LW9ubHkuXHJcbi8vXHJcbi8vIFR3byBsYXllcnM6XHJcbi8vICAgMS4gT3JpZ2luIGFsbG93bGlzdCBcdTIwMTQgbG9jYWxob3N0IGRldiBvcmlnaW5zIHRydXN0ZWQgT05MWSBvdXRzaWRlIHByb2R1Y3Rpb247XHJcbi8vICAgICAgcHJvZCBvcmlnaW5zIGNvbWUgZnJvbSBBTExPV0VEX09SSUdJTiBlbnYgc28gdGhlIGRlcGxveWVkIGJ1bmRsZSBuZXZlclxyXG4vLyAgICAgIHRydXN0cyBsb2NhbGhvc3QuXHJcbi8vICAgMi4gSW4tbWVtb3J5IHJhdGUgbGltaXQgXHUyMDE0IHRoZSBPcmlnaW4gaGVhZGVyIGlzIGJyb3dzZXItZW5mb3JjZWQsIG5vdFxyXG4vLyAgICAgIGF0dGFja2VyLWVuZm9yY2VkIChjdXJsIGZvcmdlcyBpdCB0cml2aWFsbHkpLCBzbyB0aGUgYWxsb3dsaXN0IGlzIE5PVFxyXG4vLyAgICAgIGF1dGhlbnRpY2F0aW9uLiBBIHBlci1JUCBmaXhlZC13aW5kb3cgY2FwIGJsdW50cyBmb3JnZWQtT3JpZ2luIGFidXNlOlxyXG4vLyAgICAgIGNvc3QgZHJhaW4gb24gdGhlIERlZXBTZWVrL1RhdmlseSBrZXlzLCBnYXMtZHJhaW4gRG9TIG9uIHRoZSBmdW5kZWRcclxuLy8gICAgICAxU2hvdCByZWxheWVyIHdhbGxldC4gQmVzdC1lZmZvcnQ6IHN0YXRlIGlzIHBlciB3YXJtIHByb2Nlc3MuXHJcblxyXG5jb25zdCBpc1Byb2QgPVxyXG4gIHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSAncHJvZHVjdGlvbicgfHwgcHJvY2Vzcy5lbnYuVkVSQ0VMX0VOViA9PT0gJ3Byb2R1Y3Rpb24nXHJcblxyXG5jb25zdCBERVZfT1JJR0lOUyA9IFtcclxuICAnaHR0cDovL2xvY2FsaG9zdDo1MTczJyxcclxuICAnaHR0cDovL2xvY2FsaG9zdDo1MTc0JyxcclxuICAnaHR0cDovL2xvY2FsaG9zdDo1MTc1JyxcclxuICAnaHR0cDovL2xvY2FsaG9zdDo0MTczJyxcclxuXVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGFsbG93ZWRPcmlnaW5zKCkge1xyXG4gIGNvbnN0IGZyb21FbnYgPSBwcm9jZXNzLmVudi5BTExPV0VEX09SSUdJTlxyXG4gICAgPyBwcm9jZXNzLmVudi5BTExPV0VEX09SSUdJTi5zcGxpdCgnLCcpLm1hcCgobykgPT4gby50cmltKCkpXHJcbiAgICA6IFtdXHJcbiAgcmV0dXJuIFsuLi4oaXNQcm9kID8gW10gOiBERVZfT1JJR0lOUyksIC4uLmZyb21FbnZdLmZpbHRlcihCb29sZWFuKVxyXG59XHJcblxyXG4vKipcclxuICogRW5mb3JjZSB0aGUgb3JpZ2luIGFsbG93bGlzdCBhbmQgc2V0IENPUlMgaGVhZGVycy5cclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgYWxsb3dlZCAoaGVhZGVycyBzZXQpLCBmYWxzZSBpZiByZWplY3RlZCAoNDAzIGFscmVhZHkgc2VudClcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBhcHBseUNvcnMocmVxLCByZXMpIHtcclxuICBjb25zdCBvcmlnaW4gPSByZXEuaGVhZGVycy5vcmlnaW4gfHwgJydcclxuICBpZiAoIWFsbG93ZWRPcmlnaW5zKCkuaW5jbHVkZXMob3JpZ2luKSkge1xyXG4gICAgcmVzLnN0YXR1c0NvZGUgPSA0MDNcclxuICAgIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJylcclxuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ZvcmJpZGRlbicgfSkpXHJcbiAgICByZXR1cm4gZmFsc2VcclxuICB9XHJcbiAgcmVzLnNldEhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJywgb3JpZ2luKVxyXG4gIHJlcy5zZXRIZWFkZXIoJ0FjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMnLCAnUE9TVCcpXHJcbiAgcmVzLnNldEhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVycycsICdDb250ZW50LVR5cGUnKVxyXG4gIHJldHVybiB0cnVlXHJcbn1cclxuXHJcbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBJbi1tZW1vcnkgZml4ZWQtd2luZG93IHJhdGUgbGltaXQgKHBlciB3YXJtIHByb2Nlc3MpIFx1MjUwMFx1MjUwMFx1MjUwMFxyXG5jb25zdCBfYnVja2V0cyA9IG5ldyBNYXAoKSAvLyBrZXkgXHUyMTkyIHsgY291bnQsIHJlc2V0QXQgfVxyXG5jb25zdCBNQVhfQlVDS0VUUyA9IDUwMDBcclxuXHJcbi8vIEhvdyBtYW55IFRSVVNURUQgcHJveGllcyBzaXQgaW4gZnJvbnQgb2YgdGhpcyBwcm9jZXNzIGFuZCBBUFBFTkQgdG8gWEZGLlxyXG4vLyBEZWZhdWx0IDEgKGEgc2luZ2xlIHBsYXRmb3JtIGVkZ2UsIGUuZy4gVmVyY2VsKS4gVGhlIGZpcnN0IChsZWZ0bW9zdCkgWEZGXHJcbi8vIGVudHJpZXMgYXJlIGNsaWVudC1zdXBwbGllZCBhbmQgZm9yZ2VhYmxlIFx1MjAxNCB0cnVzdGluZyB0aGVtIGxldHMgYW4gYXR0YWNrZXJcclxuLy8gbWludCBhIGZyZXNoIHJhdGUtbGltaXQgYnVja2V0IHBlciByZXF1ZXN0LiBXZSBpbnN0ZWFkIHJlYWQgZnJvbSB0aGUgUklHSFQuXHJcbmNvbnN0IFRSVVNUX1BST1hZX0hPUFMgPSBOdW1iZXIocHJvY2Vzcy5lbnYuVFJVU1RfUFJPWFlfSE9QUyA/PyAxKVxyXG5cclxuZnVuY3Rpb24gY2xpZW50SXAocmVxKSB7XHJcbiAgLy8gMS4gUGxhdGZvcm0tZ3VhcmFudGVlZCBjb25uZWN0aW5nIElQLiBWZXJjZWwvbW9zdCBQYWFTIHNldCBgeC1yZWFsLWlwYCB0byB0aGVcclxuICAvLyAgICByZWFsIGNsaWVudCBhbmQgaXQgaXMgTk9UIGFuIGFwcGVuZGFibGUgY2hhaW4sIHNvIGEgZm9yZ2VkIHZhbHVlIGNhbid0IGhpZGVcclxuICAvLyAgICBiZWhpbmQgaXQuIFByZWZlciBpdCBvdXRyaWdodC5cclxuICBjb25zdCByZWFsID0gcmVxLmhlYWRlcnNbJ3gtcmVhbC1pcCddXHJcbiAgaWYgKHR5cGVvZiByZWFsID09PSAnc3RyaW5nJyAmJiByZWFsLnRyaW0oKSkgcmV0dXJuIHJlYWwudHJpbSgpXHJcblxyXG4gIC8vIDIuIFJhdyBYRkY6IHRydXN0ZWQgcHJveGllcyBhcHBlbmQgdGhlIHRydWUgY29ubmVjdGluZyBJUCB0byB0aGUgUklHSFQ7IGFuXHJcbiAgLy8gICAgZXh0ZXJuYWwgYXR0YWNrZXIgY2FuIG9ubHkgaW5qZWN0IGVudHJpZXMgb24gdGhlIExFRlQuIFBpY2sgdGhlIGVudHJ5IHRoZVxyXG4gIC8vICAgIG4tdGggdHJ1c3RlZCBob3Agb2JzZXJ2ZWQsIGNvdW50aW5nIGZyb20gdGhlIHJpZ2h0LCBzbyB0aGUgc3Bvb2ZlZCBwcmVmaXhcclxuICAvLyAgICBpcyBpZ25vcmVkLiBXaXRoIG9uZSBlZGdlIHRoaXMgaXMgc2ltcGx5IHRoZSBsYXN0IGVudHJ5LlxyXG4gIGNvbnN0IHhmZiA9IHJlcS5oZWFkZXJzWyd4LWZvcndhcmRlZC1mb3InXVxyXG4gIGlmIChUUlVTVF9QUk9YWV9IT1BTID4gMCAmJiB0eXBlb2YgeGZmID09PSAnc3RyaW5nJyAmJiB4ZmYudHJpbSgpKSB7XHJcbiAgICBjb25zdCBwYXJ0cyA9IHhmZi5zcGxpdCgnLCcpLm1hcCgocCkgPT4gcC50cmltKCkpLmZpbHRlcihCb29sZWFuKVxyXG4gICAgaWYgKHBhcnRzLmxlbmd0aCkge1xyXG4gICAgICBjb25zdCBpZHggPSBwYXJ0cy5sZW5ndGggLSBUUlVTVF9QUk9YWV9IT1BTXHJcbiAgICAgIHJldHVybiBwYXJ0c1tpZHggPj0gMCA/IGlkeCA6IDBdXHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyAzLiBObyB0cnVzdGVkIHByb3h5IGhlYWRlcnMgXHUyMDE0IGZhbGwgYmFjayB0byB0aGUgc29ja2V0IHBlZXIuXHJcbiAgcmV0dXJuIHJlcS5zb2NrZXQ/LnJlbW90ZUFkZHJlc3MgfHwgJ3Vua25vd24nXHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBydW5lKG5vdykge1xyXG4gIGZvciAoY29uc3QgW2ssIHZdIG9mIF9idWNrZXRzKSB7XHJcbiAgICBpZiAobm93ID49IHYucmVzZXRBdCkgX2J1Y2tldHMuZGVsZXRlKGspXHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogUGVyLUlQIGZpeGVkLXdpbmRvdyBsaW1pdC4gU2VuZHMgNDI5ICsgUmV0cnktQWZ0ZXIgd2hlbiBleGNlZWRlZC5cclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgd2l0aGluIGxpbWl0LCBmYWxzZSBpZiByZWplY3RlZCAoNDI5IGFscmVhZHkgc2VudClcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByYXRlTGltaXQocmVxLCByZXMsIHsgbWF4ID0gMzAsIHdpbmRvd01zID0gNjBfMDAwLCBidWNrZXQgPSAnZGVmYXVsdCcgfSA9IHt9KSB7XHJcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKVxyXG4gIGlmIChfYnVja2V0cy5zaXplID4gTUFYX0JVQ0tFVFMpIHBydW5lKG5vdylcclxuICBjb25zdCBrZXkgPSBgJHtidWNrZXR9OiR7Y2xpZW50SXAocmVxKX1gXHJcbiAgY29uc3QgZW50cnkgPSBfYnVja2V0cy5nZXQoa2V5KVxyXG4gIGlmICghZW50cnkgfHwgbm93ID49IGVudHJ5LnJlc2V0QXQpIHtcclxuICAgIF9idWNrZXRzLnNldChrZXksIHsgY291bnQ6IDEsIHJlc2V0QXQ6IG5vdyArIHdpbmRvd01zIH0pXHJcbiAgICByZXR1cm4gdHJ1ZVxyXG4gIH1cclxuICBpZiAoZW50cnkuY291bnQgPj0gbWF4KSB7XHJcbiAgICBjb25zdCByZXRyeSA9IE1hdGguY2VpbCgoZW50cnkucmVzZXRBdCAtIG5vdykgLyAxMDAwKVxyXG4gICAgcmVzLnN0YXR1c0NvZGUgPSA0MjlcclxuICAgIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJylcclxuICAgIHJlcy5zZXRIZWFkZXIoJ1JldHJ5LUFmdGVyJywgU3RyaW5nKHJldHJ5KSlcclxuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1RvbyBtYW55IHJlcXVlc3RzJyB9KSlcclxuICAgIHJldHVybiBmYWxzZVxyXG4gIH1cclxuICBlbnRyeS5jb3VudCArPSAxXHJcbiAgcmV0dXJuIHRydWVcclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvc3RlbGxhci1yZWxheS5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3N0ZWxsYXItcmVsYXkuanNcIjsvLyBTZXJ2ZXItc2lkZSBTb3JvYmFuIGdhc2xlc3MgcmVsYXkuIFdyYXBzIGFuIGFnZW50LXNpZ25lZCBpbm5lciBTb3JvYmFuIHRyYW5zYWN0aW9uIGluIGFcclxuLy8gZmVlLWJ1bXAgcGFpZCBieSB0aGUgc2VydmVyJ3MgcmVsYXllciBrZXlwYWlyLCBzdWJtaXRzIHZpYSBTb3JvYmFuIFJQQywgcG9sbHMgdG8gYSByZXN1bHQuXHJcbi8vXHJcbi8vIFNlY3VyaXR5IG1vZGVsIChkdW1iIGZlZSBzcG9uc29yKTogdGhlIHJlbGF5IGRvZXMgTk9UIGF1dGhvcml6ZSB0aGUgZGVwb3NpdCBcdTIwMTQgdGhlIGlubmVyIHR4XHJcbi8vIGFscmVhZHkgY2FycmllcyB0aGUgYWdlbnQgY3VzdG9tIGFjY291bnQncyBfX2NoZWNrX2F1dGggZWQyNTUxOSBhdXRoIGVudHJ5LCBzaWduZWQgY2xpZW50LXNpZGVcclxuLy8gYnkgdGhlIGFnZW50IHNlc3Npb24ga2V5LiBUaGUgcmVsYXkgb25seSBwYXlzIHRoZSBYTE0gZmVlLiBBYnVzZSBpcyBib3VuZGVkIGJ5OiBvcmlnaW5cclxuLy8gYWxsb3dsaXN0ICsgcGVyLUlQIHJhdGUgbGltaXQgKF9ndWFyZC5qcykgQU5EIHRoZSB2YXVsdC10YXJnZXQgYWxsb3dsaXN0IChhc3NlcnRWYXVsdERlcG9zaXQsXHJcbi8vIFRhc2sgNCkgXHUyMDE0IGluY2x1ZGluZyB0aGUgU09ST0JBTl9BR0VOVF9BTExPV0xJU1QgZXhhY3QtbWF0Y2ggY2hlY2sgb24gRjExIGV4aXQtbGVnLTIgdG9rZW5cclxuLy8gdHJhbnNmZXJzIFx1MjAxNCBzbyB0aGUgcmVsYXllciBuZXZlciBzcG9uc29ycyBhbiB1bnJlbGF0ZWQgdHJhbnNhY3Rpb24uIFRoZSByZWxheWVyIFNFQ1JFVCBpc1xyXG4vLyBzZXJ2ZXItaGVsZCAoU1RFTExBUl9SRUxBWUVSX1NFQ1JFVCkgXHUyMDE0IG5ldmVyIGluIHRoZSBjbGllbnQgYnVuZGxlLlxyXG4vL1xyXG4vLyBBY3Rpb25zOlxyXG4vLyAgIHsgYWN0aW9uOiAnd2FsbGV0JyB9ICAgICAgICAgICAgXHUyMTkyIHsgYWRkcmVzcyB9ICAgICAgICAgICAocmVsYXllciBwdWJrZXkgXHUyMDE0IGZ1bmQgaXQpXHJcbi8vICAgeyBhY3Rpb246ICdzdWJtaXQnLCB4ZHIgfSAgICAgICBcdTIxOTIgeyBoYXNoLCBzdGF0dXMgfSAgICAgIChmZWUtYnVtcCArIHN1Ym1pdCArIHBvbGwpXHJcblxyXG5pbXBvcnQgeyBhcHBseUNvcnMsIHJhdGVMaW1pdCB9IGZyb20gJy4vX2d1YXJkLmpzJ1xyXG5cclxuY29uc3QgUEFTU1BIUkFTRSA9ICgpID0+XHJcbiAgcHJvY2Vzcy5lbnYuU1RFTExBUl9ORVRXT1JLX1BBU1NQSFJBU0UgfHwgJ1Rlc3QgU0RGIE5ldHdvcmsgOyBTZXB0ZW1iZXIgMjAxNSdcclxuY29uc3QgUlBDX1VSTCA9ICgpID0+IHByb2Nlc3MuZW52LlNPUk9CQU5fUlBDX1VSTCB8fCAnaHR0cHM6Ly9zb3JvYmFuLXRlc3RuZXQuc3RlbGxhci5vcmcnXHJcbmNvbnN0IFJFTEFZRVJfU0VDUkVUID0gKCkgPT4gcHJvY2Vzcy5lbnYuU1RFTExBUl9SRUxBWUVSX1NFQ1JFVCB8fCAnJ1xyXG5jb25zdCBWQVVMVF9BRERSID0gKCkgPT4gcHJvY2Vzcy5lbnYuU09ST0JBTl9WQVVMVF9BRERSRVNTIHx8ICcnXHJcbmNvbnN0IFRPS0VOX0FERFIgPSAoKSA9PiBwcm9jZXNzLmVudi5TT1JPQkFOX1RPS0VOX0FERFJFU1MgfHwgJydcclxuLy8gZnVuZGluZ19yb3V0ZXIgZm9yIHRoZSBvbmUtcG9wdXAgZ3JhbnQgZmxvdzsgdW5zZXQgPSByb3V0ZXIgcmVsYXlpbmcgZGlzYWJsZWQgKGZhaWwgY2xvc2VkKS5cclxuY29uc3QgUk9VVEVSX0FERFIgPSAoKSA9PiBwcm9jZXNzLmVudi5TT1JPQkFOX1JPVVRFUl9BRERSRVNTIHx8ICcnXHJcbmNvbnN0IEFHRU5UX0FMTE9XTElTVCA9ICgpID0+IHByb2Nlc3MuZW52LlNPUk9CQU5fQUdFTlRfQUxMT1dMSVNUIHx8ICcnXHJcbi8vIENvbnRlbnQtYWRkcmVzc2VkIHBpbiBvZiB0aGUgT1ogc21hcnQtYWNjb3VudCB3YXNtIFNBSyBkZXBsb3lzIChzZWUgd2FsbGV0L2NvbmZpZy5qc1xyXG4vLyBBQ0NPVU5UX1dBU01fSEFTSCBcdTIwMTQgc2FtZSBpbmxpbmUtY29uc3RhbnQgZGlzY2lwbGluZSkuIEVudi1vdmVycmlkYWJsZSwgbmV2ZXIgc2VjcmV0LlxyXG5jb25zdCBBQ0NPVU5UX1dBU01fSEFTSCA9ICgpID0+XHJcbiAgcHJvY2Vzcy5lbnYuU09ST0JBTl9BQ0NPVU5UX1dBU01fSEFTSCB8fFxyXG4gICdhMTJlOGZhOTYyMWVmZDIwMzE1NzUzYmQ0MDA3ZDk3NDM5MGUzMWZiY2I0YTdkZGM0ZGQwYTBkZWM3MjhiZjJlJ1xyXG5cclxuLy8gRmVlLWJ1bXAgYmFzZSBmZWUgPSBpbm5lciBmZWUgKyB0aGlzIG1hcmdpbiAoc3Ryb29wcykuIDAuMSBYTE0gaXMgZ2VuZXJvdXMgb24gdGVzdG5ldCBhbmRcclxuLy8gc2FmZWx5IGNsZWFycyB0aGUgU0RLJ3MgXCJmZWUtYnVtcCBmZWUgPj0gaW5uZXIgZmVlXCIgZmxvb3IgZm9yIG91ciBzaW5nbGUtb3AgZGVwb3NpdCB0eHMuXHJcbmNvbnN0IEZFRV9NQVJHSU4gPSAxXzAwMF8wMDBuXHJcblxyXG5leHBvcnQgY2xhc3MgUmVsYXlFcnJvciBleHRlbmRzIEVycm9yIHt9XHJcblxyXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgd2FybS1wcm9jZXNzIHJlcGxheSBndWFyZCwga2V5ZWQgYnkgaW5uZXItdHggaGFzaCAoaGV4KSBcdTI1MDBcdTI1MDBcdTI1MDBcclxuY29uc3QgX3NlZW4gPSBuZXcgTWFwKCkgLy8gaW5uZXJIYXNoIFx1MjE5MiB7IHN0YXRlOidpbi1mbGlnaHQnfCdkb25lJywgb3V0PywgYXQgfVxyXG5jb25zdCBTRUVOX01BWCA9IDUwMDBcclxuY29uc3QgU0VFTl9UVExfTVMgPSAzMCAqIDYwXzAwMFxyXG5leHBvcnQgZnVuY3Rpb24gX2NsZWFyU2VlbigpIHtcclxuICBfc2Vlbi5jbGVhcigpXHJcbn1cclxuZnVuY3Rpb24gcHJ1bmVTZWVuKG5vdykge1xyXG4gIGZvciAoY29uc3QgW2ssIHZdIG9mIF9zZWVuKSBpZiAobm93IC0gdi5hdCA+IFNFRU5fVFRMX01TKSBfc2Vlbi5kZWxldGUoaylcclxufVxyXG5cclxuLy8gQ29tbWEtc2VwYXJhdGVkIGFsbG93bGlzdCBzdHJpbmcgXHUyMTkyIHRyaW1tZWQsIG5vbi1lbXB0eSBlbnRyaWVzIChtYXRjaGVzIF9ndWFyZC5qcydzXHJcbi8vIGFsbG93ZWRPcmlnaW5zIHBhcnNpbmcgY29udmVudGlvbikuXHJcbmZ1bmN0aW9uIHBhcnNlQWxsb3dsaXN0KHJhdykge1xyXG4gIHJldHVybiAocmF3IHx8ICcnKVxyXG4gICAgLnNwbGl0KCcsJylcclxuICAgIC5tYXAoKHMpID0+IHMudHJpbSgpKVxyXG4gICAgLmZpbHRlcihCb29sZWFuKVxyXG59XHJcblxyXG4vKipcclxuICogQWxsb3dsaXN0IHRoZSBpbm5lciB0eCB0aGUgcmVsYXkgd2lsbCBzcG9uc29yOiBhIHNpbmdsZSBJbnZva2VIb3N0RnVuY3Rpb24gY2FsbGluZ1xyXG4gKiBgdmF1bHRBZGRyYC5kZXBvc2l0LCBgdmF1bHRBZGRyYC5yZWRlZW0gKEYxMSBleGl0IGxlZyAxKSwgb3IgXHUyMDE0IHdoZW4gdG9rZW5BZGRyIGlzIHNldCBcdTIwMTRcclxuICogYHRva2VuQWRkcmAudHJhbnNmZXIgd2hvc2UgYGZyb21gIGlzIGFuIEVYQUNUIG1hdGNoIGluIGBhZ2VudEFsbG93bGlzdGAgKEYxMSBleGl0IGxlZyAyOlxyXG4gKiB0aGUgYWdlbnQgY3VzdG9tIGFjY291bnQncyBvd24gX19jaGVja19hdXRoIHN0aWxsIGdhdGVzIHRoZSB0cmFuc2ZlciB0byBgdG8gPT0gc2NvcGUub3duZXJgXHJcbiAqIG9uLWNoYWluOyB0aGlzIHNlcnZlci1zaWRlIGNoZWNrIHN0b3BzIHRoZSByZWxheWVyIHNwb25zb3JpbmcgdHJhbnNmZXJzIGZvciBhbnkgY29udHJhY3RcclxuICogYWNjb3VudCBvdXRzaWRlIHRoZSBhbGxvd2xpc3QgXHUyMDE0IGFuIGF0dGFja2VyJ3MgYWx3YXlzLWF1dGggY3VzdG9tIGFjY291bnQgbm8gbG9uZ2VyIGdldHNcclxuICogZnJlZSBmZWUgc3BvbnNvcnNoaXAganVzdCBieSBzdGFydGluZyB3aXRoICdDJykuIEZBSUwgQ0xPU0VEOiB0b2tlbkFkZHIgc2V0IGJ1dFxyXG4gKiBhZ2VudEFsbG93bGlzdCBlbXB0eS91bnNldCByZWplY3RzIGV2ZXJ5IHRyYW5zZmVyIChkZXBvc2l0L3JlZGVlbSBicmFuY2hlcyB1bmFmZmVjdGVkKS5cclxuICogTm8tb3Agd2hlbiB2YXVsdEFkZHIgaXMgZmFsc3kuIFRocm93cyBSZWxheUVycm9yIG9uIG1pc21hdGNoLlxyXG4gKlxyXG4gKiBXaGVuIGBhY2NvdW50V2FzbUhhc2hgIGlzIHNldCwgQUxTTyBzcG9uc29ycyBhIHNpbmdsZSBjcmVhdGVDb250cmFjdFYyIGRlcGxveSB3aG9zZSB3YXNtXHJcbiAqIGV4ZWN1dGFibGUgaXMgRVhBQ1RMWSB0aGF0IGhhc2ggXHUyMDE0IFNBSydzIGBraXQuY3JlYXRlV2FsbGV0KGF1dG9TdWJtaXQpYCBwb3N0cyB0aGUgcGFzc2tleVxyXG4gKiBzbWFydC1hY2NvdW50IGRlcGxveSB0eCBoZXJlIChiYXJlIGB7eGRyfWAsIG5vIGFjdGlvbikuIFRoZSBjb250ZW50LWFkZHJlc3MgcGluIG1lYW5zIHRoZVxyXG4gKiByZWxheWVyIG9ubHkgZXZlciBwYXlzIHRvIGRlcGxveSB0aGUgYXVkaXRlZCBPWiBzbWFydC1hY2NvdW50IHdhc20sIG5ldmVyIGF0dGFja2VyIGNvZGUuXHJcbiAqIEZBSUwgQ0xPU0VEOiBubyBwaW4gKGRlZmF1bHQgJycpIFx1MjE5MiBldmVyeSBkZXBsb3kgcmVqZWN0ZWQ7IFYxIGNyZWF0ZUNvbnRyYWN0IGFuZCBub24td2FzbVxyXG4gKiBleGVjdXRhYmxlcyAoU0FDKSByZWplY3RlZCB1bmNvbmRpdGlvbmFsbHkuXHJcbiAqXHJcbiAqIFdoZW4gYHJvdXRlckFkZHJgIGlzIHNldCAoU09ST0JBTl9ST1VURVJfQUREUkVTUyBcdTIwMTQgdGhlIGZ1bmRpbmdfcm91dGVyIG9mIHRoZSBvbmUtcG9wdXBcclxuICogZ3JhbnQgZmxvdyksIEFMU08gc3BvbnNvcnMgYHJvdXRlckFkZHJgLmdyYW50IC8gYHJvdXRlckFkZHJgLnB1bGwgXHUyMDE0IG5vdGhpbmcgZWxzZSBvbiB0aGF0XHJcbiAqIGNvbnRyYWN0LiBGQUlMIENMT1NFRDogcm91dGVyQWRkciB1bnNldCAoZGVmYXVsdCAnJykgXHUyMTkyIGV2ZXJ5IHJvdXRlciBjYWxsIHJlamVjdGVkLFxyXG4gKiBieXRlLWlkZW50aWNhbCB0byB0aGUgcHJlLXJvdXRlciBndWFyZC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRWYXVsdERlcG9zaXQoXHJcbiAgaW5uZXIsXHJcbiAgdmF1bHRBZGRyLFxyXG4gIHNkayxcclxuICB0b2tlbkFkZHIgPSAnJyxcclxuICBhZ2VudEFsbG93bGlzdCA9ICcnLFxyXG4gIGFjY291bnRXYXNtSGFzaCA9ICcnLFxyXG4gIHJvdXRlckFkZHIgPSAnJ1xyXG4pIHtcclxuICBpZiAoIXZhdWx0QWRkcikgcmV0dXJuXHJcbiAgY29uc3Qgb3BzID0gaW5uZXIub3BlcmF0aW9ucyB8fCBbXVxyXG4gIGlmIChvcHMubGVuZ3RoICE9PSAxIHx8IG9wc1swXS50eXBlICE9PSAnaW52b2tlSG9zdEZ1bmN0aW9uJykge1xyXG4gICAgdGhyb3cgbmV3IFJlbGF5RXJyb3IoJ3JlbGF5IHNwb25zb3JzIGEgc2luZ2xlIGNvbnRyYWN0IGludm9jYXRpb24gb25seScpXHJcbiAgfVxyXG4gIGNvbnN0IGhmID0gb3BzWzBdLmZ1bmNcclxuICBjb25zdCBraW5kID0gaGYuc3dpdGNoKCkubmFtZVxyXG4gIGlmIChraW5kID09PSAnaG9zdEZ1bmN0aW9uVHlwZUNyZWF0ZUNvbnRyYWN0VjInKSB7XHJcbiAgICBjb25zdCBleGVjID0gaGYuY3JlYXRlQ29udHJhY3RWMigpLmV4ZWN1dGFibGUoKVxyXG4gICAgY29uc3QgaXNQaW5uZWRXYXNtID1cclxuICAgICAgYWNjb3VudFdhc21IYXNoICYmXHJcbiAgICAgIGV4ZWMuc3dpdGNoKCkubmFtZSA9PT0gJ2NvbnRyYWN0RXhlY3V0YWJsZVdhc20nICYmXHJcbiAgICAgIGV4ZWMud2FzbUhhc2goKS50b1N0cmluZygnaGV4JykgPT09IGFjY291bnRXYXNtSGFzaFxyXG4gICAgaWYgKCFpc1Bpbm5lZFdhc20pIHtcclxuICAgICAgdGhyb3cgbmV3IFJlbGF5RXJyb3IoJ3JlbGF5IHNwb25zb3JzIHNtYXJ0LWFjY291bnQgZGVwbG95cyBvZiB0aGUgcGlubmVkIHdhc20gb25seScpXHJcbiAgICB9XHJcbiAgICByZXR1cm5cclxuICB9XHJcbiAgaWYgKGtpbmQgIT09ICdob3N0RnVuY3Rpb25UeXBlSW52b2tlQ29udHJhY3QnKSB7XHJcbiAgICB0aHJvdyBuZXcgUmVsYXlFcnJvcignaW5uZXIgb3AgaXMgbm90IGEgY29udHJhY3QgaW52b2NhdGlvbicpXHJcbiAgfVxyXG4gIGNvbnN0IGljID0gaGYuaW52b2tlQ29udHJhY3QoKVxyXG4gIGNvbnN0IGNvbnRyYWN0ID0gc2RrLkFkZHJlc3MuZnJvbVNjQWRkcmVzcyhpYy5jb250cmFjdEFkZHJlc3MoKSkudG9TdHJpbmcoKVxyXG4gIGNvbnN0IGZuTmFtZSA9IGljLmZ1bmN0aW9uTmFtZSgpLnRvU3RyaW5nKClcclxuICBpZiAoY29udHJhY3QgPT09IHZhdWx0QWRkcikge1xyXG4gICAgaWYgKGZuTmFtZSAhPT0gJ2RlcG9zaXQnICYmIGZuTmFtZSAhPT0gJ3JlZGVlbScpIHtcclxuICAgICAgdGhyb3cgbmV3IFJlbGF5RXJyb3IoJ2lubmVyIHR4IGlzIG5vdCBhIHZhdWx0IGRlcG9zaXQvcmVkZWVtJylcclxuICAgIH1cclxuICAgIHJldHVyblxyXG4gIH1cclxuICBpZiAocm91dGVyQWRkciAmJiBjb250cmFjdCA9PT0gcm91dGVyQWRkcikge1xyXG4gICAgaWYgKGZuTmFtZSAhPT0gJ2dyYW50JyAmJiBmbk5hbWUgIT09ICdwdWxsJykge1xyXG4gICAgICB0aHJvdyBuZXcgUmVsYXlFcnJvcignaW5uZXIgdHggaXMgbm90IGEgcm91dGVyIGdyYW50L3B1bGwnKVxyXG4gICAgfVxyXG4gICAgcmV0dXJuXHJcbiAgfVxyXG4gIGlmICh0b2tlbkFkZHIgJiYgY29udHJhY3QgPT09IHRva2VuQWRkciAmJiBmbk5hbWUgPT09ICd0cmFuc2ZlcicpIHtcclxuICAgIGNvbnN0IGZyb20gPSBzZGsuQWRkcmVzcy5mcm9tU2NWYWwoaWMuYXJncygpWzBdKS50b1N0cmluZygpXHJcbiAgICBpZiAoIXBhcnNlQWxsb3dsaXN0KGFnZW50QWxsb3dsaXN0KS5pbmNsdWRlcyhmcm9tKSkge1xyXG4gICAgICB0aHJvdyBuZXcgUmVsYXlFcnJvcigncmVsYXkgc3BvbnNvcnMgYWxsb3dsaXN0ZWQgYWdlbnQtYWNjb3VudCB0cmFuc2ZlcnMgb25seScpXHJcbiAgICB9XHJcbiAgICByZXR1cm5cclxuICB9XHJcbiAgdGhyb3cgbmV3IFJlbGF5RXJyb3IoJ2lubmVyIHR4IGRvZXMgbm90IHRhcmdldCB0aGUgdmF1bHQnKVxyXG59XHJcblxyXG4vKiogUG9sbCBnZXRUcmFuc2FjdGlvbiB1bnRpbCBpdCBsZWF2ZXMgTk9UX0ZPVU5ELCBvciB0aGUgYnVkZ2V0IGlzIHNwZW50LiAqL1xyXG5hc3luYyBmdW5jdGlvbiBwb2xsUmVzdWx0KHJwY1NlcnZlciwgaGFzaCwgdHJpZXMsIGludGVydmFsTXMpIHtcclxuICBmb3IgKGxldCBpID0gMDsgaSA8IHRyaWVzOyBpKyspIHtcclxuICAgIGNvbnN0IHIgPSBhd2FpdCBycGNTZXJ2ZXIuZ2V0VHJhbnNhY3Rpb24oaGFzaClcclxuICAgIGlmIChyLnN0YXR1cyAmJiByLnN0YXR1cyAhPT0gJ05PVF9GT1VORCcpIHJldHVybiByXHJcbiAgICBpZiAoaW50ZXJ2YWxNcykgYXdhaXQgbmV3IFByb21pc2UoKHJlcykgPT4gc2V0VGltZW91dChyZXMsIGludGVydmFsTXMpKVxyXG4gIH1cclxuICByZXR1cm4geyBzdGF0dXM6ICdQRU5ESU5HJyB9IC8vIHN1Ym1pdHRlZCBidXQgbm90IHlldCBvYnNlcnZlZCBcdTIwMTQgY2xpZW50IG1heSBrZWVwIHBvbGxpbmdcclxufVxyXG5cclxuLyoqXHJcbiAqIEZlZS1idW1wIGFuIGFnZW50LXNpZ25lZCBpbm5lciBTb3JvYmFuIHR4IGFuZCBzdWJtaXQgaXQuIFBheXMgdGhlIGZlZSBmcm9tIGBzZWNyZXRgLlxyXG4gKiBAcGFyYW0ge29iamVjdH0gcFxyXG4gKiBAcGFyYW0ge3N0cmluZ30gcC54ZHIgICAgICAgICAgICBiYXNlNjQgaW5uZXItdHggZW52ZWxvcGUgKGFnZW50LWF1dGggc2lnbmVkKVxyXG4gKiBAcGFyYW0ge3N0cmluZ30gcC5zZWNyZXQgICAgICAgICByZWxheWVyIFMuLi4gc2VjcmV0XHJcbiAqIEBwYXJhbSB7c3RyaW5nfSBwLnBhc3NwaHJhc2UgICAgIG5ldHdvcmsgcGFzc3BocmFzZVxyXG4gKiBAcGFyYW0ge3N0cmluZ30gcC52YXVsdEFkZHIgICAgICBhbGxvd2xpc3RlZCBkZXBvc2l0IHRhcmdldCAoJycgPSBza2lwIHRoZSBndWFyZClcclxuICogQHBhcmFtIHtzdHJpbmd9IHAuYWdlbnRBbGxvd2xpc3QgY29tbWEtc2VwYXJhdGVkIGFnZW50IGFjY291bnRzIGFsbG93ZWQgYXMgdHJhbnNmZXIgJ2Zyb20nXHJcbiAqIEBwYXJhbSB7c3RyaW5nfSBwLnJvdXRlckFkZHIgICAgIGZ1bmRpbmdfcm91dGVyIGFsbG93ZWQgZm9yIGdyYW50L3B1bGwgKCcnID0gcm91dGVyIGRpc2FibGVkKVxyXG4gKiBAcGFyYW0ge29iamVjdH0gcC5zZGsgICAgICAgICAgICB7IFRyYW5zYWN0aW9uQnVpbGRlciwgRmVlQnVtcFRyYW5zYWN0aW9uLCBLZXlwYWlyLCBBZGRyZXNzIH1cclxuICogQHBhcmFtIHtvYmplY3R9IHAucnBjU2VydmVyICAgICAgeyBzZW5kVHJhbnNhY3Rpb24sIGdldFRyYW5zYWN0aW9uIH1cclxuICogQHJldHVybnMge1Byb21pc2U8eyBoYXNoLCBzdGF0dXMsIHJlbGF5ZXIgfT59XHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmVlQnVtcEFuZFN1Ym1pdCh7XHJcbiAgeGRyLFxyXG4gIHNlY3JldCxcclxuICBwYXNzcGhyYXNlLFxyXG4gIHZhdWx0QWRkcixcclxuICB0b2tlbkFkZHIgPSAnJyxcclxuICBhZ2VudEFsbG93bGlzdCA9ICcnLFxyXG4gIGFjY291bnRXYXNtSGFzaCA9ICcnLFxyXG4gIHJvdXRlckFkZHIgPSAnJyxcclxuICBzZGssXHJcbiAgcnBjU2VydmVyLFxyXG4gIHBvbGxUcmllcyA9IDEwLFxyXG4gIHBvbGxJbnRlcnZhbE1zID0gMjAwMCxcclxufSkge1xyXG4gIGNvbnN0IHsgVHJhbnNhY3Rpb25CdWlsZGVyLCBGZWVCdW1wVHJhbnNhY3Rpb24sIEtleXBhaXIgfSA9IHNka1xyXG5cclxuICBjb25zdCBpbm5lciA9IFRyYW5zYWN0aW9uQnVpbGRlci5mcm9tWERSKHhkciwgcGFzc3BocmFzZSlcclxuICBpZiAoaW5uZXIgaW5zdGFuY2VvZiBGZWVCdW1wVHJhbnNhY3Rpb24pIHtcclxuICAgIHRocm93IG5ldyBSZWxheUVycm9yKCdpbm5lciB0eCBpcyBhbHJlYWR5IGZlZS1idW1wZWQnKVxyXG4gIH1cclxuICBhc3NlcnRWYXVsdERlcG9zaXQoaW5uZXIsIHZhdWx0QWRkciwgc2RrLCB0b2tlbkFkZHIsIGFnZW50QWxsb3dsaXN0LCBhY2NvdW50V2FzbUhhc2gsIHJvdXRlckFkZHIpXHJcblxyXG4gIC8vIFJlcGxheSBzaG9ydC1jaXJjdWl0IChkb24ndCBwYXkgdG8gcmUtYnJvYWRjYXN0IGEgc3BlbnQgaW5uZXIgdHgpLlxyXG4gIGNvbnN0IGlubmVySGFzaCA9IGlubmVyLmhhc2goKS50b1N0cmluZygnaGV4JylcclxuICBjb25zdCBub3cgPSBEYXRlLm5vdygpXHJcbiAgaWYgKF9zZWVuLnNpemUgPiBTRUVOX01BWCkgcHJ1bmVTZWVuKG5vdylcclxuICBjb25zdCBwcmV2ID0gX3NlZW4uZ2V0KGlubmVySGFzaClcclxuICBpZiAocHJldikge1xyXG4gICAgaWYgKHByZXYuc3RhdGUgPT09ICdkb25lJykgcmV0dXJuIHsgLi4ucHJldi5vdXQsIHN0YXR1czogJ2R1cGxpY2F0ZScgfVxyXG4gICAgdGhyb3cgbmV3IFJlbGF5RXJyb3IoJ2lubmVyIHR4IGFscmVhZHkgaW4gZmxpZ2h0JylcclxuICB9XHJcbiAgX3NlZW4uc2V0KGlubmVySGFzaCwgeyBzdGF0ZTogJ2luLWZsaWdodCcsIGF0OiBub3cgfSlcclxuXHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGtwID0gS2V5cGFpci5mcm9tU2VjcmV0KHNlY3JldClcclxuICAgIC8vIEFnZW50LWRlcG9zaXQgcGF0aDogdGhlIGlubmVyIHR4J3Mgc291cmNlIElTIHRoZSByZWxheWVyICh0aGUgY2xpZW50IGNhbm5vdCBzaWduIGFzIHRoZVxyXG4gICAgLy8gcmVsYXllciksIHNvIHRoZSByZWxheSBzaWducyB0aGUgaW5uZXIgZW52ZWxvcGUgaGVyZS4gVGhpcyBpcyB0eC1sZXZlbCBzb3VyY2Uvc2VxdWVuY2UgYXV0aFxyXG4gICAgLy8gb25seSBcdTIwMTQgdGhlIGRlcG9zaXQgaXRzZWxmIGlzIHN0aWxsIGF1dGhvcml6ZWQgYnkgdGhlIGFnZW50IGN1c3RvbSBhY2NvdW50J3MgX19jaGVja19hdXRoXHJcbiAgICAvLyBTb3JvYmFuIGF1dGggZW50cnkgKHNlc3Npb24ta2V5IHNpZ25lZCwgY2xpZW50LXNpZGUpLCBhbmQgdGhlIHZhdWx0LmRlcG9zaXQgYWxsb3dsaXN0XHJcbiAgICAvLyBhbHJlYWR5IGJvdW5kcyB3aGF0IHRoZSByZWxheWVyIHdpbGwgc3BvbnNvci4gV2hlbiB0aGUgaW5uZXIgc291cmNlIGRpZmZlcnMgKGEgc2VwYXJhdGVcclxuICAgIC8vIGZ1bmRlZCBzb3VyY2UsIGUuZy4gdGhlIHJlbGF5IHNtb2tlKSwgdGhlIGNsaWVudCBhbHJlYWR5IHNpZ25lZCBpdCBcdTIwMTQgbGVhdmUgaXQgdW50b3VjaGVkLlxyXG4gICAgaWYgKGlubmVyLnNvdXJjZSA9PT0ga3AucHVibGljS2V5KCkpIGlubmVyLnNpZ24oa3ApXHJcbiAgICBjb25zdCBiYXNlRmVlID0gKEJpZ0ludChpbm5lci5mZWUpICsgRkVFX01BUkdJTikudG9TdHJpbmcoKVxyXG4gICAgY29uc3QgZmVlQnVtcCA9IFRyYW5zYWN0aW9uQnVpbGRlci5idWlsZEZlZUJ1bXBUcmFuc2FjdGlvbihrcCwgYmFzZUZlZSwgaW5uZXIsIHBhc3NwaHJhc2UpXHJcbiAgICBmZWVCdW1wLnNpZ24oa3ApXHJcblxyXG4gICAgY29uc3Qgc2VuZCA9IGF3YWl0IHJwY1NlcnZlci5zZW5kVHJhbnNhY3Rpb24oZmVlQnVtcClcclxuICAgIGlmIChzZW5kLnN0YXR1cyA9PT0gJ0VSUk9SJykge1xyXG4gICAgICB0aHJvdyBuZXcgUmVsYXlFcnJvcignUlBDIHJlamVjdGVkIHRoZSBmZWUtYnVtcCBzdWJtaXNzaW9uJylcclxuICAgIH1cclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvbGxSZXN1bHQocnBjU2VydmVyLCBzZW5kLmhhc2gsIHBvbGxUcmllcywgcG9sbEludGVydmFsTXMpXHJcbiAgICBjb25zdCBvdXQgPSB7IGhhc2g6IHNlbmQuaGFzaCwgc3RhdHVzOiByZXN1bHQuc3RhdHVzLCByZWxheWVyOiBrcC5wdWJsaWNLZXkoKSB9XHJcbiAgICBfc2Vlbi5zZXQoaW5uZXJIYXNoLCB7IHN0YXRlOiAnZG9uZScsIG91dCwgYXQ6IERhdGUubm93KCkgfSlcclxuICAgIHJldHVybiBvdXRcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBfc2Vlbi5kZWxldGUoaW5uZXJIYXNoKSAvLyBmYWlsZWQgc3VibWl0IFx1MjE5MiBhbGxvdyBhIGdlbnVpbmUgcmV0cnkgb2YgdGhpcyBpbm5lciB0eFxyXG4gICAgdGhyb3cgZVxyXG4gIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVhZEJvZHkocmVxKSB7XHJcbiAgaWYgKHJlcS5ib2R5ICYmIHR5cGVvZiByZXEuYm9keSA9PT0gJ29iamVjdCcpIHJldHVybiByZXEuYm9keVxyXG4gIGNvbnN0IGNodW5rcyA9IFtdXHJcbiAgZm9yIGF3YWl0IChjb25zdCBjIG9mIHJlcSkgY2h1bmtzLnB1c2goYylcclxuICBjb25zdCByYXcgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoJ3V0ZjgnKVxyXG4gIHJldHVybiByYXcgPyBKU09OLnBhcnNlKHJhdykgOiB7fVxyXG59XHJcblxyXG5mdW5jdGlvbiBiYWQocmVzLCBtc2cpIHtcclxuICByZXMuc3RhdHVzQ29kZSA9IDQwMFxyXG4gIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IG1zZyB9KSlcclxufVxyXG5cclxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihyZXEsIHJlcykge1xyXG4gIGlmIChyZXEubWV0aG9kICE9PSAnUE9TVCcpIHtcclxuICAgIHJlcy5zdGF0dXNDb2RlID0gNDA1XHJcbiAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWV0aG9kIG5vdCBhbGxvd2VkJyB9KSlcclxuICB9XHJcbiAgaWYgKCFhcHBseUNvcnMocmVxLCByZXMpKSByZXR1cm5cclxuICBpZiAoIXJhdGVMaW1pdChyZXEsIHJlcywgeyBtYXg6IDE1LCB3aW5kb3dNczogNjBfMDAwLCBidWNrZXQ6ICdzdGVsbGFyLXJlbGF5JyB9KSkgcmV0dXJuXHJcbiAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKVxyXG5cclxuICBjb25zdCBzZWNyZXQgPSBSRUxBWUVSX1NFQ1JFVCgpXHJcbiAgaWYgKCFzZWNyZXQpIHtcclxuICAgIHJlcy5zdGF0dXNDb2RlID0gNTAzXHJcbiAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnU3RlbGxhciByZWxheSBub3QgY29uZmlndXJlZCcsIGNvbmZpZ3VyZWQ6IGZhbHNlIH0pKVxyXG4gIH1cclxuXHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQm9keShyZXEpXHJcbiAgICAvLyBEeW5hbWljIGltcG9ydCBzbyBhIG1pc3NpbmcgcGFja2FnZSBuZXZlciBicmVha3MgdGhlIHZpdGUuY29uZmlnIGxvYWQuXHJcbiAgICBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQoJ0BzdGVsbGFyL3N0ZWxsYXItc2RrJylcclxuICAgIGNvbnN0IHNkayA9IHtcclxuICAgICAgVHJhbnNhY3Rpb25CdWlsZGVyOiBtb2QuVHJhbnNhY3Rpb25CdWlsZGVyLFxyXG4gICAgICBGZWVCdW1wVHJhbnNhY3Rpb246IG1vZC5GZWVCdW1wVHJhbnNhY3Rpb24sXHJcbiAgICAgIEtleXBhaXI6IG1vZC5LZXlwYWlyLFxyXG4gICAgICBBZGRyZXNzOiBtb2QuQWRkcmVzcyxcclxuICAgIH1cclxuXHJcbiAgICBpZiAoYm9keS5hY3Rpb24gPT09ICd3YWxsZXQnKSB7XHJcbiAgICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgYWRkcmVzczogbW9kLktleXBhaXIuZnJvbVNlY3JldChzZWNyZXQpLnB1YmxpY0tleSgpIH0pKVxyXG4gICAgfVxyXG5cclxuICAgIC8vIFNBSydzIFJlbGF5ZXJDbGllbnQuc2VuZFhkciAoa2l0LmNyZWF0ZVdhbGxldCBhdXRvU3VibWl0KSBwb3N0cyBhIGJhcmUgeyB4ZHIgfSB3aXRoIG5vXHJcbiAgICAvLyBhY3Rpb24gZmllbGQgXHUyMDE0IHRyZWF0IGl0IGFzIGEgc3VibWl0LiBUaGUgZ3VhcmQgaW5zaWRlIGZlZUJ1bXBBbmRTdWJtaXQgc3RpbGwgYXBwbGllczpcclxuICAgIC8vIG9ubHkgdGhlIHBpbm5lZCBzbWFydC1hY2NvdW50IGRlcGxveSBvciB0aGUgdmF1bHQvdG9rZW4gYWxsb3dsaXN0IGdldHMgc3BvbnNvcmVkLlxyXG4gICAgaWYgKGJvZHkuYWN0aW9uID09PSAnc3VibWl0JyB8fCAoIWJvZHkuYWN0aW9uICYmIHR5cGVvZiBib2R5LnhkciA9PT0gJ3N0cmluZycpKSB7XHJcbiAgICAgIGlmICh0eXBlb2YgYm9keS54ZHIgIT09ICdzdHJpbmcnIHx8ICFib2R5LnhkcikgcmV0dXJuIGJhZChyZXMsICdJbnZhbGlkIHhkcicpXHJcbiAgICAgIGNvbnN0IHJwY1NlcnZlciA9IG5ldyBtb2QucnBjLlNlcnZlcihSUENfVVJMKCkpXHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3Qgb3V0ID0gYXdhaXQgZmVlQnVtcEFuZFN1Ym1pdCh7XHJcbiAgICAgICAgICB4ZHI6IGJvZHkueGRyLFxyXG4gICAgICAgICAgc2VjcmV0LFxyXG4gICAgICAgICAgcGFzc3BocmFzZTogUEFTU1BIUkFTRSgpLFxyXG4gICAgICAgICAgdmF1bHRBZGRyOiBWQVVMVF9BRERSKCksXHJcbiAgICAgICAgICB0b2tlbkFkZHI6IFRPS0VOX0FERFIoKSxcclxuICAgICAgICAgIGFnZW50QWxsb3dsaXN0OiBBR0VOVF9BTExPV0xJU1QoKSxcclxuICAgICAgICAgIGFjY291bnRXYXNtSGFzaDogQUNDT1VOVF9XQVNNX0hBU0goKSxcclxuICAgICAgICAgIHJvdXRlckFkZHI6IFJPVVRFUl9BRERSKCksXHJcbiAgICAgICAgICBzZGssXHJcbiAgICAgICAgICBycGNTZXJ2ZXIsXHJcbiAgICAgICAgfSlcclxuICAgICAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeShvdXQpKVxyXG4gICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgaWYgKGUgaW5zdGFuY2VvZiBSZWxheUVycm9yICYmIC9pbiBmbGlnaHQvLnRlc3QoZS5tZXNzYWdlKSkge1xyXG4gICAgICAgICAgcmVzLnN0YXR1c0NvZGUgPSA0MDlcclxuICAgICAgICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IGUubWVzc2FnZSB9KSlcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhyb3cgZVxyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIGJhZChyZXMsICdVbmtub3duIGFjdGlvbicpXHJcbiAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKCdbYXBpL3N0ZWxsYXItcmVsYXldIGVycm9yOicsIGVycj8ubWVzc2FnZSB8fCBlcnIpXHJcbiAgICByZXMuc3RhdHVzQ29kZSA9IDUwMlxyXG4gICAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1N0ZWxsYXIgcmVsYXkgZmFpbGVkJyB9KSlcclxuICB9XHJcbn1cclxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmRcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC92aXRlLmNvbmZpZy5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvdml0ZS5jb25maWcuanNcIjtpbXBvcnQgcGF0aCBmcm9tICdub2RlOnBhdGgnXHJcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tICdub2RlOnVybCdcclxuaW1wb3J0IHsgZGVmaW5lQ29uZmlnLCBsb2FkRW52IH0gZnJvbSAndml0ZSdcclxuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0J1xyXG5pbXBvcnQgYWlQcm94eSBmcm9tICcuL2FwaS9haS5qcydcclxuaW1wb3J0IHNlYXJjaFByb3h5IGZyb20gJy4vYXBpL3NlYXJjaC5qcydcclxuaW1wb3J0IHN0ZWxsYXJSZWxheVByb3h5IGZyb20gJy4vYXBpL3N0ZWxsYXItcmVsYXkuanMnXHJcbmltcG9ydCBmYXVjZXRQcm94eSBmcm9tICcuL2FwaS9mYXVjZXQuanMnXHJcbmltcG9ydCB2ZlJvdXRlciBmcm9tICcuL2FwaS92Zi9fcm91dGVyLmpzJ1xyXG5pbXBvcnQgb25yYW1wU2Vzc2lvblByb3h5IGZyb20gJy4vYXBpL29ucmFtcC1zZXNzaW9uLmpzJ1xyXG5cclxuLy8gUmVwbyByb290IChwYXJlbnQgb2YgZnJvbnRlbmQvKSBcdTIwMTQgbmVlZGVkIGJlbG93IHNvIHRoZSBkZXYgc2VydmVyJ3MgZnMuYWxsb3cgYm91bmRhcnkgY292ZXJzXHJcbi8vIGZyb250ZW5kL3NyYy9zdGVsbGFyL3ZhdWx0UmVhZHMuanMncyBjcm9zcy1wYWNrYWdlIGltcG9ydCBvZiBrZWVwZXIvc3JjL2Fwci5qcy5cclxuY29uc3QgcmVwb1Jvb3QgPSBwYXRoLnJlc29sdmUocGF0aC5kaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSksICcuLicpXHJcblxyXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoKHsgbW9kZSB9KSA9PiB7XHJcbiAgY29uc3QgZW52ID0gbG9hZEVudihtb2RlLCBwcm9jZXNzLmN3ZCgpLCAnJykgLy8gYWxsIHZhcnMgKGluY2wuIG5vbi1WSVRFIHNlcnZlci1zaWRlKVxyXG4gIGlmIChlbnYuREVFUFNFRUtfQVBJX0tFWSkgcHJvY2Vzcy5lbnYuREVFUFNFRUtfQVBJX0tFWSA9IGVudi5ERUVQU0VFS19BUElfS0VZXHJcbiAgaWYgKGVudi5UQVZJTFlfQVBJX0tFWSkgcHJvY2Vzcy5lbnYuVEFWSUxZX0FQSV9LRVkgPSBlbnYuVEFWSUxZX0FQSV9LRVlcclxuICBpZiAoZW52LkFMTE9XRURfT1JJR0lOKSBwcm9jZXNzLmVudi5BTExPV0VEX09SSUdJTiA9IGVudi5BTExPV0VEX09SSUdJTlxyXG5cclxuICAvLyBTb3JvYmFuIGdhc2xlc3MgcmVsYXkgKHN1Yi1wcm9qZWN0IDIpIFx1MjAxNCBzZXJ2ZXItc2lkZSBvbmx5LCBuZXZlciBpbiB0aGUgY2xpZW50IGJ1bmRsZS5cclxuICBpZiAoZW52LlNURUxMQVJfUkVMQVlFUl9TRUNSRVQpIHByb2Nlc3MuZW52LlNURUxMQVJfUkVMQVlFUl9TRUNSRVQgPSBlbnYuU1RFTExBUl9SRUxBWUVSX1NFQ1JFVFxyXG4gIGlmIChlbnYuU09ST0JBTl9SUENfVVJMKSBwcm9jZXNzLmVudi5TT1JPQkFOX1JQQ19VUkwgPSBlbnYuU09ST0JBTl9SUENfVVJMXHJcbiAgaWYgKGVudi5TVEVMTEFSX05FVFdPUktfUEFTU1BIUkFTRSlcclxuICAgIHByb2Nlc3MuZW52LlNURUxMQVJfTkVUV09SS19QQVNTUEhSQVNFID0gZW52LlNURUxMQVJfTkVUV09SS19QQVNTUEhSQVNFXHJcbiAgaWYgKGVudi5TT1JPQkFOX1ZBVUxUX0FERFJFU1MpIHByb2Nlc3MuZW52LlNPUk9CQU5fVkFVTFRfQUREUkVTUyA9IGVudi5TT1JPQkFOX1ZBVUxUX0FERFJFU1NcclxuICBpZiAoZW52LlZGX0ZBVUNFVF9TRUNSRVQpIHByb2Nlc3MuZW52LlZGX0ZBVUNFVF9TRUNSRVQgPSBlbnYuVkZfRkFVQ0VUX1NFQ1JFVFxyXG4gIGlmIChlbnYuU09ST0JBTl9UT0tFTl9BRERSRVNTKSBwcm9jZXNzLmVudi5TT1JPQkFOX1RPS0VOX0FERFJFU1MgPSBlbnYuU09ST0JBTl9UT0tFTl9BRERSRVNTXHJcbiAgaWYgKGVudi5TT1JPQkFOX0FHRU5UX0FMTE9XTElTVCkgcHJvY2Vzcy5lbnYuU09ST0JBTl9BR0VOVF9BTExPV0xJU1QgPSBlbnYuU09ST0JBTl9BR0VOVF9BTExPV0xJU1RcclxuICAvLyBmdW5kaW5nX3JvdXRlciAob25lLXBvcHVwIGdyYW50KSBcdTIwMTQgdGhlIHJlbGF5IGd1YXJkIGFsbG93bGlzdHMgZ3JhbnQvcHVsbCBvbiB0aGlzIGFkZHJlc3Mgb25seS5cclxuICAvLyBGYWlsLWNsb3NlZCBpZiBhYnNlbnQ6IHdpdGhvdXQgdGhlIHBhc3N0aHJvdWdoIHRoZSBkZXYtc2VydmVyIHJlbGF5IHJlZnVzZXMgZXZlcnkgcm91dGVyIGNhbGwuXHJcbiAgaWYgKGVudi5TT1JPQkFOX1JPVVRFUl9BRERSRVNTKSBwcm9jZXNzLmVudi5TT1JPQkFOX1JPVVRFUl9BRERSRVNTID0gZW52LlNPUk9CQU5fUk9VVEVSX0FERFJFU1NcclxuXHJcbiAgLy8gVkYgQVBJIGdhdGUgKFNFUC0xMCBwb3J0YWwgKyBnYXRld2F5KSBcdTIwMTQgc2VydmVyLXNpZGUgb25seSwgbmV2ZXIgaW4gdGhlIGNsaWVudCBidW5kbGUuXHJcbiAgaWYgKGVudi5WRl9BVVRIX1NJR05JTkdfS0VZKSBwcm9jZXNzLmVudi5WRl9BVVRIX1NJR05JTkdfS0VZID0gZW52LlZGX0FVVEhfU0lHTklOR19LRVlcclxuICBpZiAoZW52LlZGX0pXVF9TRUNSRVQpIHByb2Nlc3MuZW52LlZGX0pXVF9TRUNSRVQgPSBlbnYuVkZfSldUX1NFQ1JFVFxyXG4gIGlmIChlbnYuVkZfSE9NRV9ET01BSU4pIHByb2Nlc3MuZW52LlZGX0hPTUVfRE9NQUlOID0gZW52LlZGX0hPTUVfRE9NQUlOXHJcbiAgaWYgKGVudi5WRl9HTE9CQUxfREFJTFlfQ0FQKSBwcm9jZXNzLmVudi5WRl9HTE9CQUxfREFJTFlfQ0FQID0gZW52LlZGX0dMT0JBTF9EQUlMWV9DQVBcclxuICBpZiAoZW52LlZGX1ZBVUxUX0NBVEFMT0cpIHByb2Nlc3MuZW52LlZGX1ZBVUxUX0NBVEFMT0cgPSBlbnYuVkZfVkFVTFRfQ0FUQUxPR1xyXG5cclxuICAvLyBPbi1yYW1wIHdpZGdldCAoU1A0KSBcdTIwMTQgc2VydmVyLXNpZGUgb25seSwgbmV2ZXIgaW4gdGhlIGNsaWVudCBidW5kbGUuXHJcbiAgaWYgKGVudi5UUkFOU0FLX0FQSV9LRVkpIHByb2Nlc3MuZW52LlRSQU5TQUtfQVBJX0tFWSA9IGVudi5UUkFOU0FLX0FQSV9LRVlcclxuICBpZiAoZW52LlRSQU5TQUtfQUNDRVNTX1RPS0VOKSBwcm9jZXNzLmVudi5UUkFOU0FLX0FDQ0VTU19UT0tFTiA9IGVudi5UUkFOU0FLX0FDQ0VTU19UT0tFTlxyXG4gIGlmIChlbnYuVFJBTlNBS19FTlZJUk9OTUVOVCkgcHJvY2Vzcy5lbnYuVFJBTlNBS19FTlZJUk9OTUVOVCA9IGVudi5UUkFOU0FLX0VOVklST05NRU5UXHJcbiAgaWYgKGVudi5UUkFOU0FLX1JFRkVSUkVSX0RPTUFJTikgcHJvY2Vzcy5lbnYuVFJBTlNBS19SRUZFUlJFUl9ET01BSU4gPSBlbnYuVFJBTlNBS19SRUZFUlJFUl9ET01BSU5cclxuXHJcbiAgY29uc3QgYXBpUHJveHlQbHVnaW4gPSB7XHJcbiAgICBuYW1lOiAnYXBpLXByb3h5JyxcclxuICAgIGNvbmZpZ3VyZVNlcnZlcihzKSB7XHJcbiAgICAgIHMubWlkZGxld2FyZXMudXNlKCcvYXBpL3ZmJywgdmZSb3V0ZXIpXHJcbiAgICAgIHMubWlkZGxld2FyZXMudXNlKCcvYXBpL2FpJywgYWlQcm94eSlcclxuICAgICAgcy5taWRkbGV3YXJlcy51c2UoJy9hcGkvc2VhcmNoJywgc2VhcmNoUHJveHkpXHJcbiAgICAgIHMubWlkZGxld2FyZXMudXNlKCcvYXBpL3N0ZWxsYXItcmVsYXknLCBzdGVsbGFyUmVsYXlQcm94eSlcclxuICAgICAgcy5taWRkbGV3YXJlcy51c2UoJy9hcGkvZmF1Y2V0JywgZmF1Y2V0UHJveHkpXHJcbiAgICAgIHMubWlkZGxld2FyZXMudXNlKCcvYXBpL29ucmFtcC1zZXNzaW9uJywgb25yYW1wU2Vzc2lvblByb3h5KVxyXG4gICAgfSxcclxuICAgIGNvbmZpZ3VyZVByZXZpZXdTZXJ2ZXIocykge1xyXG4gICAgICBzLm1pZGRsZXdhcmVzLnVzZSgnL2FwaS92ZicsIHZmUm91dGVyKVxyXG4gICAgICBzLm1pZGRsZXdhcmVzLnVzZSgnL2FwaS9haScsIGFpUHJveHkpXHJcbiAgICAgIHMubWlkZGxld2FyZXMudXNlKCcvYXBpL3NlYXJjaCcsIHNlYXJjaFByb3h5KVxyXG4gICAgICBzLm1pZGRsZXdhcmVzLnVzZSgnL2FwaS9zdGVsbGFyLXJlbGF5Jywgc3RlbGxhclJlbGF5UHJveHkpXHJcbiAgICAgIHMubWlkZGxld2FyZXMudXNlKCcvYXBpL2ZhdWNldCcsIGZhdWNldFByb3h5KVxyXG4gICAgICBzLm1pZGRsZXdhcmVzLnVzZSgnL2FwaS9vbnJhbXAtc2Vzc2lvbicsIG9ucmFtcFNlc3Npb25Qcm94eSlcclxuICAgIH0sXHJcbiAgfVxyXG5cclxuICByZXR1cm4ge1xyXG4gICAgcGx1Z2luczogW3JlYWN0KCksIGFwaVByb3h5UGx1Z2luXSxcclxuICAgIHJvb3Q6ICcuJyxcclxuICAgIGJ1aWxkOiB7XHJcbiAgICAgIG91dERpcjogJ2Rpc3QnLFxyXG4gICAgICByb2xsdXBPcHRpb25zOiB7XHJcbiAgICAgICAgZXh0ZXJuYWw6IFtdLFxyXG4gICAgICAgIG91dHB1dDoge1xyXG4gICAgICAgICAgbWFudWFsQ2h1bmtzKGlkKSB7XHJcbiAgICAgICAgICAgIGlmICghaWQuaW5jbHVkZXMoJ25vZGVfbW9kdWxlcycpKSByZXR1cm5cclxuICAgICAgICAgICAgLy8gU3BsaXQgb25seSB0aGUgaGVhdnksIHNlbGYtY29udGFpbmVkIG1vdGlvbiBjbHVzdGVyLiBUaGUgZm9yY2UtZ3JhcGggY2x1c3RlclxyXG4gICAgICAgICAgICAvLyAocmVhY3QtZm9yY2UtZ3JhcGggLT4ga2Fwc3VsZSAtPiBmb3JjZS1ncmFwaCAtPiBkMy0qKSBwbHVzIFJlYWN0IGFyZSBsZWZ0IHRvXHJcbiAgICAgICAgICAgIC8vIFJvbGx1cCdzIGF1dG9tYXRpYyBjaHVua2luZzogaGFuZC1jdXQgJ2dyYXBoJyB2cyBjYXRjaC1hbGwgJ3ZlbmRvcicgY2h1bmtzIGZvcm1lZCBhXHJcbiAgICAgICAgICAgIC8vIGdyYXBoPC0+dmVuZG9yIGltcG9ydCBjeWNsZSwgd2hpY2ggY3Jhc2hlZCBhdCBydW50aW1lIHdpdGggYSBURFogUmVmZXJlbmNlRXJyb3JcclxuICAgICAgICAgICAgLy8gKFwiQ2Fubm90IGFjY2VzcyAnem4nIGJlZm9yZSBpbml0aWFsaXphdGlvblwiKS4gQXV0by1jaHVua2luZyBrZWVwcyBmb3JjZS1ncmFwaCBpbiB0aGVcclxuICAgICAgICAgICAgLy8gbGF6eSByb3V0ZSBjaHVua3MgdGhhdCBpbXBvcnQgaXQgYW5kIG9yZGVycyBpbml0aWFsaXplcnMgY29ycmVjdGx5LlxyXG4gICAgICAgICAgICBpZiAoaWQuaW5jbHVkZXMoJ2ZyYW1lci1tb3Rpb24nKSkgcmV0dXJuICdtb3Rpb24nXHJcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWRcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgICBzZXJ2ZXI6IHtcclxuICAgICAgaGlzdG9yeUFwaUZhbGxiYWNrOiB0cnVlLFxyXG4gICAgICAvLyBmcm9udGVuZC9zcmMvc3RlbGxhci92YXVsdFJlYWRzLmpzIGltcG9ydHMga2VlcGVyL3NyYy9hcHIuanMgdmlhIGEgcmVsYXRpdmUgY3Jvc3MtcGFja2FnZVxyXG4gICAgICAvLyBwYXRoIChUMiBGaXggMyBkZWR1cCkgXHUyMDE0IHRoYXQgZmlsZSBsaXZlcyBvdXRzaWRlIHRoaXMgVml0ZSByb290ICgnLicgPT0gZnJvbnRlbmQvKSwgc28gdGhlXHJcbiAgICAgIC8vIGRlZmF1bHQgZnMuYWxsb3cgYm91bmRhcnkgNDAzcyBpdCB1bmRlciBgdml0ZSBkZXZgLiBXaWRlbiB0byB0aGUgcmVwbyByb290IHNvIC9AZnMvIGNhblxyXG4gICAgICAvLyByZWFjaCBpdDsgYHZpdGUgYnVpbGRgIChSb2xsdXApIGFuZCB2aXRlc3QgYXJlIHVuYWZmZWN0ZWQgXHUyMDE0IHRoaXMgb25seSBib3VuZHMgdGhlIGRldiBzZXJ2ZXIuXHJcbiAgICAgIGZzOiB7XHJcbiAgICAgICAgYWxsb3c6IFtyZXBvUm9vdF0sXHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gICAgcHJldmlldzoge1xyXG4gICAgICBoaXN0b3J5QXBpRmFsbGJhY2s6IHRydWUsXHJcbiAgICB9LFxyXG4gICAgb3B0aW1pemVEZXBzOiB7XHJcbiAgICAgIGluY2x1ZGU6IFsncmVhY3QtZm9yY2UtZ3JhcGgtMmQnXSxcclxuICAgIH0sXHJcbiAgICAvLyBWaXRlc3Qtb25seSBlbnYuIGJhc2UvY29uZmlnLmpzIGFuZCBzcmMvY29uZmlnLmpzJ3MgQkFTRV9QT09MX0NBVEFMT0cgZmFpbCBsb3VkbHkgYXQgbW9kdWxlXHJcbiAgICAvLyBsb2FkIG9uIGEgbWlzc2luZyAweCBhZGRyZXNzIChkZWxpYmVyYXRlIFx1MjAxNCBzZWUgdGhlaXIgZG9jc3RyaW5ncykuIFRlc3RzIGltcG9ydCB0aG9zZSBtb2R1bGVzXHJcbiAgICAvLyBzdGF0aWNhbGx5IHdpdGhvdXQgcmVhbCBkZXBsb3ltZW50cywgc28gcHJvdmlkZSB0aHJvd2F3YXkgcGxhY2Vob2xkZXIgYWRkcmVzc2VzIGhlcmU7IGFcclxuICAgIC8vIHBlci10ZXN0IHZpLnN0dWJFbnYgc3RpbGwgb3ZlcnJpZGVzIHRoZXNlIChjb25maWcudGVzdC5qcyByZWxpZXMgb24gdGhhdCkuIE5ldmVyIHVzZWQgYnlcclxuICAgIC8vIGB2aXRlIGRldmAvYHZpdGUgYnVpbGRgIFx1MjAxNCB0aGlzIGtleSBpcyByZWFkIG9ubHkgdW5kZXIgdml0ZXN0LlxyXG4gICAgdGVzdDoge1xyXG4gICAgICBlbnY6IHtcclxuICAgICAgICBWSVRFX1lJRUxEX1JPVVRFUl9BRERSRVNTOiAnMHgxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExJyxcclxuICAgICAgICBWSVRFX0JBU0VfUE9PTF8xX0FERFJFU1M6ICcweDExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTInLFxyXG4gICAgICAgIFZJVEVfQkFTRV9QT09MXzJfQUREUkVTUzogJzB4MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMycsXHJcbiAgICAgICAgVklURV9CQVNFX1BPT0xfM19BRERSRVNTOiAnMHgxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE0JyxcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgfVxyXG59KVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvYWkuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS9haS5qc1wiOy8vIFNlcnZlci1zaWRlIEFJIHByb3h5LiBLZWVwcyBERUVQU0VFS19BUElfS0VZIG9mZiB0aGUgY2xpZW50IGJ1bmRsZS5cclxuLy8gVXNlZCBieSBib3RoIHRoZSBWaXRlIGRldi9wcmV2aWV3IG1pZGRsZXdhcmUgYW5kIHNlcnZlcmxlc3MgZGVwbG95c1xyXG4vLyAoVmVyY2VsLXN0eWxlIGRlZmF1bHQgZXhwb3J0OiBoYW5kbGVyKHJlcSwgcmVzKSkuXHJcbmltcG9ydCB7IGFwcGx5Q29ycywgcmF0ZUxpbWl0IH0gZnJvbSAnLi9fZ3VhcmQuanMnXHJcblxyXG5jb25zdCBERUVQU0VFS19VUkwgPSAnaHR0cHM6Ly9hcGkuZGVlcHNlZWsuY29tL3YxL2NoYXQvY29tcGxldGlvbnMnXHJcblxyXG5jb25zdCBBTExPV0VEX01PREVMUyA9IFtcclxuICAnZGVlcHNlZWstdjQtcHJvJyxcclxuICAnZGVlcHNlZWstdjQtZmxhc2gnLFxyXG5dXHJcblxyXG5hc3luYyBmdW5jdGlvbiByZWFkQm9keShyZXEpIHtcclxuICBpZiAocmVxLmJvZHkgJiYgdHlwZW9mIHJlcS5ib2R5ID09PSAnb2JqZWN0JykgcmV0dXJuIHJlcS5ib2R5IC8vIHByZS1wYXJzZWQgKHNlcnZlcmxlc3MpXHJcbiAgY29uc3QgY2h1bmtzID0gW11cclxuICBmb3IgYXdhaXQgKGNvbnN0IGMgb2YgcmVxKSBjaHVua3MucHVzaChjKVxyXG4gIGNvbnN0IHJhdyA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZygndXRmOCcpXHJcbiAgcmV0dXJuIHJhdyA/IEpTT04ucGFyc2UocmF3KSA6IHt9XHJcbn1cclxuXHJcbmV4cG9ydCBkZWZhdWx0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIocmVxLCByZXMpIHtcclxuICBpZiAocmVxLm1ldGhvZCAhPT0gJ1BPU1QnKSB7XHJcbiAgICByZXMuc3RhdHVzQ29kZSA9IDQwNVxyXG4gICAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ01ldGhvZCBub3QgYWxsb3dlZCcgfSkpXHJcbiAgfVxyXG5cclxuICAvLyAxLiBPcmlnaW4gYWxsb3dsaXN0ICsgcGVyLUlQIHJhdGUgbGltaXQgKE9yaWdpbiBhbG9uZSBpcyBmb3JnZWFibGUgXHUyMTkyIG5vdCBhdXRoKVxyXG4gIGlmICghYXBwbHlDb3JzKHJlcSwgcmVzKSkgcmV0dXJuXHJcbiAgaWYgKCFyYXRlTGltaXQocmVxLCByZXMsIHsgbWF4OiAzMCwgd2luZG93TXM6IDYwXzAwMCwgYnVja2V0OiAnYWknIH0pKSByZXR1cm5cclxuXHJcbiAgY29uc3Qga2V5ID0gcHJvY2Vzcy5lbnYuREVFUFNFRUtfQVBJX0tFWVxyXG4gIGlmICgha2V5KSB7XHJcbiAgICByZXMuc3RhdHVzQ29kZSA9IDUwM1xyXG4gICAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0FJIHByb3h5IG5vdCBjb25maWd1cmVkJyB9KSlcclxuICB9XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IHsgbW9kZWwsIG1lc3NhZ2VzLCByZXNwb25zZV9mb3JtYXQgfSA9IGF3YWl0IHJlYWRCb2R5KHJlcSlcclxuXHJcbiAgICAvLyAyLiBNb2RlbCBhbGxvd2xpc3QgY2hlY2tcclxuICAgIGlmICghQUxMT1dFRF9NT0RFTFMuaW5jbHVkZXMobW9kZWwpKSB7XHJcbiAgICAgIHJlcy5zdGF0dXNDb2RlID0gNDAwXHJcbiAgICAgIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJylcclxuICAgICAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ01vZGVsIG5vdCBhbGxvd2VkJyB9KSlcclxuICAgIH1cclxuXHJcbiAgICAvLyAzLiBNZXNzYWdlIHZhbGlkYXRpb24gKGxlbmd0aCBjYXAgYW5kIGZvcm1hdCB2YWxpZGF0aW9uIHRvIHByZXZlbnQgaW5qZWN0aW9uKVxyXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KG1lc3NhZ2VzKSB8fCBtZXNzYWdlcy5sZW5ndGggPiAxMCkge1xyXG4gICAgICByZXMuc3RhdHVzQ29kZSA9IDQwMFxyXG4gICAgICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpXHJcbiAgICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIG1lc3NhZ2VzJyB9KSlcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgbXNnIG9mIG1lc3NhZ2VzKSB7XHJcbiAgICAgIGlmICh0eXBlb2YgbXNnLmNvbnRlbnQgPT09ICdzdHJpbmcnICYmIG1zZy5jb250ZW50Lmxlbmd0aCA+IDEwMDAwMCkge1xyXG4gICAgICAgIHJlcy5zdGF0dXNDb2RlID0gNDAwXHJcbiAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKVxyXG4gICAgICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNZXNzYWdlIHRvbyBsb25nJyB9KSlcclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHVwc3RyZWFtID0gYXdhaXQgZmV0Y2goREVFUFNFRUtfVVJMLCB7XHJcbiAgICAgIG1ldGhvZDogJ1BPU1QnLFxyXG4gICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHtrZXl9YCB9LFxyXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IG1vZGVsLCBtZXNzYWdlcywgcmVzcG9uc2VfZm9ybWF0IH0pLFxyXG4gICAgfSlcclxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCB1cHN0cmVhbS50ZXh0KClcclxuICAgIHJlcy5zdGF0dXNDb2RlID0gdXBzdHJlYW0uc3RhdHVzXHJcbiAgICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpXHJcbiAgICByZXMuZW5kKHRleHQpXHJcbiAgfSBjYXRjaCB7XHJcbiAgICAvLyBHZW5lcmljIG1lc3NhZ2UgXHUyMDE0IG5ldmVyIGVjaG8gdXBzdHJlYW0vaW50ZXJuYWwgZXJyb3IgZGV0YWlscyB0byB0aGUgY2xpZW50LlxyXG4gICAgcmVzLnN0YXR1c0NvZGUgPSA1MDJcclxuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0FJIHByb3h5IGZhaWxlZCcgfSkpXHJcbiAgfVxyXG59XHJcblxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvc2VhcmNoLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvc2VhcmNoLmpzXCI7Ly8gU2VydmVyLXNpZGUgVGF2aWx5IHByb3h5LiBLZWVwcyBUQVZJTFlfQVBJX0tFWSBvZmYgdGhlIGNsaWVudCBidW5kbGUuXHJcbi8vIE1pcnJvcnMgYXBpL2FpLmpzOiBQT1NULW9ubHksIG9yaWdpbiBhbGxvd2xpc3QsIGtleSBzZXJ2ZXItc2lkZSwgaW5wdXQgY2Fwcy5cclxuLy8gVXNlZCBieSBib3RoIHRoZSBWaXRlIGRldi9wcmV2aWV3IG1pZGRsZXdhcmUgYW5kIHNlcnZlcmxlc3MgZGVwbG95cy5cclxuaW1wb3J0IHsgYXBwbHlDb3JzLCByYXRlTGltaXQgfSBmcm9tICcuL19ndWFyZC5qcydcclxuXHJcbmNvbnN0IFRBVklMWV9VUkwgPSAnaHR0cHM6Ly9hcGkudGF2aWx5LmNvbS9zZWFyY2gnXHJcblxyXG5hc3luYyBmdW5jdGlvbiByZWFkQm9keShyZXEpIHtcclxuICBpZiAocmVxLmJvZHkgJiYgdHlwZW9mIHJlcS5ib2R5ID09PSAnb2JqZWN0JykgcmV0dXJuIHJlcS5ib2R5IC8vIHByZS1wYXJzZWQgKHNlcnZlcmxlc3MpXHJcbiAgY29uc3QgY2h1bmtzID0gW11cclxuICBmb3IgYXdhaXQgKGNvbnN0IGMgb2YgcmVxKSBjaHVua3MucHVzaChjKVxyXG4gIGNvbnN0IHJhdyA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZygndXRmOCcpXHJcbiAgcmV0dXJuIHJhdyA/IEpTT04ucGFyc2UocmF3KSA6IHt9XHJcbn1cclxuXHJcbmV4cG9ydCBkZWZhdWx0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIocmVxLCByZXMpIHtcclxuICBpZiAocmVxLm1ldGhvZCAhPT0gJ1BPU1QnKSB7XHJcbiAgICByZXMuc3RhdHVzQ29kZSA9IDQwNVxyXG4gICAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ01ldGhvZCBub3QgYWxsb3dlZCcgfSkpXHJcbiAgfVxyXG5cclxuICAvLyBPcmlnaW4gYWxsb3dsaXN0ICsgcGVyLUlQIHJhdGUgbGltaXQgKE9yaWdpbiBhbG9uZSBpcyBmb3JnZWFibGUgXHUyMTkyIG5vdCBhdXRoKVxyXG4gIGlmICghYXBwbHlDb3JzKHJlcSwgcmVzKSkgcmV0dXJuXHJcbiAgaWYgKCFyYXRlTGltaXQocmVxLCByZXMsIHsgbWF4OiAzMCwgd2luZG93TXM6IDYwXzAwMCwgYnVja2V0OiAnc2VhcmNoJyB9KSkgcmV0dXJuXHJcblxyXG4gIGNvbnN0IGtleSA9IHByb2Nlc3MuZW52LlRBVklMWV9BUElfS0VZXHJcbiAgaWYgKCFrZXkpIHtcclxuICAgIHJlcy5zdGF0dXNDb2RlID0gNTAzXHJcbiAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnU2VhcmNoIHByb3h5IG5vdCBjb25maWd1cmVkJyB9KSlcclxuICB9XHJcblxyXG4gIHRyeSB7XHJcbiAgICBjb25zdCB7IHF1ZXJ5LCBzZWFyY2hfZGVwdGgsIG1heF9yZXN1bHRzLCBpbmNsdWRlX2Fuc3dlciB9ID0gYXdhaXQgcmVhZEJvZHkocmVxKVxyXG5cclxuICAgIC8vIElucHV0IHZhbGlkYXRpb24gXHUyMDE0IHJlamVjdCBvdmVyc2l6ZWQvbWFsZm9ybWVkIHF1ZXJpZXNcclxuICAgIGlmICh0eXBlb2YgcXVlcnkgIT09ICdzdHJpbmcnIHx8IHF1ZXJ5Lmxlbmd0aCA9PT0gMCB8fCBxdWVyeS5sZW5ndGggPiA1MDApIHtcclxuICAgICAgcmVzLnN0YXR1c0NvZGUgPSA0MDBcclxuICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKVxyXG4gICAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW52YWxpZCBxdWVyeScgfSkpXHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgdXBzdHJlYW0gPSBhd2FpdCBmZXRjaChUQVZJTFlfVVJMLCB7XHJcbiAgICAgIG1ldGhvZDogJ1BPU1QnLFxyXG4gICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHtrZXl9YCB9LFxyXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgcXVlcnksXHJcbiAgICAgICAgc2VhcmNoX2RlcHRoOiBzZWFyY2hfZGVwdGggPT09ICdhZHZhbmNlZCcgPyAnYWR2YW5jZWQnIDogJ2Jhc2ljJyxcclxuICAgICAgICBtYXhfcmVzdWx0czogTWF0aC5taW4oTnVtYmVyKG1heF9yZXN1bHRzKSB8fCAzLCA1KSxcclxuICAgICAgICBpbmNsdWRlX2Fuc3dlcjogaW5jbHVkZV9hbnN3ZXIgIT09IGZhbHNlLFxyXG4gICAgICAgIGluY2x1ZGVfcmF3X2NvbnRlbnQ6IGZhbHNlLFxyXG4gICAgICB9KSxcclxuICAgIH0pXHJcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgdXBzdHJlYW0udGV4dCgpXHJcbiAgICByZXMuc3RhdHVzQ29kZSA9IHVwc3RyZWFtLnN0YXR1c1xyXG4gICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKVxyXG4gICAgcmVzLmVuZCh0ZXh0KVxyXG4gIH0gY2F0Y2gge1xyXG4gICAgcmVzLnN0YXR1c0NvZGUgPSA1MDJcclxuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1NlYXJjaCBwcm94eSBmYWlsZWQnIH0pKVxyXG4gIH1cclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvZmF1Y2V0LmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvZmF1Y2V0LmpzXCI7Ly8gU2VydmVyLXNpZGUgdGVzdG5ldCB0b2tlbiBmYXVjZXQuIERpc3BlbnNlcyBhIENBUFBFRCBhbW91bnQgb2YgdGhlIGRlbW8gU0FDIHRva2VuXHJcbi8vIChCbGVuZCBVU0RDKSBmcm9tIGEgZnVuZGVkIFZGIHRyZWFzdXJ5IChWRl9GQVVDRVRfU0VDUkVUKSB0byBhIHRhcmdldCBDLWFkZHJlc3MsIHNvIGFcclxuLy8gZnJlc2ggcGFzc2tleSBzbWFydCBhY2NvdW50IGNhbiBhcHByb3ZlICsgZGVwb3NpdC4gVGhlIHRyZWFzdXJ5IHNlY3JldCBpcyBzZXJ2ZXItaGVsZCBcdTIwMTRcclxuLy8gbmV2ZXIgaW4gdGhlIGNsaWVudCBidW5kbGUuIEFidXNlLWJvdW5kZWQ6IG9yaWdpbiBhbGxvd2xpc3QgKyB0aWdodCBwZXItSVAgcmF0ZSBsaW1pdFxyXG4vLyAoX2d1YXJkLmpzKSArIGEgaGFyZCBzZXJ2ZXItc2lkZSBhbW91bnQgY2FwLiBUZXN0bmV0IG9ubHkgXHUyMDE0IGEgbWFpbm5ldCBidWlsZCBkcm9wcyB0aGlzLlxyXG4vL1xyXG4vLyAgIHsgYWN0aW9uOiAnZGlzcGVuc2UnLCB0bzogJzxDLWFkZHJlc3M+JywgYW1vdW50PyB9IFx1MjE5MiB7IGhhc2gsIHN0YXR1cyB9XHJcblxyXG5pbXBvcnQgeyBhcHBseUNvcnMsIHJhdGVMaW1pdCB9IGZyb20gJy4vX2d1YXJkLmpzJ1xyXG5cclxuY29uc3QgUEFTU1BIUkFTRSA9ICgpID0+XHJcbiAgcHJvY2Vzcy5lbnYuU1RFTExBUl9ORVRXT1JLX1BBU1NQSFJBU0UgfHwgJ1Rlc3QgU0RGIE5ldHdvcmsgOyBTZXB0ZW1iZXIgMjAxNSdcclxuY29uc3QgUlBDX1VSTCA9ICgpID0+IHByb2Nlc3MuZW52LlNPUk9CQU5fUlBDX1VSTCB8fCAnaHR0cHM6Ly9zb3JvYmFuLXRlc3RuZXQuc3RlbGxhci5vcmcnXHJcbmNvbnN0IEZBVUNFVF9TRUNSRVQgPSAoKSA9PiBwcm9jZXNzLmVudi5WRl9GQVVDRVRfU0VDUkVUIHx8ICcnXHJcbmNvbnN0IFRPS0VOX0FERFIgPSAoKSA9PiBwcm9jZXNzLmVudi5TT1JPQkFOX1RPS0VOX0FERFJFU1MgfHwgJydcclxuXHJcbi8vIDctZGVjaW1hbCB0b2tlbiAoU09ST0JBTl9ERUNJTUFMUyA9IDcpLiBDYXAgYSBzaW5nbGUgZGlzcGVuc2UgYXQgMTAwIHRva2Vucy5cclxuZXhwb3J0IGNvbnN0IENBUF9CQVNFX1VOSVRTID0gMTAwbiAqIDEwbiAqKiA3blxyXG5jb25zdCBERUZBVUxUX0JBU0VfVU5JVFMgPSAxMG4gKiAxMG4gKiogN24gLy8gMTAgdG9rZW5zIGRlZmF1bHRcclxuXHJcbi8vIERhaWx5IGNhcHMgb24gdG9wIG9mIHRoZSBwZXItSVAgcmF0ZSBsaW1pdCAoX2d1YXJkKS4gS2V5ZWQgYnkgcmVjaXBpZW50ICsgYSBnbG9iYWwgY2VpbGluZy5cclxuZXhwb3J0IGNvbnN0IFBFUl9SRUNJUElFTlRfREFJTFlfQ0FQID0gMzAwbiAqIDEwbiAqKiA3biAvLyAzMDAgdG9rZW5zIC8gYWRkcmVzcyAvIDI0aFxyXG5leHBvcnQgY29uc3QgR0xPQkFMX0RBSUxZX0NBUCA9IDVfMDAwbiAqIDEwbiAqKiA3biAvLyA1MDAwIHRva2VucyAvIDI0aCB0b3RhbFxyXG5jb25zdCBEQVlfTVMgPSAyNCAqIDYwICogNjAgKiAxMDAwXHJcblxyXG4vLyBwb255dGFpbDogaW4tbWVtb3J5IGFjY291bnRpbmcsIHJlc2V0cyBvbiBzZXJ2ZXJsZXNzIGNvbGQgc3RhcnQgXHUyMDE0IGEgYmVzdC1lZmZvcnQgYWJ1c2UgYm91bmQsXHJcbi8vIG5vdCBhIGhhcmQgZ3VhcmFudGVlLiBNb3ZlIHRvIEtWIC8gRHVyYWJsZSBPYmplY3QgaWYgY29sZC1zdGFydCByZXNldCBiZWNvbWVzIGV4cGxvaXRhYmxlLlxyXG5jb25zdCBfc3BlbnQgPSBuZXcgTWFwKCkgLy8gcmVjaXBpZW50IC0+IHsgdG90YWw6IGJpZ2ludCwgd2luZG93U3RhcnQ6IG51bWJlciB9XHJcbmxldCBfZ2xvYmFsVG90YWwgPSAwblxyXG5sZXQgX2dsb2JhbFdpbmRvd1N0YXJ0ID0gMFxyXG5cclxuLyoqIEVmZmVjdGl2ZSBkaXNwZW5zZWQgYW1vdW50OiBjbGFtcCB0byBbXywgQ0FQX0JBU0VfVU5JVFNdLCBkZWZhdWx0IHdoZW4gdW5zZXQvbm9uLXBvc2l0aXZlLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZWZmZWN0aXZlQW1vdW50KGFtb3VudCkge1xyXG4gIHJldHVybiBhbW91bnQgJiYgQmlnSW50KGFtb3VudCkgPiAwblxyXG4gICAgPyBCaWdJbnQoYW1vdW50KSA+IENBUF9CQVNFX1VOSVRTXHJcbiAgICAgID8gQ0FQX0JBU0VfVU5JVFNcclxuICAgICAgOiBCaWdJbnQoYW1vdW50KVxyXG4gICAgOiBERUZBVUxUX0JBU0VfVU5JVFNcclxufVxyXG5cclxuLyoqIFJlc2VydmUgYGFtb3VudGAgZm9yIGB0b2AgYWdhaW5zdCBkYWlseSBjYXBzLiBSZXR1cm5zIGZhbHNlIChhbmQgcmVjb3JkcyBub3RoaW5nKSBpZiBleGNlZWRlZC4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlc2VydmVEYWlseSh0bywgYW1vdW50LCBub3cgPSBEYXRlLm5vdygpKSB7XHJcbiAgaWYgKG5vdyAtIF9nbG9iYWxXaW5kb3dTdGFydCA+IERBWV9NUykge1xyXG4gICAgX2dsb2JhbFdpbmRvd1N0YXJ0ID0gbm93XHJcbiAgICBfZ2xvYmFsVG90YWwgPSAwblxyXG4gIH1cclxuICBjb25zdCByZWMgPSBfc3BlbnQuZ2V0KHRvKVxyXG4gIGNvbnN0IHZhbGlkID0gcmVjICYmIG5vdyAtIHJlYy53aW5kb3dTdGFydCA8PSBEQVlfTVNcclxuICBjb25zdCBwcmlvciA9IHZhbGlkID8gcmVjLnRvdGFsIDogMG5cclxuICBpZiAocHJpb3IgKyBhbW91bnQgPiBQRVJfUkVDSVBJRU5UX0RBSUxZX0NBUCkgcmV0dXJuIGZhbHNlXHJcbiAgaWYgKF9nbG9iYWxUb3RhbCArIGFtb3VudCA+IEdMT0JBTF9EQUlMWV9DQVApIHJldHVybiBmYWxzZVxyXG4gIF9zcGVudC5zZXQodG8sIHsgdG90YWw6IHByaW9yICsgYW1vdW50LCB3aW5kb3dTdGFydDogdmFsaWQgPyByZWMud2luZG93U3RhcnQgOiBub3cgfSlcclxuICBfZ2xvYmFsVG90YWwgKz0gYW1vdW50XHJcbiAgcmV0dXJuIHRydWVcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIEZhdWNldEVycm9yIGV4dGVuZHMgRXJyb3Ige31cclxuXHJcbi8qKlxyXG4gKiB0cmFuc2Zlcihmcm9tPXRyZWFzdXJ5LCB0bywgYW1vdW50KSBvZiB0aGUgU0FDIHRva2VuOyB0cmVhc3VyeSAoc2VjcmV0KSBzaWducyB0aGUgc291cmNlLlxyXG4gKiBAcmV0dXJucyB7UHJvbWlzZTx7IGhhc2gsIHN0YXR1cyB9Pn1cclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNwZW5zZVRva2VuKHtcclxuICBzZWNyZXQsXHJcbiAgdG9rZW4sXHJcbiAgdG8sXHJcbiAgYW1vdW50LFxyXG4gIHBhc3NwaHJhc2UsXHJcbiAgc2RrLFxyXG4gIHJwY1NlcnZlcixcclxuICBwb2xsVHJpZXMgPSAxMCxcclxuICBwb2xsSW50ZXJ2YWxNcyA9IDE1MDAsXHJcbn0pIHtcclxuICBjb25zdCB7IEtleXBhaXIsIFRyYW5zYWN0aW9uQnVpbGRlciwgQ29udHJhY3QsIEFkZHJlc3MsIHhkciwgQkFTRV9GRUUsIHJwYyB9ID0gc2RrXHJcbiAgY29uc3QgY2FwcGVkID0gZWZmZWN0aXZlQW1vdW50KGFtb3VudClcclxuICBjb25zdCBrcCA9IEtleXBhaXIuZnJvbVNlY3JldChzZWNyZXQpXHJcbiAgY29uc3Qgc291cmNlID0gYXdhaXQgcnBjU2VydmVyLmdldEFjY291bnQoa3AucHVibGljS2V5KCkpXHJcbiAgY29uc3Qgb3AgPSBuZXcgQ29udHJhY3QodG9rZW4pLmNhbGwoXHJcbiAgICAndHJhbnNmZXInLFxyXG4gICAgQWRkcmVzcy5mcm9tU3RyaW5nKGtwLnB1YmxpY0tleSgpKS50b1NjVmFsKCksXHJcbiAgICBBZGRyZXNzLmZyb21TdHJpbmcodG8pLnRvU2NWYWwoKSxcclxuICAgIHhkci5TY1ZhbC5zY3ZJMTI4KFxyXG4gICAgICBuZXcgeGRyLkludDEyOFBhcnRzKHtcclxuICAgICAgICBoaTogeGRyLkludDY0LmZyb21TdHJpbmcoJzAnKSxcclxuICAgICAgICBsbzogeGRyLlVpbnQ2NC5mcm9tU3RyaW5nKGNhcHBlZC50b1N0cmluZygpKSxcclxuICAgICAgfSlcclxuICAgIClcclxuICApXHJcbiAgY29uc3QgcmF3ID0gbmV3IFRyYW5zYWN0aW9uQnVpbGRlcihzb3VyY2UsIHsgZmVlOiBCQVNFX0ZFRSwgbmV0d29ya1Bhc3NwaHJhc2U6IHBhc3NwaHJhc2UgfSlcclxuICAgIC5hZGRPcGVyYXRpb24ob3ApXHJcbiAgICAuc2V0VGltZW91dCg2MClcclxuICAgIC5idWlsZCgpXHJcbiAgY29uc3Qgc2ltID0gYXdhaXQgcnBjU2VydmVyLnNpbXVsYXRlVHJhbnNhY3Rpb24ocmF3KVxyXG4gIGlmIChycGMuQXBpLmlzU2ltdWxhdGlvbkVycm9yKHNpbSkpIHRocm93IG5ldyBGYXVjZXRFcnJvcihgZmF1Y2V0IHNpbSBmYWlsZWQ6ICR7c2ltLmVycm9yfWApXHJcbiAgY29uc3QgcHJlcGFyZWQgPSBycGMuYXNzZW1ibGVUcmFuc2FjdGlvbihyYXcsIHNpbSkuYnVpbGQoKVxyXG4gIHByZXBhcmVkLnNpZ24oa3ApXHJcbiAgY29uc3Qgc2VudCA9IGF3YWl0IHJwY1NlcnZlci5zZW5kVHJhbnNhY3Rpb24ocHJlcGFyZWQpXHJcbiAgaWYgKHNlbnQuc3RhdHVzID09PSAnRVJST1InKSB0aHJvdyBuZXcgRmF1Y2V0RXJyb3IoJ1JQQyByZWplY3RlZCB0aGUgZmF1Y2V0IHRyYW5zZmVyJylcclxuICBmb3IgKGxldCBpID0gMDsgaSA8IHBvbGxUcmllczsgaSsrKSB7XHJcbiAgICBjb25zdCByID0gYXdhaXQgcnBjU2VydmVyLmdldFRyYW5zYWN0aW9uKHNlbnQuaGFzaClcclxuICAgIGlmIChyLnN0YXR1cyAmJiByLnN0YXR1cyAhPT0gJ05PVF9GT1VORCcpIHJldHVybiB7IGhhc2g6IHNlbnQuaGFzaCwgc3RhdHVzOiByLnN0YXR1cyB9XHJcbiAgICBpZiAocG9sbEludGVydmFsTXMpIGF3YWl0IG5ldyBQcm9taXNlKChyZXMpID0+IHNldFRpbWVvdXQocmVzLCBwb2xsSW50ZXJ2YWxNcykpXHJcbiAgfVxyXG4gIHJldHVybiB7IGhhc2g6IHNlbnQuaGFzaCwgc3RhdHVzOiAnUEVORElORycgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZWFkQm9keShyZXEpIHtcclxuICBpZiAocmVxLmJvZHkgJiYgdHlwZW9mIHJlcS5ib2R5ID09PSAnb2JqZWN0JykgcmV0dXJuIHJlcS5ib2R5XHJcbiAgY29uc3QgY2h1bmtzID0gW11cclxuICBmb3IgYXdhaXQgKGNvbnN0IGMgb2YgcmVxKSBjaHVua3MucHVzaChjKVxyXG4gIGNvbnN0IHJhdyA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZygndXRmOCcpXHJcbiAgcmV0dXJuIHJhdyA/IEpTT04ucGFyc2UocmF3KSA6IHt9XHJcbn1cclxuZnVuY3Rpb24gYmFkKHJlcywgbXNnKSB7XHJcbiAgcmVzLnN0YXR1c0NvZGUgPSA0MDBcclxuICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBtc2cgfSkpXHJcbn1cclxuZnVuY3Rpb24gdG9vTWFueShyZXMsIG1zZykge1xyXG4gIHJlcy5zdGF0dXNDb2RlID0gNDI5XHJcbiAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogbXNnIH0pKVxyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKHJlcSwgcmVzKSB7XHJcbiAgaWYgKHJlcS5tZXRob2QgIT09ICdQT1NUJykge1xyXG4gICAgcmVzLnN0YXR1c0NvZGUgPSA0MDVcclxuICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNZXRob2Qgbm90IGFsbG93ZWQnIH0pKVxyXG4gIH1cclxuICBpZiAoIWFwcGx5Q29ycyhyZXEsIHJlcykpIHJldHVyblxyXG4gIGlmICghcmF0ZUxpbWl0KHJlcSwgcmVzLCB7IG1heDogMywgd2luZG93TXM6IDYwXzAwMCwgYnVja2V0OiAnZmF1Y2V0JyB9KSkgcmV0dXJuXHJcbiAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKVxyXG5cclxuICBjb25zdCBzZWNyZXQgPSBGQVVDRVRfU0VDUkVUKClcclxuICBpZiAoIXNlY3JldCkge1xyXG4gICAgcmVzLnN0YXR1c0NvZGUgPSA1MDNcclxuICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdGYXVjZXQgbm90IGNvbmZpZ3VyZWQnLCBjb25maWd1cmVkOiBmYWxzZSB9KSlcclxuICB9XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQm9keShyZXEpXHJcbiAgICBpZiAoYm9keS5hY3Rpb24gIT09ICdkaXNwZW5zZScpIHJldHVybiBiYWQocmVzLCAnVW5rbm93biBhY3Rpb24nKVxyXG4gICAgaWYgKHR5cGVvZiBib2R5LnRvICE9PSAnc3RyaW5nJyB8fCAhYm9keS50bykgcmV0dXJuIGJhZChyZXMsICdJbnZhbGlkIHJlY2lwaWVudCcpXHJcbiAgICBjb25zdCB0b2tlbiA9IFRPS0VOX0FERFIoKVxyXG4gICAgaWYgKCF0b2tlbikge1xyXG4gICAgICByZXMuc3RhdHVzQ29kZSA9IDUwM1xyXG4gICAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnRmF1Y2V0IHRva2VuIHVuc2V0JywgY29uZmlndXJlZDogZmFsc2UgfSkpXHJcbiAgICB9XHJcbiAgICBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQoJ0BzdGVsbGFyL3N0ZWxsYXItc2RrJylcclxuICAgIGlmICghbW9kLlN0cktleS5pc1ZhbGlkQ29udHJhY3QoYm9keS50bykpIHJldHVybiBiYWQocmVzLCAnSW52YWxpZCByZWNpcGllbnQnKVxyXG4gICAgaWYgKCFyZXNlcnZlRGFpbHkoYm9keS50bywgZWZmZWN0aXZlQW1vdW50KGJvZHkuYW1vdW50KSkpXHJcbiAgICAgIHJldHVybiB0b29NYW55KHJlcywgJ0RhaWx5IGZhdWNldCBjYXAgcmVhY2hlZCcpXHJcbiAgICBjb25zdCBzZGsgPSB7XHJcbiAgICAgIEtleXBhaXI6IG1vZC5LZXlwYWlyLFxyXG4gICAgICBUcmFuc2FjdGlvbkJ1aWxkZXI6IG1vZC5UcmFuc2FjdGlvbkJ1aWxkZXIsXHJcbiAgICAgIENvbnRyYWN0OiBtb2QuQ29udHJhY3QsXHJcbiAgICAgIEFkZHJlc3M6IG1vZC5BZGRyZXNzLFxyXG4gICAgICB4ZHI6IG1vZC54ZHIsXHJcbiAgICAgIEJBU0VfRkVFOiBtb2QuQkFTRV9GRUUsXHJcbiAgICAgIHJwYzogbW9kLnJwYyxcclxuICAgIH1cclxuICAgIGNvbnN0IHJwY1NlcnZlciA9IG5ldyBtb2QucnBjLlNlcnZlcihSUENfVVJMKCkpXHJcbiAgICBjb25zdCBvdXQgPSBhd2FpdCBkaXNwZW5zZVRva2VuKHtcclxuICAgICAgc2VjcmV0LFxyXG4gICAgICB0b2tlbixcclxuICAgICAgdG86IGJvZHkudG8sXHJcbiAgICAgIGFtb3VudDogYm9keS5hbW91bnQsXHJcbiAgICAgIHBhc3NwaHJhc2U6IFBBU1NQSFJBU0UoKSxcclxuICAgICAgc2RrLFxyXG4gICAgICBycGNTZXJ2ZXIsXHJcbiAgICB9KVxyXG4gICAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkob3V0KSlcclxuICB9IGNhdGNoIChlcnIpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoJ1thcGkvZmF1Y2V0XSBlcnJvcjonLCBlcnI/Lm1lc3NhZ2UgfHwgZXJyKVxyXG4gICAgcmVzLnN0YXR1c0NvZGUgPSA1MDJcclxuICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdGYXVjZXQgZmFpbGVkJyB9KSlcclxuICB9XHJcbn1cclxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmL2F1dGgtY2hhbGxlbmdlLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvYXV0aC1jaGFsbGVuZ2UuanNcIjtpbXBvcnQgeyBTdHJLZXkgfSBmcm9tICdAc3RlbGxhci9zdGVsbGFyLXNkaydcclxuaW1wb3J0IHsgcmF0ZUxpbWl0IH0gZnJvbSAnLi4vX2d1YXJkLmpzJ1xyXG5pbXBvcnQgeyBidWlsZENoYWxsZW5nZSB9IGZyb20gJy4vX3NlcDEwLmpzJ1xyXG5cclxuY29uc3QganNvbiA9IChyZXMsIHN0YXR1cywgb2JqKSA9PiB7XHJcbiAgcmVzLnN0YXR1c0NvZGUgPSBzdGF0dXNcclxuICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpXHJcbiAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShvYmopKVxyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKHJlcSwgcmVzKSB7XHJcbiAgaWYgKCFyYXRlTGltaXQocmVxLCByZXMsIHsgbWF4OiAyMCwgd2luZG93TXM6IDYwXzAwMCwgYnVja2V0OiAndmYtYXV0aCcgfSkpIHJldHVyblxyXG4gIGNvbnN0IHNpZ25pbmdTZWNyZXQgPSBwcm9jZXNzLmVudi5WRl9BVVRIX1NJR05JTkdfS0VZXHJcbiAgaWYgKCFzaWduaW5nU2VjcmV0KVxyXG4gICAgcmV0dXJuIGpzb24ocmVzLCA1MDMsIHsgY29uZmlndXJlZDogZmFsc2UsIGVycm9yOiAnUG9ydGFsIGF1dGggbm90IGNvbmZpZ3VyZWQnIH0pXHJcbiAgY29uc3QgYWNjb3VudCA9IG5ldyBVUkwocmVxLnVybCwgJ2h0dHA6Ly9sb2NhbCcpLnNlYXJjaFBhcmFtcy5nZXQoJ2FjY291bnQnKSB8fCAnJ1xyXG4gIGlmICghU3RyS2V5LmlzVmFsaWRFZDI1NTE5UHVibGljS2V5KGFjY291bnQpKSByZXR1cm4ganNvbihyZXMsIDQwMCwgeyBlcnJvcjogJ0ludmFsaWQgYWNjb3VudCcgfSlcclxuICBjb25zdCBvdXQgPSBhd2FpdCBidWlsZENoYWxsZW5nZSh7XHJcbiAgICBhY2NvdW50LFxyXG4gICAgc2lnbmluZ1NlY3JldCxcclxuICAgIGhvbWVEb21haW46IHByb2Nlc3MuZW52LlZGX0hPTUVfRE9NQUlOIHx8ICdsb2NhbGhvc3Q6NTE3MycsXHJcbiAgICBuZXR3b3JrUGFzc3BocmFzZTpcclxuICAgICAgcHJvY2Vzcy5lbnYuU1RFTExBUl9ORVRXT1JLX1BBU1NQSFJBU0UgfHwgJ1Rlc3QgU0RGIE5ldHdvcmsgOyBTZXB0ZW1iZXIgMjAxNScsXHJcbiAgfSlcclxuICBqc29uKHJlcywgMjAwLCBvdXQpXHJcbn1cclxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmL19zZXAxMC5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmL19zZXAxMC5qc1wiOy8vIFNFUC0xMCB3ZWIgYXV0aCAoc3RhdGVsZXNzOiB0aGUgc2VydmVyIHNpZ25hdHVyZSBvbiB0aGUgY2hhbGxlbmdlIG1ha2VzIGEgbm9uY2VcclxuLy8gdGFibGUgdW5uZWNlc3Nhcnk7IHJlcGxheSB3aW5kb3cgPSB0aGUgMzAwIHMgY2hhbGxlbmdlIHRpbWVib3VuZHMgKyAxIGggSldUKS5cclxuaW1wb3J0IHsgS2V5cGFpciwgV2ViQXV0aCB9IGZyb20gJ0BzdGVsbGFyL3N0ZWxsYXItc2RrJ1xyXG5cclxuY29uc3QgVElNRU9VVF9TRUMgPSAzMDBcclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZENoYWxsZW5nZSh7IGFjY291bnQsIHNpZ25pbmdTZWNyZXQsIGhvbWVEb21haW4sIG5ldHdvcmtQYXNzcGhyYXNlIH0pIHtcclxuICBjb25zdCBzZXJ2ZXJLcCA9IEtleXBhaXIuZnJvbVNlY3JldChzaWduaW5nU2VjcmV0KVxyXG4gIGNvbnN0IHRyYW5zYWN0aW9uID0gV2ViQXV0aC5idWlsZENoYWxsZW5nZVR4KFxyXG4gICAgc2VydmVyS3AsXHJcbiAgICBhY2NvdW50LFxyXG4gICAgaG9tZURvbWFpbixcclxuICAgIFRJTUVPVVRfU0VDLFxyXG4gICAgbmV0d29ya1Bhc3NwaHJhc2UsXHJcbiAgICBob21lRG9tYWluIC8vIHdlYl9hdXRoX2RvbWFpblxyXG4gIClcclxuICByZXR1cm4geyB0cmFuc2FjdGlvbiwgbmV0d29ya19wYXNzcGhyYXNlOiBuZXR3b3JrUGFzc3BocmFzZSB9XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB2ZXJpZnlDaGFsbGVuZ2UoeyBzaWduZWRYZHIsIHNpZ25pbmdTZWNyZXQsIGhvbWVEb21haW4sIG5ldHdvcmtQYXNzcGhyYXNlIH0pIHtcclxuICB0cnkge1xyXG4gICAgY29uc3Qgc2VydmVyS3AgPSBLZXlwYWlyLmZyb21TZWNyZXQoc2lnbmluZ1NlY3JldClcclxuICAgIGNvbnN0IHsgY2xpZW50QWNjb3VudElEIH0gPSBXZWJBdXRoLnJlYWRDaGFsbGVuZ2VUeChcclxuICAgICAgc2lnbmVkWGRyLFxyXG4gICAgICBzZXJ2ZXJLcC5wdWJsaWNLZXkoKSxcclxuICAgICAgbmV0d29ya1Bhc3NwaHJhc2UsXHJcbiAgICAgIGhvbWVEb21haW4sXHJcbiAgICAgIGhvbWVEb21haW5cclxuICAgIClcclxuICAgIC8vIFRocm93cyB1bmxlc3MgdGhlIGNsaWVudCBhY2NvdW50J3Mgc2lnbmF0dXJlIGlzIHByZXNlbnQgYW5kIHZhbGlkLlxyXG4gICAgV2ViQXV0aC52ZXJpZnlDaGFsbGVuZ2VUeFNpZ25lcnMoXHJcbiAgICAgIHNpZ25lZFhkcixcclxuICAgICAgc2VydmVyS3AucHVibGljS2V5KCksXHJcbiAgICAgIG5ldHdvcmtQYXNzcGhyYXNlLFxyXG4gICAgICBbY2xpZW50QWNjb3VudElEXSxcclxuICAgICAgaG9tZURvbWFpbixcclxuICAgICAgaG9tZURvbWFpblxyXG4gICAgKVxyXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjY291bnQ6IGNsaWVudEFjY291bnRJRCB9XHJcbiAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBlcnI/Lm1lc3NhZ2UgfHwgJ2ludmFsaWQgY2hhbGxlbmdlJyB9XHJcbiAgfVxyXG59XHJcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92ZlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9hdXRoLXRva2VuLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvYXV0aC10b2tlbi5qc1wiO2ltcG9ydCB7IHJhdGVMaW1pdCB9IGZyb20gJy4uL19ndWFyZC5qcydcclxuaW1wb3J0IHsgdmVyaWZ5Q2hhbGxlbmdlIH0gZnJvbSAnLi9fc2VwMTAuanMnXHJcbmltcG9ydCB7IHNpZ25Kd3QgfSBmcm9tICcuL19qd3QuanMnXHJcblxyXG5jb25zdCBqc29uID0gKHJlcywgc3RhdHVzLCBvYmopID0+IHtcclxuICByZXMuc3RhdHVzQ29kZSA9IHN0YXR1c1xyXG4gIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJylcclxuICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KG9iaikpXHJcbn1cclxuXHJcbmV4cG9ydCBkZWZhdWx0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIocmVxLCByZXMpIHtcclxuICBpZiAoIXJhdGVMaW1pdChyZXEsIHJlcywgeyBtYXg6IDIwLCB3aW5kb3dNczogNjBfMDAwLCBidWNrZXQ6ICd2Zi1hdXRoJyB9KSkgcmV0dXJuXHJcbiAgY29uc3Qgc2lnbmluZ1NlY3JldCA9IHByb2Nlc3MuZW52LlZGX0FVVEhfU0lHTklOR19LRVlcclxuICBjb25zdCBqd3RTZWNyZXQgPSBwcm9jZXNzLmVudi5WRl9KV1RfU0VDUkVUXHJcbiAgaWYgKCFzaWduaW5nU2VjcmV0IHx8ICFqd3RTZWNyZXQpXHJcbiAgICByZXR1cm4ganNvbihyZXMsIDUwMywgeyBjb25maWd1cmVkOiBmYWxzZSwgZXJyb3I6ICdQb3J0YWwgYXV0aCBub3QgY29uZmlndXJlZCcgfSlcclxuICBjb25zdCBzaWduZWRYZHIgPSByZXEuYm9keT8udHJhbnNhY3Rpb25cclxuICBpZiAodHlwZW9mIHNpZ25lZFhkciAhPT0gJ3N0cmluZycgfHwgIXNpZ25lZFhkcilcclxuICAgIHJldHVybiBqc29uKHJlcywgNDAwLCB7IGVycm9yOiAnTWlzc2luZyB0cmFuc2FjdGlvbicgfSlcclxuICBjb25zdCB2ID0gYXdhaXQgdmVyaWZ5Q2hhbGxlbmdlKHtcclxuICAgIHNpZ25lZFhkcixcclxuICAgIHNpZ25pbmdTZWNyZXQsXHJcbiAgICBob21lRG9tYWluOiBwcm9jZXNzLmVudi5WRl9IT01FX0RPTUFJTiB8fCAnbG9jYWxob3N0OjUxNzMnLFxyXG4gICAgbmV0d29ya1Bhc3NwaHJhc2U6XHJcbiAgICAgIHByb2Nlc3MuZW52LlNURUxMQVJfTkVUV09SS19QQVNTUEhSQVNFIHx8ICdUZXN0IFNERiBOZXR3b3JrIDsgU2VwdGVtYmVyIDIwMTUnLFxyXG4gIH0pXHJcbiAgaWYgKCF2Lm9rKSByZXR1cm4ganNvbihyZXMsIDQwMSwgeyBlcnJvcjogJ0NoYWxsZW5nZSB2ZXJpZmljYXRpb24gZmFpbGVkJyB9KVxyXG4gIGpzb24ocmVzLCAyMDAsIHsgdG9rZW46IGF3YWl0IHNpZ25Kd3QoeyBzdWI6IHYuYWNjb3VudCB9LCBqd3RTZWNyZXQsIDM2MDApIH0pXHJcbn1cclxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmL19qd3QuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9fand0LmpzXCI7Ly8gTWluaW1hbCBIUzI1NiBjb21wYWN0IEpXVCBvdmVyIFdlYkNyeXB0byBcdTIwMTQgbm8gbmV3IGRlcGVuZGVuY3kgZm9yIG9uZSBhbGdvcml0aG0uXHJcblxyXG5jb25zdCBlbmMgPSBuZXcgVGV4dEVuY29kZXIoKVxyXG5cclxuY29uc3QgYjY0dSA9IChidWYpID0+XHJcbiAgYnRvYShTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLm5ldyBVaW50OEFycmF5KGJ1ZikpKVxyXG4gICAgLnJlcGxhY2UoL1xcKy9nLCAnLScpXHJcbiAgICAucmVwbGFjZSgvXFwvL2csICdfJylcclxuICAgIC5yZXBsYWNlKC89KyQvLCAnJylcclxuY29uc3QgYjY0dUpzb24gPSAob2JqKSA9PiBiNjR1KGVuYy5lbmNvZGUoSlNPTi5zdHJpbmdpZnkob2JqKSkpXHJcblxyXG5hc3luYyBmdW5jdGlvbiBobWFjS2V5KHNlY3JldCkge1xyXG4gIHJldHVybiBjcnlwdG8uc3VidGxlLmltcG9ydEtleShcclxuICAgICdyYXcnLFxyXG4gICAgZW5jLmVuY29kZShzZWNyZXQpLFxyXG4gICAgeyBuYW1lOiAnSE1BQycsIGhhc2g6ICdTSEEtMjU2JyB9LFxyXG4gICAgZmFsc2UsXHJcbiAgICBbJ3NpZ24nLCAndmVyaWZ5J11cclxuICApXHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzaWduSnd0KHBheWxvYWQsIHNlY3JldCwgdHRsU2VjKSB7XHJcbiAgY29uc3QgaWF0ID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMClcclxuICBjb25zdCBib2R5ID0geyAuLi5wYXlsb2FkLCBpYXQsIGV4cDogaWF0ICsgdHRsU2VjIH1cclxuICBjb25zdCBoZWFkID0gYjY0dUpzb24oeyBhbGc6ICdIUzI1NicsIHR5cDogJ0pXVCcgfSlcclxuICBjb25zdCBkYXRhID0gYCR7aGVhZH0uJHtiNjR1SnNvbihib2R5KX1gXHJcbiAgY29uc3Qgc2lnID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5zaWduKCdITUFDJywgYXdhaXQgaG1hY0tleShzZWNyZXQpLCBlbmMuZW5jb2RlKGRhdGEpKVxyXG4gIHJldHVybiBgJHtkYXRhfS4ke2I2NHUoc2lnKX1gXHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB2ZXJpZnlKd3QodG9rZW4sIHNlY3JldCwgbm93TXMgPSBEYXRlLm5vdygpKSB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IFtoLCBwLCBzXSA9IFN0cmluZyh0b2tlbikuc3BsaXQoJy4nKVxyXG4gICAgaWYgKCFoIHx8ICFwIHx8ICFzKSByZXR1cm4gbnVsbFxyXG4gICAgY29uc3QgcGFkID0gcy5sZW5ndGggJSA0ID09PSAyID8gJz09JyA6IHMubGVuZ3RoICUgNCA9PT0gMyA/ICc9JyA6ICcnXHJcbiAgICBjb25zdCBzaWcgPSBVaW50OEFycmF5LmZyb20oYXRvYihzLnJlcGxhY2UoLy0vZywgJysnKS5yZXBsYWNlKC9fL2csICcvJykgKyBwYWQpLCAoYykgPT5cclxuICAgICAgYy5jaGFyQ29kZUF0KDApXHJcbiAgICApXHJcbiAgICBjb25zdCBvayA9IGF3YWl0IGNyeXB0by5zdWJ0bGUudmVyaWZ5KFxyXG4gICAgICAnSE1BQycsXHJcbiAgICAgIGF3YWl0IGhtYWNLZXkoc2VjcmV0KSxcclxuICAgICAgc2lnLFxyXG4gICAgICBlbmMuZW5jb2RlKGAke2h9LiR7cH1gKVxyXG4gICAgKVxyXG4gICAgaWYgKCFvaykgcmV0dXJuIG51bGxcclxuICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnBhcnNlKGF0b2IocC5yZXBsYWNlKC8tL2csICcrJykucmVwbGFjZSgvXy9nLCAnLycpKSlcclxuICAgIGlmICh0eXBlb2YgcGF5bG9hZC5leHAgIT09ICdudW1iZXInIHx8IG5vd01zIC8gMTAwMCA+IHBheWxvYWQuZXhwKSByZXR1cm4gbnVsbFxyXG4gICAgcmV0dXJuIHBheWxvYWRcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBudWxsXHJcbiAgfVxyXG59XHJcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92ZlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9rZXlzLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYva2V5cy5qc1wiOy8vIEtleSBDUlVEIFx1MjAxNCBKV1QtZ2F0ZWQgKHBvcnRhbCBzZXNzaW9uKSwgTk9UIHZmLWtleS1nYXRlZC5cclxuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCdcclxuaW1wb3J0IHsgc3RvcmVGcm9tIH0gZnJvbSAnLi9fZGIuanMnXHJcbmltcG9ydCB7IHJlcXVpcmVKd3QgfSBmcm9tICcuL192ZmF1dGguanMnXHJcbmltcG9ydCB7IGlzc3VlS2V5LCByZXZva2VLZXksIFNDT1BFUyB9IGZyb20gJy4vX2tleXN0b3JlLmpzJ1xyXG5cclxuY29uc3QganNvbiA9IChyZXMsIHN0YXR1cywgb2JqKSA9PiB7XHJcbiAgcmVzLnN0YXR1c0NvZGUgPSBzdGF0dXNcclxuICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpXHJcbiAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShvYmopKVxyXG59XHJcblxyXG5jb25zdCBJc3N1ZVNjaGVtYSA9IHoub2JqZWN0KHtcclxuICBzY29wZXM6IHouYXJyYXkoei5lbnVtKFNDT1BFUykpLm5vbmVtcHR5KCksXHJcbiAgZW52OiB6LmVudW0oWyd0ZXN0JywgJ2xpdmUnXSksXHJcbiAgcmF0ZUxpbWl0OiB6Lm51bWJlcigpLmludCgpLm1pbigxKS5tYXgoNjAwKS5kZWZhdWx0KDYwKSxcclxuICBleHBpcmVzQXQ6IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKS5udWxsYWJsZSgpLmRlZmF1bHQobnVsbCksXHJcbn0pXHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGlzdEtleXMocmVxLCByZXMpIHtcclxuICBjb25zdCBzZXNzaW9uID0gYXdhaXQgcmVxdWlyZUp3dChyZXEsIHJlcylcclxuICBpZiAoIXNlc3Npb24pIHJldHVyblxyXG4gIGpzb24ocmVzLCAyMDAsIHsga2V5czogYXdhaXQgc3RvcmVGcm9tKHJlcSkua2V5cy5saXN0KHNlc3Npb24uc3ViKSB9KVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY3JlYXRlS2V5KHJlcSwgcmVzKSB7XHJcbiAgY29uc3Qgc2Vzc2lvbiA9IGF3YWl0IHJlcXVpcmVKd3QocmVxLCByZXMpXHJcbiAgaWYgKCFzZXNzaW9uKSByZXR1cm5cclxuICBjb25zdCBwYXJzZWQgPSBJc3N1ZVNjaGVtYS5zYWZlUGFyc2UocmVxLmJvZHkgPz8ge30pXHJcbiAgaWYgKCFwYXJzZWQuc3VjY2VzcykgcmV0dXJuIGpzb24ocmVzLCA0MDAsIHsgZXJyb3I6ICdJbnZhbGlkIGtleSByZXF1ZXN0JyB9KVxyXG4gIGNvbnN0IHsgc2NvcGVzLCBlbnYsIHJhdGVMaW1pdCwgZXhwaXJlc0F0IH0gPSBwYXJzZWQuZGF0YVxyXG4gIGNvbnN0IG91dCA9IGF3YWl0IGlzc3VlS2V5KHN0b3JlRnJvbShyZXEpLCB7XHJcbiAgICBvd25lcjogc2Vzc2lvbi5zdWIsXHJcbiAgICBzY29wZXMsXHJcbiAgICByYXRlTGltaXQsXHJcbiAgICBlbnYsXHJcbiAgICBleHBpcmVzQXQsXHJcbiAgfSlcclxuICBqc29uKHJlcywgMjAwLCBvdXQpIC8vIHsgaWQsIGtleSAoT05MWSB0aW1lIHBsYWludGV4dCBsZWF2ZXMgdGhlIHNlcnZlciksIGhpbnQgfVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGVsZXRlS2V5KHJlcSwgcmVzKSB7XHJcbiAgY29uc3Qgc2Vzc2lvbiA9IGF3YWl0IHJlcXVpcmVKd3QocmVxLCByZXMpXHJcbiAgaWYgKCFzZXNzaW9uKSByZXR1cm5cclxuICBjb25zdCBpZCA9IHJlcS5ib2R5Py5pZFxyXG4gIGlmICh0eXBlb2YgaWQgIT09ICdzdHJpbmcnIHx8ICFpZCkgcmV0dXJuIGpzb24ocmVzLCA0MDAsIHsgZXJyb3I6ICdNaXNzaW5nIGlkJyB9KVxyXG4gIGNvbnN0IG9rID0gYXdhaXQgcmV2b2tlS2V5KHN0b3JlRnJvbShyZXEpLCBpZCwgc2Vzc2lvbi5zdWIpXHJcbiAgaWYgKCFvaykgcmV0dXJuIGpzb24ocmVzLCA0MDQsIHsgZXJyb3I6ICdLZXkgbm90IGZvdW5kJyB9KVxyXG4gIGpzb24ocmVzLCAyMDAsIHsgcmV2b2tlZDogdHJ1ZSB9KVxyXG59XHJcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92ZlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9fZGIuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9fZGIuanNcIjsvLyBWRiBnYXRlIHN0b3JlLiBPbmUgaW50ZXJmYWNlLCB0d28gYmFja2VuZHM6XHJcbi8vICAtIGQxU3RvcmUoZGIpOiBDbG91ZGZsYXJlIEQxIGJpbmRpbmcgKHByb2QvcHJldmlldzsgc2NoZW1hIGluIG1pZ3JhdGlvbnMvMDAwMV92Zl9nYXRlLnNxbClcclxuLy8gIC0gbWVtb3J5U3RvcmUoKTogTWFwcyAodml0ZXN0ICsgdml0ZSBkZXYsIG5vbi1wZXJzaXN0ZW50KVxyXG4vLyBJbXBvcnQtb25seSAodW5kZXJzY29yZSBwcmVmaXggXHUyMDE0IG5ldmVyIHJvdXRlZCkuXHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbWVtb3J5U3RvcmUoKSB7XHJcbiAgY29uc3Qgcm93cyA9IG5ldyBNYXAoKSAvLyBpZCAtPiByb3dcclxuICBjb25zdCBjb3VudGVycyA9IG5ldyBNYXAoKSAvLyBgJHtrZXlJZH18JHt3aW5kb3d9YCAtPiBjb3VudFxyXG4gIGNvbnN0IHVzYWdlID0gbmV3IE1hcCgpIC8vIGAke2tleUlkfXwke2RheX18JHtlbmRwb2ludH1gIC0+IGNvdW50XHJcbiAgY29uc3QgcHViID0gKHsga2V5X2hhc2g6IF9vbWl0LCAuLi5yZXN0IH0pID0+IHJlc3QgLy8gc3RyaXAgdGhlIGhhc2ggZnJvbSBwdWJsaWMgcm93c1xyXG4gIHJldHVybiB7XHJcbiAgICBfdXNhZ2U6IHVzYWdlLFxyXG4gICAga2V5czoge1xyXG4gICAgICBhc3luYyBpbnNlcnQocm93KSB7XHJcbiAgICAgICAgcm93cy5zZXQocm93LmlkLCB7IC4uLnJvdyB9KVxyXG4gICAgICB9LFxyXG4gICAgICBhc3luYyBnZXRCeUhhc2goaGFzaCkge1xyXG4gICAgICAgIGZvciAoY29uc3QgciBvZiByb3dzLnZhbHVlcygpKSBpZiAoci5rZXlfaGFzaCA9PT0gaGFzaCkgcmV0dXJuIHsgLi4uciB9XHJcbiAgICAgICAgcmV0dXJuIG51bGxcclxuICAgICAgfSxcclxuICAgICAgYXN5bmMgbGlzdChvd25lcikge1xyXG4gICAgICAgIHJldHVybiBbLi4ucm93cy52YWx1ZXMoKV0uZmlsdGVyKChyKSA9PiByLm93bmVyID09PSBvd25lcikubWFwKHB1YilcclxuICAgICAgfSxcclxuICAgICAgYXN5bmMgcmV2b2tlKGlkLCBvd25lcikge1xyXG4gICAgICAgIGNvbnN0IHIgPSByb3dzLmdldChpZClcclxuICAgICAgICBpZiAoIXIgfHwgci5vd25lciAhPT0gb3duZXIpIHJldHVybiBmYWxzZVxyXG4gICAgICAgIHIuZW5hYmxlZCA9IDBcclxuICAgICAgICByZXR1cm4gdHJ1ZVxyXG4gICAgICB9LFxyXG4gICAgICBhc3luYyB0b3VjaChpZCwgdHMpIHtcclxuICAgICAgICBjb25zdCByID0gcm93cy5nZXQoaWQpXHJcbiAgICAgICAgaWYgKHIpIHIubGFzdF91c2VkX2F0ID0gdHNcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgICBjb3VudGVyczoge1xyXG4gICAgICBhc3luYyBidW1wKGtleUlkLCB3aW5kb3dTdGFydCkge1xyXG4gICAgICAgIGNvbnN0IGsgPSBgJHtrZXlJZH18JHt3aW5kb3dTdGFydH1gXHJcbiAgICAgICAgY29uc3QgbiA9IChjb3VudGVycy5nZXQoaykgfHwgMCkgKyAxXHJcbiAgICAgICAgY291bnRlcnMuc2V0KGssIG4pXHJcbiAgICAgICAgcmV0dXJuIG5cclxuICAgICAgfSxcclxuICAgICAgYXN5bmMgcHJ1bmVCZWZvcmUodHMpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGsgb2YgY291bnRlcnMua2V5cygpKSBpZiAoTnVtYmVyKGsuc3BsaXQoJ3wnKVsxXSkgPCB0cykgY291bnRlcnMuZGVsZXRlKGspXHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gICAgdXNhZ2U6IHtcclxuICAgICAgYXN5bmMgbG9nKGtleUlkLCBkYXksIGVuZHBvaW50KSB7XHJcbiAgICAgICAgY29uc3QgayA9IGAke2tleUlkfXwke2RheX18JHtlbmRwb2ludH1gXHJcbiAgICAgICAgdXNhZ2Uuc2V0KGssICh1c2FnZS5nZXQoaykgfHwgMCkgKyAxKVxyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBkMVN0b3JlKGRiKSB7XHJcbiAgcmV0dXJuIHtcclxuICAgIGtleXM6IHtcclxuICAgICAgYXN5bmMgaW5zZXJ0KHIpIHtcclxuICAgICAgICBhd2FpdCBkYlxyXG4gICAgICAgICAgLnByZXBhcmUoXHJcbiAgICAgICAgICAgIGBJTlNFUlQgSU5UTyBhcGlfa2V5cyAoaWQsIGtleV9oYXNoLCBrZXlfaGludCwgb3duZXIsIHNjb3BlcywgcmF0ZV9saW1pdCwgZXhwaXJlc19hdCwgZW5hYmxlZCwgY3JlYXRlZF9hdCwgbGFzdF91c2VkX2F0KVxyXG4gICAgICAgICAgICAgVkFMVUVTICg/LD8sPyw/LD8sPyw/LD8sPyw/KWBcclxuICAgICAgICAgIClcclxuICAgICAgICAgIC5iaW5kKFxyXG4gICAgICAgICAgICByLmlkLFxyXG4gICAgICAgICAgICByLmtleV9oYXNoLFxyXG4gICAgICAgICAgICByLmtleV9oaW50LFxyXG4gICAgICAgICAgICByLm93bmVyLFxyXG4gICAgICAgICAgICByLnNjb3BlcyxcclxuICAgICAgICAgICAgci5yYXRlX2xpbWl0LFxyXG4gICAgICAgICAgICByLmV4cGlyZXNfYXQsXHJcbiAgICAgICAgICAgIHIuZW5hYmxlZCxcclxuICAgICAgICAgICAgci5jcmVhdGVkX2F0LFxyXG4gICAgICAgICAgICByLmxhc3RfdXNlZF9hdFxyXG4gICAgICAgICAgKVxyXG4gICAgICAgICAgLnJ1bigpXHJcbiAgICAgIH0sXHJcbiAgICAgIGFzeW5jIGdldEJ5SGFzaChoYXNoKSB7XHJcbiAgICAgICAgcmV0dXJuIChcclxuICAgICAgICAgIChhd2FpdCBkYi5wcmVwYXJlKGBTRUxFQ1QgKiBGUk9NIGFwaV9rZXlzIFdIRVJFIGtleV9oYXNoID0gP2ApLmJpbmQoaGFzaCkuZmlyc3QoKSkgPz8gbnVsbFxyXG4gICAgICAgIClcclxuICAgICAgfSxcclxuICAgICAgYXN5bmMgbGlzdChvd25lcikge1xyXG4gICAgICAgIGNvbnN0IHsgcmVzdWx0cyB9ID0gYXdhaXQgZGJcclxuICAgICAgICAgIC5wcmVwYXJlKFxyXG4gICAgICAgICAgICBgU0VMRUNUIGlkLCBrZXlfaGludCwgb3duZXIsIHNjb3BlcywgcmF0ZV9saW1pdCwgZXhwaXJlc19hdCwgZW5hYmxlZCwgY3JlYXRlZF9hdCwgbGFzdF91c2VkX2F0XHJcbiAgICAgICAgICAgICBGUk9NIGFwaV9rZXlzIFdIRVJFIG93bmVyID0gPyBPUkRFUiBCWSBjcmVhdGVkX2F0IERFU0NgXHJcbiAgICAgICAgICApXHJcbiAgICAgICAgICAuYmluZChvd25lcilcclxuICAgICAgICAgIC5hbGwoKVxyXG4gICAgICAgIHJldHVybiByZXN1bHRzID8/IFtdXHJcbiAgICAgIH0sXHJcbiAgICAgIGFzeW5jIHJldm9rZShpZCwgb3duZXIpIHtcclxuICAgICAgICBjb25zdCByID0gYXdhaXQgZGJcclxuICAgICAgICAgIC5wcmVwYXJlKGBVUERBVEUgYXBpX2tleXMgU0VUIGVuYWJsZWQgPSAwIFdIRVJFIGlkID0gPyBBTkQgb3duZXIgPSA/YClcclxuICAgICAgICAgIC5iaW5kKGlkLCBvd25lcilcclxuICAgICAgICAgIC5ydW4oKVxyXG4gICAgICAgIHJldHVybiAoci5tZXRhPy5jaGFuZ2VzID8/IDApID4gMFxyXG4gICAgICB9LFxyXG4gICAgICBhc3luYyB0b3VjaChpZCwgdHMpIHtcclxuICAgICAgICBhd2FpdCBkYi5wcmVwYXJlKGBVUERBVEUgYXBpX2tleXMgU0VUIGxhc3RfdXNlZF9hdCA9ID8gV0hFUkUgaWQgPSA/YCkuYmluZCh0cywgaWQpLnJ1bigpXHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gICAgY291bnRlcnM6IHtcclxuICAgICAgYXN5bmMgYnVtcChrZXlJZCwgd2luZG93U3RhcnQpIHtcclxuICAgICAgICBjb25zdCByb3cgPSBhd2FpdCBkYlxyXG4gICAgICAgICAgLnByZXBhcmUoXHJcbiAgICAgICAgICAgIGBJTlNFUlQgSU5UTyB1c2FnZV9jb3VudGVycyAoa2V5X2lkLCB3aW5kb3dfc3RhcnQsIGNvdW50KSBWQUxVRVMgKD8sPywxKVxyXG4gICAgICAgICAgICAgT04gQ09ORkxJQ1Qoa2V5X2lkLCB3aW5kb3dfc3RhcnQpIERPIFVQREFURSBTRVQgY291bnQgPSBjb3VudCArIDFcclxuICAgICAgICAgICAgIFJFVFVSTklORyBjb3VudGBcclxuICAgICAgICAgIClcclxuICAgICAgICAgIC5iaW5kKGtleUlkLCB3aW5kb3dTdGFydClcclxuICAgICAgICAgIC5maXJzdCgpXHJcbiAgICAgICAgcmV0dXJuIHJvdz8uY291bnQgPz8gMVxyXG4gICAgICB9LFxyXG4gICAgICBhc3luYyBwcnVuZUJlZm9yZSh0cykge1xyXG4gICAgICAgIGF3YWl0IGRiLnByZXBhcmUoYERFTEVURSBGUk9NIHVzYWdlX2NvdW50ZXJzIFdIRVJFIHdpbmRvd19zdGFydCA8ID9gKS5iaW5kKHRzKS5ydW4oKVxyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICAgIHVzYWdlOiB7XHJcbiAgICAgIGFzeW5jIGxvZyhrZXlJZCwgZGF5LCBlbmRwb2ludCkge1xyXG4gICAgICAgIGF3YWl0IGRiXHJcbiAgICAgICAgICAucHJlcGFyZShcclxuICAgICAgICAgICAgYElOU0VSVCBJTlRPIHVzYWdlX2xvZyAoa2V5X2lkLCBkYXksIGVuZHBvaW50LCBjb3VudCkgVkFMVUVTICg/LD8sPywxKVxyXG4gICAgICAgICAgICAgT04gQ09ORkxJQ1Qoa2V5X2lkLCBkYXksIGVuZHBvaW50KSBETyBVUERBVEUgU0VUIGNvdW50ID0gY291bnQgKyAxYFxyXG4gICAgICAgICAgKVxyXG4gICAgICAgICAgLmJpbmQoa2V5SWQsIGRheSwgZW5kcG9pbnQpXHJcbiAgICAgICAgICAucnVuKClcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgfVxyXG59XHJcblxyXG5sZXQgX2RldlN0b3JlID0gbnVsbFxyXG5leHBvcnQgZnVuY3Rpb24gc3RvcmVGcm9tKHJlcSkge1xyXG4gIGNvbnN0IGRiID0gcmVxPy5lbnY/LlZGX0RCXHJcbiAgaWYgKGRiKSByZXR1cm4gZDFTdG9yZShkYilcclxuICBpZiAoIV9kZXZTdG9yZSkgX2RldlN0b3JlID0gbWVtb3J5U3RvcmUoKVxyXG4gIHJldHVybiBfZGV2U3RvcmVcclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmZcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvX2tleXN0b3JlLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvX2tleXN0b3JlLmpzXCI7Ly8gVkYga2V5IGxpZmVjeWNsZS4gS2V5czogdmZfPGVudj5fICsgYmFzZTYyKDMyIGJ5dGVzIENTUFJORykuIEF0IHJlc3Q6IFNIQS0yNTYgaGV4IG9ubHkuXHJcbi8vIFBsYWluIFNIQS0yNTYgKG5vdCBhcmdvbjIpOiAyNTYtYml0IHJhbmRvbSBrZXlzIGFyZSB1bi1icnV0ZWZvcmNlYWJsZTsgc2xvdyBoYXNoZXNcclxuLy8gb25seSBhZGQgcGVyLXJlcXVlc3QgbGF0ZW5jeS5cclxuXHJcbmV4cG9ydCBjb25zdCBTQ09QRVMgPSBbJ3N0cmF0ZWd5JywgJ21hcmtldCcsICd0eCcsICdzdWJtaXQnLCAnc2NhbiddXHJcblxyXG5jb25zdCBCNjIgPSAnMDEyMzQ1Njc4OUFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXonXHJcblxyXG4vLyBQcm9wZXIgYmFzZS02MiBlbmNvZGluZyBvZiB0aGUgYnl0ZSBhcnJheSBhcyBvbmUgYmlnLWVuZGlhbiBpbnRlZ2VyLlxyXG4vLyAzMiBieXRlcyAoMjU2IGJpdHMpIFx1MjE5MiA0MyBjaGFyczsgbGVmdC1wYWQgdG8gYHdpZHRoYCBzbyBsZW5ndGggaXMgZGV0ZXJtaW5pc3RpY1xyXG4vLyAoYSByYXcgYmlnLWludCBlbmNvZGluZyBvZiBhIHZhbHVlIHdpdGggc21hbGwgbGVhZGluZyBieXRlcyBjb3VsZCBiZSBzaG9ydGVyKS5cclxuZnVuY3Rpb24gYmFzZTYyKGJ5dGVzLCB3aWR0aCkge1xyXG4gIGxldCBudW0gPSAwblxyXG4gIGZvciAoY29uc3QgYiBvZiBieXRlcykgbnVtID0gKG51bSA8PCA4bikgfCBCaWdJbnQoYilcclxuICBsZXQgb3V0ID0gJydcclxuICB3aGlsZSAobnVtID4gMG4pIHtcclxuICAgIG91dCA9IEI2MltOdW1iZXIobnVtICUgNjJuKV0gKyBvdXRcclxuICAgIG51bSAvPSA2Mm5cclxuICB9XHJcbiAgcmV0dXJuIHdpZHRoID8gb3V0LnBhZFN0YXJ0KHdpZHRoLCAnMCcpIDogb3V0IHx8ICcwJ1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVLZXkoZW52KSB7XHJcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheSgzMilcclxuICBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ5dGVzKVxyXG4gIHJldHVybiBgdmZfJHtlbnZ9XyR7YmFzZTYyKGJ5dGVzLCA0Myl9YFxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2hhMjU2SGV4KHRleHQpIHtcclxuICBjb25zdCBkaWdlc3QgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmRpZ2VzdCgnU0hBLTI1NicsIG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSh0ZXh0KSlcclxuICByZXR1cm4gWy4uLm5ldyBVaW50OEFycmF5KGRpZ2VzdCldLm1hcCgoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgJzAnKSkuam9pbignJylcclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGlzc3VlS2V5KHN0b3JlLCB7IG93bmVyLCBzY29wZXMsIHJhdGVMaW1pdCwgZW52LCBleHBpcmVzQXQgfSkge1xyXG4gIGNvbnN0IGtleSA9IGdlbmVyYXRlS2V5KGVudilcclxuICBjb25zdCBpZEJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoOClcclxuICBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGlkQnl0ZXMpXHJcbiAgY29uc3QgaWQgPSBgdmZrXyR7YmFzZTYyKGlkQnl0ZXMpfWBcclxuICBjb25zdCBoaW50ID0ga2V5LnNsaWNlKDAsIDEyKSArICdcdTIwMjYnXHJcbiAgYXdhaXQgc3RvcmUua2V5cy5pbnNlcnQoe1xyXG4gICAgaWQsXHJcbiAgICBrZXlfaGFzaDogYXdhaXQgc2hhMjU2SGV4KGtleSksXHJcbiAgICBrZXlfaGludDogaGludCxcclxuICAgIG93bmVyLFxyXG4gICAgc2NvcGVzOiBKU09OLnN0cmluZ2lmeShzY29wZXMpLFxyXG4gICAgcmF0ZV9saW1pdDogcmF0ZUxpbWl0LFxyXG4gICAgZXhwaXJlc19hdDogZXhwaXJlc0F0ID8/IG51bGwsXHJcbiAgICBlbmFibGVkOiAxLFxyXG4gICAgY3JlYXRlZF9hdDogTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCksXHJcbiAgICBsYXN0X3VzZWRfYXQ6IG51bGwsXHJcbiAgfSlcclxuICByZXR1cm4geyBpZCwga2V5LCBoaW50IH1cclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHZlcmlmeUtleShzdG9yZSwgcGxhaW50ZXh0LCBub3dNcyA9IERhdGUubm93KCkpIHtcclxuICAvLyBXZWxsLWZvcm1lZG5lc3Mgb25seSAocHJlZml4ICsgYWxwaGFudW1lcmljICsgcGxhdXNpYmxlIGxlbmd0aCkuIFJlYWwga2V5cyBhcmUgNDNcclxuICAvLyBjaGFyczsga2VlcCB0aGUgZmxvb3IgYXQgMzIgc28gYSBzaG9ydGVyLWJ1dC1zaGFwZWQgdG9rZW4gaXMgJ3Vua25vd24nLCBub3QgJ21hbGZvcm1lZCcuXHJcbiAgaWYgKHR5cGVvZiBwbGFpbnRleHQgIT09ICdzdHJpbmcnIHx8ICEvXnZmXyh0ZXN0fGxpdmUpX1swLTlBLVphLXpdezMyLH0kLy50ZXN0KHBsYWludGV4dCkpIHtcclxuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWFsZm9ybWVkJyB9XHJcbiAgfVxyXG4gIGNvbnN0IHJvdyA9IGF3YWl0IHN0b3JlLmtleXMuZ2V0QnlIYXNoKGF3YWl0IHNoYTI1NkhleChwbGFpbnRleHQpKVxyXG4gIGlmICghcm93KSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ3Vua25vd24nIH1cclxuICBpZiAoIXJvdy5lbmFibGVkKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ3Jldm9rZWQnIH1cclxuICBpZiAocm93LmV4cGlyZXNfYXQgJiYgbm93TXMgLyAxMDAwID4gcm93LmV4cGlyZXNfYXQpIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnZXhwaXJlZCcgfVxyXG4gIHJldHVybiB7IG9rOiB0cnVlLCBrZXlJZDogcm93LmlkLCBzY29wZXM6IEpTT04ucGFyc2Uocm93LnNjb3BlcyksIHJhdGVMaW1pdDogcm93LnJhdGVfbGltaXQgfVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmV2b2tlS2V5KHN0b3JlLCBpZCwgb3duZXIpIHtcclxuICByZXR1cm4gc3RvcmUua2V5cy5yZXZva2UoaWQsIG93bmVyKVxyXG59XHJcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92ZlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9fdmZhdXRoLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvX3ZmYXV0aC5qc1wiOy8vIEdhdGV3YXkgYXV0aC4gVGhlIEJlYXJlciB2Zl8ga2V5IElTIHRoZSBhdXRoZW50aWNhdGlvbiBcdTIwMTQgbm8gT3JpZ2luIHJlcXVpcmVtZW50XHJcbi8vICh0aGlyZC1wYXJ0eSBzZXJ2ZXJzIHNlbmQgbm8gT3JpZ2luKS4gQ09SUyBhbGxvdy1hbGwgb24gdmYgZW5kcG9pbnRzIGlzIHNldCBieVxyXG4vLyB0aGUgcm91dGVyOyBhYnVzZSBpcyBib3VuZGVkIHBlci1rZXkgKyBwZXItc2NvcGUtZ2xvYmFsIGhlcmUuXHJcbmltcG9ydCB7IHZlcmlmeUtleSB9IGZyb20gJy4vX2tleXN0b3JlLmpzJ1xyXG5pbXBvcnQgeyB2ZXJpZnlKd3QgfSBmcm9tICcuL19qd3QuanMnXHJcblxyXG5leHBvcnQgY29uc3QgV0lORE9XX01TID0gNjBfMDAwXHJcblxyXG5jb25zdCBzZW5kID0gKHJlcywgc3RhdHVzLCBvYmosIGhlYWRlcnMgPSB7fSkgPT4ge1xyXG4gIHJlcy5zdGF0dXNDb2RlID0gc3RhdHVzXHJcbiAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKVxyXG4gIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGhlYWRlcnMpKSByZXMuc2V0SGVhZGVyKGssIHYpXHJcbiAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShvYmopKVxyXG4gIHJldHVybiBudWxsXHJcbn1cclxuXHJcbmNvbnN0IGJlYXJlciA9IChyZXEpID0+IHtcclxuICBjb25zdCBoID0gcmVxLmhlYWRlcnM/LmF1dGhvcml6YXRpb24gfHwgJydcclxuICByZXR1cm4gaC5zdGFydHNXaXRoKCdCZWFyZXIgJykgPyBoLnNsaWNlKDcpLnRyaW0oKSA6ICcnXHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXF1aXJlVmZLZXkoXHJcbiAgcmVxLFxyXG4gIHJlcyxcclxuICBzdG9yZSxcclxuICB7IHNjb3BlLCBlbmRwb2ludCA9IHNjb3BlLCBub3dNcyA9IERhdGUubm93KCkgfVxyXG4pIHtcclxuICBjb25zdCB0b2tlbiA9IGJlYXJlcihyZXEpXHJcbiAgaWYgKCF0b2tlbikgcmV0dXJuIHNlbmQocmVzLCA0MDEsIHsgZXJyb3I6ICdNaXNzaW5nIEFQSSBrZXknIH0pXHJcbiAgY29uc3QgdiA9IGF3YWl0IHZlcmlmeUtleShzdG9yZSwgdG9rZW4sIG5vd01zKVxyXG4gIGlmICghdi5vaykgcmV0dXJuIHNlbmQocmVzLCA0MDEsIHsgZXJyb3I6ICdJbnZhbGlkIEFQSSBrZXknIH0pIC8vIHJlYXNvbiBub3QgZWNob2VkXHJcbiAgaWYgKCF2LnNjb3Blcy5pbmNsdWRlcyhzY29wZSkpIHJldHVybiBzZW5kKHJlcywgNDAzLCB7IGVycm9yOiAnT3V0IG9mIHNjb3BlJyB9KVxyXG5cclxuICBjb25zdCB3aW5kb3dTdGFydCA9IE1hdGguZmxvb3Iobm93TXMgLyBXSU5ET1dfTVMpICogV0lORE9XX01TXHJcbiAgY29uc3QgY291bnQgPSBhd2FpdCBzdG9yZS5jb3VudGVycy5idW1wKHYua2V5SWQsIHdpbmRvd1N0YXJ0KVxyXG4gIGlmIChjb3VudCA+IHYucmF0ZUxpbWl0KSB7XHJcbiAgICBjb25zdCByZXRyeSA9IE1hdGguY2VpbCgod2luZG93U3RhcnQgKyBXSU5ET1dfTVMgLSBub3dNcykgLyAxMDAwKVxyXG4gICAgcmV0dXJuIHNlbmQocmVzLCA0MjksIHsgZXJyb3I6ICdUb28gbWFueSByZXF1ZXN0cycgfSwgeyAnUmV0cnktQWZ0ZXInOiBTdHJpbmcocmV0cnkpIH0pXHJcbiAgfVxyXG5cclxuICBjb25zdCBkYXkgPSBuZXcgRGF0ZShub3dNcykudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMClcclxuICBjb25zdCBkYXlTdGFydCA9IERhdGUucGFyc2UoZGF5KVxyXG4gIGNvbnN0IGNhcCA9IE51bWJlcihwcm9jZXNzLmVudi5WRl9HTE9CQUxfREFJTFlfQ0FQIHx8IDUwMDApXHJcbiAgY29uc3QgZ2xvYmFsQ291bnQgPSBhd2FpdCBzdG9yZS5jb3VudGVycy5idW1wKGBfX2dsb2JhbDoke3Njb3BlfWAsIGRheVN0YXJ0KVxyXG4gIGlmIChnbG9iYWxDb3VudCA+IGNhcCkgcmV0dXJuIHNlbmQocmVzLCA1MDMsIHsgZXJyb3I6ICdEYWlseSBidWRnZXQgZXhoYXVzdGVkJyB9KVxyXG5cclxuICBhd2FpdCBzdG9yZS51c2FnZS5sb2codi5rZXlJZCwgZGF5LCBlbmRwb2ludClcclxuICBhd2FpdCBzdG9yZS5rZXlzLnRvdWNoKHYua2V5SWQsIE1hdGguZmxvb3Iobm93TXMgLyAxMDAwKSlcclxuICAvLyBsYXp5IHBydW5lOiBkcm9wIHdpbmRvd3Mgb2xkZXIgdGhhbiAyIHdpbmRvd3MgKGtlZXBzIGRhaWx5IF9fZ2xvYmFsIHJvd3MpXHJcbiAgYXdhaXQgc3RvcmUuY291bnRlcnMucHJ1bmVCZWZvcmUoXHJcbiAgICB3aW5kb3dTdGFydCAtIDIgKiBXSU5ET1dfTVMgPiBkYXlTdGFydCA/IGRheVN0YXJ0IDogd2luZG93U3RhcnQgLSAyICogV0lORE9XX01TXHJcbiAgKVxyXG4gIHJldHVybiB7IGtleUlkOiB2LmtleUlkLCBzY29wZXM6IHYuc2NvcGVzIH1cclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlcXVpcmVKd3QocmVxLCByZXMpIHtcclxuICBjb25zdCBzZWNyZXQgPSBwcm9jZXNzLmVudi5WRl9KV1RfU0VDUkVUXHJcbiAgaWYgKCFzZWNyZXQpIHJldHVybiBzZW5kKHJlcywgNTAzLCB7IGNvbmZpZ3VyZWQ6IGZhbHNlLCBlcnJvcjogJ1BvcnRhbCBhdXRoIG5vdCBjb25maWd1cmVkJyB9KVxyXG4gIGNvbnN0IHBheWxvYWQgPSBhd2FpdCB2ZXJpZnlKd3QoYmVhcmVyKHJlcSksIHNlY3JldClcclxuICBpZiAoIXBheWxvYWQ/LnN1YikgcmV0dXJuIHNlbmQocmVzLCA0MDEsIHsgZXJyb3I6ICdJbnZhbGlkIHNlc3Npb24nIH0pXHJcbiAgcmV0dXJuIHBheWxvYWRcclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9zcmMvc3RyYXRlZ3lcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9zcmMvc3RyYXRlZ3kvdmF1bHRGYWN0c1NuYXBzaG90LmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9zcmMvc3RyYXRlZ3kvdmF1bHRGYWN0c1NuYXBzaG90LmpzXCI7Ly8gQ3VyYXRlZCBlbGlnaWJpbGl0eSBmYWN0cy4gTlVNRVJJQyBmYWN0cyAodHZsKSBhcmUgbGl2ZS1yZWZyZXNoZWQgYXQgcnVudGltZSBieSB2YXVsdEZhY3RzTGl2ZS5qc1xyXG4vLyAoRGVGaUxsYW1hKSwgd2hpY2ggb3ZlcmxheXMgdGhlbSBhdCByZXNvbHZlKCkgdGltZTsgdGhpcyBtb2R1bGUgaXMgdGhlIFFVQUxJVEFUSVZFIHNvdXJjZSBvZlxyXG4vLyByZWNvcmQgKGF1ZGl0LCBhZG1pbktleSwgb3JhY2xlVHlwZSwgcG9vbENsYXNzIFx1MjAxNCBubyBwdWJsaWMgQVBJIHN0YXRlcyB0aGVzZSByZWxpYWJseSkgQU5EIHRoZVxyXG4vLyBvZmZsaW5lIGZhbGxiYWNrIHdoZW4gdGhlIGxpdmUgZmV0Y2ggZmFpbHMuIHJlZnJlc2hWYXVsdEZhY3RzLm1qcyByZW1haW5zIHRoZSBvZmZsaW5lIHNuYXBzaG90XHJcbi8vIHVwZGF0ZXIuIFByb3ZlbmFuY2UgaG9uZXN0eTogYXNPZiBpcyB0aGUgQ0FQVFVSRSBkYXRlLCBuZXZlciBEYXRlLm5vdygpLlxyXG5leHBvcnQgY29uc3QgQ0FQVFVSRURfQVQgPSBEYXRlLnBhcnNlKCcyMDI2LTA2LTI4VDAwOjAwOjAwWicpXHJcblxyXG5jb25zdCBmID0gKHZhbHVlKSA9PiAoeyB2YWx1ZSwgc291cmNlOiAnc25hcHNob3QnLCBhc09mOiBDQVBUVVJFRF9BVCB9KVxyXG5cclxuLy8gQXVkaXRlZCBsZW5kaW5nIHByb3RvY29scyAoY2F0YWxvZyB1bml2ZXJzZSkuIERpc3RyaWJ1dGlvbnMgfiByZXZlbnVlID0+IHJhdGlvIH4xID0+IHJlYWwuXHJcbmNvbnN0IGF1ZGl0ZWQgPSAob3ZlcikgPT4gKHtcclxuICBhbm51YWxpemVkRGlzdHJpYnV0ZWQ6IGYoMV8wMDBfMDAwKSxcclxuICBwcm90b2NvbFJldmVudWU6IGYoMV8wNTBfMDAwKSxcclxuICBhdWRpdDogZignYXVkaXRlZCcpLFxyXG4gIGFnZURheXM6IGYoMzY1KSxcclxuICB0dmw6IGYoMjVfMDAwXzAwMCksXHJcbiAgYWRtaW5LZXk6IGYoJ3RpbWVsb2NrX211bHRpc2lnJyksXHJcbiAgLy8gTGlmZWJvYXQgRjggZmFjdHMgXHUyMDE0IFBMQUNFSE9MREVSIHNuYXBzaG90IHZhbHVlcyAoc2FtZSBwcm92ZW5hbmNlIGRpc2NpcGxpbmUgYXMgYWJvdmUpO1xyXG4gIC8vIHZlcmlmeSB2aWEgcmVmcmVzaFZhdWx0RmFjdHMubWpzIGJlZm9yZSB0aGUgZGVtby5cclxuICBvcmFjbGVUeXBlOiBmKCdjaXJjdWl0X2JyZWFrZXInKSxcclxuICBjb2xsYXRlcmFsTGlxdWlkaXR5RGVwdGhVc2Q6IGYoMV8wMDBfMDAwKSxcclxuICBwb29sQ2xhc3M6IGYoJ2N1cmF0ZWQnKSxcclxuICBzdXBwbGllckNvbmNlbnRyYXRpb25QY3Q6IGYoMjUpLFxyXG4gIC4uLm92ZXIsXHJcbn0pXHJcblxyXG5leHBvcnQgY29uc3QgU05BUFNIT1QgPSB7XHJcbiAgLy8gVGhlIHByb2R1Y3QncyBvd24gdmV0dGVkIHZhdWx0IChzaW5nbGUtY2hhaW4gU3RlbGxhci9Tb3JvYmFuIEJsZW5kIFVTREMpLiBTYW1lXHJcbiAgLy8gUExBQ0VIT0xERVItcHJvdmVuYW5jZSBkaXNjaXBsaW5lIGFzIHRoZSByZXN0IFx1MjAxNCByZWZyZXNoIGJlZm9yZSBkZW1vLlxyXG4gICdibGVuZC11c2RjJzogeyBmYWN0czogYXVkaXRlZCgpLCBtZXRhOiB7IGxhYmVsOiAnQmxlbmQgVVNEQyAoU3RlbGxhciknIH0gfSxcclxuICAnYWF2ZS12Myc6IHsgZmFjdHM6IGF1ZGl0ZWQoKSwgbWV0YTogeyBsYWJlbDogJ0FhdmUgdjMgKG1haW5uZXQpJyB9IH0sXHJcbiAgJ21vcnBoby1ibHVlJzoge1xyXG4gICAgZmFjdHM6IGF1ZGl0ZWQoeyB0dmw6IGYoMTJfMDAwXzAwMCksIGFkbWluS2V5OiBmKCdtdWx0aXNpZycpIH0pLFxyXG4gICAgbWV0YTogeyBsYWJlbDogJ01vcnBobyBCbHVlIChtYWlubmV0KScgfSxcclxuICB9LFxyXG4gICdwZW5kbGUtdjInOiB7XHJcbiAgICBmYWN0czogYXVkaXRlZCh7IGFnZURheXM6IGYoNTQwKSwgdHZsOiBmKDhfMDAwXzAwMCkgfSksXHJcbiAgICBtZXRhOiB7IGxhYmVsOiAnUGVuZGxlIChtYWlubmV0KScgfSxcclxuICB9LFxyXG4gIGZsdWlkOiB7XHJcbiAgICBmYWN0czogYXVkaXRlZCh7IHR2bDogZig1XzAwMF8wMDApLCBhZG1pbktleTogZignbXVsdGlzaWcnKSB9KSxcclxuICAgIG1ldGE6IHsgbGFiZWw6ICdGbHVpZCAobWFpbm5ldCknIH0sXHJcbiAgfSxcclxuICAvLyBDb250cm9sbGVkIGRlbW8gZml4dHVyZSBcdTIwMTQgaWxsdXN0cmF0ZXMgcmVqZWN0aW9uLiBOT1QgYSByZWFsIHZhdWx0LlxyXG4gIGh5cGVyZmFybToge1xyXG4gICAgZmFjdHM6IHtcclxuICAgICAgYW5udWFsaXplZERpc3RyaWJ1dGVkOiBmKDEwXzAwMF8wMDApLFxyXG4gICAgICBwcm90b2NvbFJldmVudWU6IGYoM18wMDBfMDAwKSxcclxuICAgICAgYXVkaXQ6IGYoJ25vbmUnKSxcclxuICAgICAgYWdlRGF5czogZig0KSxcclxuICAgICAgdHZsOiBmKDUwXzAwMCksXHJcbiAgICAgIGFkbWluS2V5OiBmKCdlb2EnKSxcclxuICAgICAgb3JhY2xlVHlwZTogZigndndhcF9ub19icmVha2VyJyksXHJcbiAgICAgIGNvbGxhdGVyYWxMaXF1aWRpdHlEZXB0aFVzZDogZig0MF8wMDApLFxyXG4gICAgICBwb29sQ2xhc3M6IGYoJ2NvbW11bml0eScpLFxyXG4gICAgICBzdXBwbGllckNvbmNlbnRyYXRpb25QY3Q6IGYoODApLFxyXG4gICAgfSxcclxuICAgIG1ldGE6IHsgaXNGaXh0dXJlOiB0cnVlLCBsYWJlbDogJ2RlbW8gZml4dHVyZSBcdTIwMTQgaWxsdXN0cmF0ZXMgcmVqZWN0aW9uJyB9LFxyXG4gIH0sXHJcbn1cclxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvc3JjL3N0cmF0ZWd5XCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvc3JjL3N0cmF0ZWd5L3ZhdWx0RmFjdHNMaXZlLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9zcmMvc3RyYXRlZ3kvdmF1bHRGYWN0c0xpdmUuanNcIjsvLyBMaXZlIE5VTUVSSUMgZmFjdHMgZm9yIHRoZSBlbGlnaWJpbGl0eSBnYXRlIChzcGVjIFx1MDBBNzUpLiBEZUZpTGxhbWEgaXMgdGhlIG9ubHkgc291cmNlIGFuZCBvbmx5XHJcbi8vIG51bWJlcnMgYXJlIHJlZnJlc2hlZCBcdTIwMTQgcXVhbGl0YXRpdmUgZmFjdHMgKGF1ZGl0LCBhZG1pbktleSwgb3JhY2xlVHlwZSwgcG9vbENsYXNzKSBzdGF5IGN1cmF0ZWRcclxuLy8gaW4gdmF1bHRGYWN0c1NuYXBzaG90LmpzIGJlY2F1c2Ugbm8gcHVibGljIEFQSSBzdGF0ZXMgdGhlbSByZWxpYWJseS4gRmFpbC1vcGVuIHRvIHNuYXBzaG90OlxyXG4vLyBhbnkgZmV0Y2gvcGFyc2UgcHJvYmxlbSBsZWF2ZXMgcHJvdmVuYW5jZSAnc25hcHNob3QnIGFuZCBuZXZlciBibG9ja3MgdGhlIGZsb3cuXHJcbi8vIEltcG9ydHMgU05BUFNIT1QgZnJvbSB2YXVsdEZhY3RzU25hcHNob3QuanMgZGlyZWN0bHkgKG5vdCB2YXVsdEZhY3RzLmpzKSBzbyB0aGVyZSBpcyBubyBpbXBvcnRcclxuLy8gY3ljbGUgd2l0aCB2YXVsdEZhY3RzLmpzLCB3aGljaCBpbXBvcnRzIGdldExpdmVPdmVybGF5IGZyb20gaGVyZS5cclxuaW1wb3J0IHsgU05BUFNIT1QgfSBmcm9tICcuL3ZhdWx0RmFjdHNTbmFwc2hvdC5qcydcclxuXHJcbmNvbnN0IFRUTF9NUyA9IDYgKiA2MCAqIDYwICogMTAwMFxyXG5jb25zdCBDQUNIRV9LRVkgPSAndmZfdmF1bHRfZmFjdHNfbGl2ZV92MSdcclxuXHJcbi8vIHByb3RvY29sIHNsdWcgaW4gU05BUFNIT1QgLT4gRGVGaUxsYW1hIHByb3RvY29sIHNsdWcgKGFwaS5sbGFtYS5maS90dmwvPHNsdWc+IC0+IG51bWJlcikuXHJcbi8vICdibGVuZC11c2RjJyBpcyB0aGUgcHJvZHVjdCdzIG93biBTdGVsbGFyIHZhdWx0IFx1MjAxNCBEZUZpTGxhbWEgdHJhY2tzIEJsZW5kIGFzIGEgcHJvdG9jb2wuXHJcbmNvbnN0IExMQU1BX1NMVUcgPSB7XHJcbiAgJ2JsZW5kLXVzZGMnOiAnYmxlbmQnLFxyXG4gICdhYXZlLXYzJzogJ2FhdmUtdjMnLFxyXG4gICdtb3JwaG8tYmx1ZSc6ICdtb3JwaG8tYmx1ZScsXHJcbiAgJ3BlbmRsZS12Mic6ICdwZW5kbGUnLFxyXG4gIGZsdWlkOiAnZmx1aWQnLFxyXG59XHJcblxyXG5sZXQgb3ZlcmxheXMgPSBudWxsIC8vIHsgW3Byb3RvY29sXTogeyByZWZyZXNoZWQ6IHsgdHZsIH0sIGFzT2YgfSB9XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0U3RvcmFnZSgpIHtcclxuICB0cnkge1xyXG4gICAgcmV0dXJuIHR5cGVvZiBsb2NhbFN0b3JhZ2UgIT09ICd1bmRlZmluZWQnID8gbG9jYWxTdG9yYWdlIDogbnVsbFxyXG4gIH0gY2F0Y2gge1xyXG4gICAgcmV0dXJuIG51bGxcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBnZXRMaXZlT3ZlcmxheShwcm90b2NvbCkge1xyXG4gIHJldHVybiBvdmVybGF5cz8uW3Byb3RvY29sXSA/PyBudWxsXHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcmltZVZhdWx0RmFjdHMoe1xyXG4gIGZldGNoSW1wbCA9IGZldGNoLFxyXG4gIHN0b3JhZ2UgPSBkZWZhdWx0U3RvcmFnZSgpLFxyXG4gIG5vdyA9ICgpID0+IERhdGUubm93KCksXHJcbn0gPSB7fSkge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBjYWNoZWQgPSBzdG9yYWdlPy5nZXRJdGVtKENBQ0hFX0tFWSlcclxuICAgIGlmIChjYWNoZWQpIHtcclxuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShjYWNoZWQpXHJcbiAgICAgIGlmIChub3coKSAtIHBhcnNlZC5mZXRjaGVkQXQgPCBUVExfTVMpIHtcclxuICAgICAgICBvdmVybGF5cyA9IHBhcnNlZC5vdmVybGF5c1xyXG4gICAgICAgIHJldHVyblxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfSBjYXRjaCB7XHJcbiAgICAvKiBjb3JydXB0ZWQgY2FjaGUgLT4gcmVmZXRjaCAqL1xyXG4gIH1cclxuXHJcbiAgY29uc3QgbmV4dCA9IHt9XHJcbiAgY29uc3Qgc2x1Z3MgPSBPYmplY3QuZW50cmllcyhTTkFQU0hPVCkuZmlsdGVyKChbLCBlXSkgPT4gIWUubWV0YT8uaXNGaXh0dXJlKVxyXG4gIGF3YWl0IFByb21pc2UuYWxsKFxyXG4gICAgc2x1Z3MubWFwKGFzeW5jIChbcHJvdG9jb2xdKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNsdWcgPSBMTEFNQV9TTFVHW3Byb3RvY29sXVxyXG4gICAgICBpZiAoIXNsdWcpIHJldHVybiAvLyB1bmtub3duIG1hcHBpbmcgLT4ga2VlcCBzbmFwc2hvdFxyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoSW1wbChgaHR0cHM6Ly9hcGkubGxhbWEuZmkvdHZsLyR7c2x1Z31gKVxyXG4gICAgICAgIGlmICghcmVzLm9rKSByZXR1cm5cclxuICAgICAgICBjb25zdCB0dmwgPSBOdW1iZXIoYXdhaXQgcmVzLmpzb24oKSlcclxuICAgICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKHR2bCkgJiYgdHZsID4gMCkgbmV4dFtwcm90b2NvbF0gPSB7IHJlZnJlc2hlZDogeyB0dmwgfSwgYXNPZjogbm93KCkgfVxyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvKiBvbmUgc2x1ZyBmYWlsaW5nIG11c3Qgbm90IHBvaXNvbiB0aGUgcmVzdCAqL1xyXG4gICAgICB9XHJcbiAgICB9KVxyXG4gIClcclxuXHJcbiAgaWYgKE9iamVjdC5rZXlzKG5leHQpLmxlbmd0aCA+IDApIHtcclxuICAgIG92ZXJsYXlzID0gbmV4dFxyXG4gICAgdHJ5IHtcclxuICAgICAgc3RvcmFnZT8uc2V0SXRlbShDQUNIRV9LRVksIEpTT04uc3RyaW5naWZ5KHsgZmV0Y2hlZEF0OiBub3coKSwgb3ZlcmxheXM6IG5leHQgfSkpXHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgLyogcXVvdGEgKi9cclxuICAgIH1cclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBjb25zdCBfdGVzdCA9IHtcclxuICByZXNldDogKCkgPT4ge1xyXG4gICAgb3ZlcmxheXMgPSBudWxsXHJcbiAgfSxcclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9zcmMvc3RyYXRlZ3lcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9zcmMvc3RyYXRlZ3kvdmF1bHRGYWN0cy5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvc3JjL3N0cmF0ZWd5L3ZhdWx0RmFjdHMuanNcIjsvLyBEYXRhIGxheWVyIGZvciB0aGUgZWxpZ2liaWxpdHkgZ2F0ZS4gU25hcHNob3QtZmlyc3QgZm9yIHF1YWxpdGF0aXZlIGZhY3RzOyBOVU1FUklDIGZhY3RzICh0dmwpXHJcbi8vIGFyZSBvdmVybGFpZCBhdCBydW50aW1lIGZyb20gRGVGaUxsYW1hIHZpYSB2YXVsdEZhY3RzTGl2ZS5qcyB3aGVuIGFuIG92ZXJsYXkgaXMgcHJlc2VudCAoaXRcclxuLy8gcHJpbWVzIG9uIGFwcCBtb3VudCBhbmQgY2FjaGVzIDZoKS4gTm8gb3ZlcmxheSAtPiBwdXJlIHNuYXBzaG90LCBzbyB0ZXN0cyArIHRoZSBvZmZsaW5lIHBhdGhcclxuLy8gYXJlIHVuY2hhbmdlZC4gZ2V0TGl2ZU92ZXJsYXkgcmVhZHMgYSBtb2R1bGUtbG9jYWwgbWFwIGZpbGxlZCBieSBwcmltZVZhdWx0RmFjdHMgKGxhenkgY2FsbFxyXG4vLyB0aW1lKSwgc28gdGhlcmUgaXMgbm8gaW1wb3J0IGN5Y2xlIGV2ZW4gdGhvdWdoIHZhdWx0RmFjdHNMaXZlIGltcG9ydHMgdGhlIHNuYXBzaG90LlxyXG5pbXBvcnQgeyBTTkFQU0hPVCB9IGZyb20gJy4vdmF1bHRGYWN0c1NuYXBzaG90LmpzJ1xyXG5pbXBvcnQgeyBnZXRMaXZlT3ZlcmxheSB9IGZyb20gJy4vdmF1bHRGYWN0c0xpdmUuanMnXHJcblxyXG4vKiogQHJldHVybnMge3sgcHJvdG9jb2w6c3RyaW5nLCBpc0ZpeHR1cmU6Ym9vbGVhbiwgZmFjdHM6b2JqZWN0IH19ICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlKHByb3RvY29sKSB7XHJcbiAgY29uc3QgZW50cnkgPSBTTkFQU0hPVFtwcm90b2NvbF1cclxuICBpZiAoIWVudHJ5KSB0aHJvdyBuZXcgRXJyb3IoYG5vIGVsaWdpYmlsaXR5IGZhY3RzIGZvciBwcm90b2NvbDogJHtwcm90b2NvbH1gKVxyXG4gIGNvbnN0IGxpdmUgPSBnZXRMaXZlT3ZlcmxheShwcm90b2NvbClcclxuICBjb25zdCBtZXJnZWQgPSBsaXZlID8gYXBwbHlSZWZyZXNoKGVudHJ5LCBsaXZlLnJlZnJlc2hlZCwgbGl2ZS5hc09mKSA6IGVudHJ5XHJcbiAgcmV0dXJuIHsgcHJvdG9jb2wsIGlzRml4dHVyZTogISFlbnRyeS5tZXRhPy5pc0ZpeHR1cmUsIGZhY3RzOiBtZXJnZWQuZmFjdHMgfVxyXG59XHJcblxyXG5leHBvcnQgeyBTTkFQU0hPVCB9XHJcblxyXG4vKiogUHJvdmVuYW5jZS1zYWZlIG1lcmdlOiBvbmx5IGZ1bGx5LXJlZnJlc2hlZCBmaWVsZHMgYmVjb21lIHNvdXJjZTonbGl2ZScgd2l0aCBhIG5ldyBhc09mLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlSZWZyZXNoKGVudHJ5LCByZWZyZXNoZWQsIG5vd01zKSB7XHJcbiAgY29uc3QgZmFjdHMgPSB7IC4uLmVudHJ5LmZhY3RzIH1cclxuICBmb3IgKGNvbnN0IFtrLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocmVmcmVzaGVkKSkge1xyXG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIGNvbnRpbnVlIC8vIGZhaWx1cmUvcGFydGlhbCBcdTIxOTIga2VlcCBzbmFwc2hvdFxyXG4gICAgZmFjdHNba10gPSB7IHZhbHVlLCBzb3VyY2U6ICdsaXZlJywgYXNPZjogbm93TXMgfVxyXG4gIH1cclxuICByZXR1cm4geyAuLi5lbnRyeSwgZmFjdHMgfVxyXG59XHJcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92ZlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi92YXVsdC1mYWN0cy5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmL3ZhdWx0LWZhY3RzLmpzXCI7aW1wb3J0IHsgcmVzb2x2ZSBhcyByZXNvbHZlVmF1bHRGYWN0cyB9IGZyb20gJy4uLy4uL3NyYy9zdHJhdGVneS92YXVsdEZhY3RzLmpzJ1xyXG5pbXBvcnQgeyBzdG9yZUZyb20gfSBmcm9tICcuL19kYi5qcydcclxuaW1wb3J0IHsgcmVxdWlyZVZmS2V5IH0gZnJvbSAnLi9fdmZhdXRoLmpzJ1xyXG5cclxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihyZXEsIHJlcykge1xyXG4gIGNvbnN0IGN0eCA9IGF3YWl0IHJlcXVpcmVWZktleShyZXEsIHJlcywgc3RvcmVGcm9tKHJlcSksIHsgc2NvcGU6ICdtYXJrZXQnIH0pXHJcbiAgaWYgKCFjdHgpIHJldHVyblxyXG4gIGNvbnN0IHByb3RvY29sID0gbmV3IFVSTChyZXEudXJsLCAnaHR0cDovL2xvY2FsJykuc2VhcmNoUGFyYW1zLmdldCgncHJvdG9jb2wnKSB8fCAnYmxlbmQtdXNkYydcclxuICByZXMuc3RhdHVzQ29kZSA9IDIwMFxyXG4gIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJylcclxuICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHJlc29sdmVWYXVsdEZhY3RzKHByb3RvY29sKSkpXHJcbn1cclxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvc3JjL3N0cmF0ZWd5XCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvc3JjL3N0cmF0ZWd5L2VsaWdpYmlsaXR5R2F0ZS5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvc3JjL3N0cmF0ZWd5L2VsaWdpYmlsaXR5R2F0ZS5qc1wiOy8vIFB1cmUsIGRldGVybWluaXN0aWMsIGZhaWwtY2xvc2VkIGVsaWdpYmlsaXR5IGdhdGUgKEY4KS4gTm8gSS9PIFx1MjAxNCBhbGwgZmFjdHMgYXJyaXZlIHJlc29sdmVkLlxyXG4vLyBBIGZhY3QgZmllbGQgaXMgeyB2YWx1ZSwgc291cmNlOiAnbGl2ZSd8J3NuYXBzaG90JywgYXNPZjogZXBvY2hNcyB9LlxyXG5cclxuZXhwb3J0IGNvbnN0IFBPTlpJX1JBVElPX01BWCA9IDEuNVxyXG5leHBvcnQgY29uc3QgU0VDVVJJVFlfTUlOID0gNjBcclxuZXhwb3J0IGNvbnN0IEFHRV9DQVBfREFZUyA9IDE4MFxyXG5leHBvcnQgY29uc3QgVFZMX0ZMT09SID0gMTAwXzAwMFxyXG5leHBvcnQgY29uc3QgVFZMX0NBUCA9IDEwMF8wMDBfMDAwXHJcbmV4cG9ydCBjb25zdCBBR0VfV0VJR0hUID0gMC4zXHJcbmV4cG9ydCBjb25zdCBUVkxfV0VJR0hUID0gMC40XHJcbmV4cG9ydCBjb25zdCBBRE1JTl9XRUlHSFQgPSAwLjNcclxuZXhwb3J0IGNvbnN0IEFETUlOX0xFVkVMUyA9IHsgdGltZWxvY2tfbXVsdGlzaWc6IDEuMCwgbXVsdGlzaWc6IDAuNywgdGltZWxvY2s6IDAuNSwgZW9hOiAwLjAgfVxyXG5leHBvcnQgY29uc3QgTUFYX0ZBQ1RfQUdFX01TID0gMzAgKiA4Nl80MDBfMDAwXHJcbmV4cG9ydCBjb25zdCBNQVhfVE9LRU5fQUdFX01TID0gMTUgKiA2MF8wMDBcclxuZXhwb3J0IGNvbnN0IE1JTl9DT0xMQVRFUkFMX0xJUVVJRElUWV9VU0QgPSAyNTBfMDAwXHJcbmV4cG9ydCBjb25zdCBNQVhfU1VQUExJRVJfQ09OQ0VOVFJBVElPTl9QQ1QgPSA0MFxyXG5leHBvcnQgY29uc3QgT1JBQ0xFX1RZUEVTX09LID0gWydjaXJjdWl0X2JyZWFrZXInXVxyXG5leHBvcnQgY29uc3QgUkVRVUlSRURfRkFDVFMgPSBbXHJcbiAgJ2FubnVhbGl6ZWREaXN0cmlidXRlZCcsXHJcbiAgJ3Byb3RvY29sUmV2ZW51ZScsXHJcbiAgJ2F1ZGl0JyxcclxuICAnYWdlRGF5cycsXHJcbiAgJ3R2bCcsXHJcbiAgJ2FkbWluS2V5JyxcclxuICAvLyBMaWZlYm9hdCBGOCBleHRlbnNpb24gXHUyMDE0IG1hcHMgdGhlIFlpZWxkQmxveCBwb3N0LW1vcnRlbSAob3JhY2xlIG1pc2NvbmZpZ3VyYXRpb24gb24gYVxyXG4gIC8vIGNvbW11bml0eSBwb29sKSBvbnRvIHByZS1lbnRyeSBzY3JlZW5pbmcuIEZhaWwtY2xvc2VkIGxpa2UgZXZlcnl0aGluZyBlbHNlIGhlcmUuXHJcbiAgJ29yYWNsZVR5cGUnLFxyXG4gICdjb2xsYXRlcmFsTGlxdWlkaXR5RGVwdGhVc2QnLFxyXG4gICdwb29sQ2xhc3MnLFxyXG4gICdzdXBwbGllckNvbmNlbnRyYXRpb25QY3QnLFxyXG5dXHJcblxyXG4vKiogQSBmYWN0IGZpZWxkIGlzIHByZXNlbnQgaWZmIGl0IGhhcyBhIG5vbi1udWxsIHZhbHVlIGFuZCBpcyBub3Qgc3RhbGUuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBmYWN0UHJlc2VudChmaWVsZCwgbm93TXMpIHtcclxuICBpZiAoIWZpZWxkIHx8IGZpZWxkLnZhbHVlID09IG51bGwpIHJldHVybiBmYWxzZVxyXG4gIGlmICh0eXBlb2YgZmllbGQuYXNPZiAhPT0gJ251bWJlcicpIHJldHVybiBmYWxzZVxyXG4gIHJldHVybiBub3dNcyAtIGZpZWxkLmFzT2YgPD0gTUFYX0ZBQ1RfQUdFX01TXHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBhbGxSZXF1aXJlZEZhY3RzUHJlc2VudChmYWN0cywgbm93TXMpIHtcclxuICByZXR1cm4gUkVRVUlSRURfRkFDVFMuZXZlcnkoKGspID0+IGZhY3RQcmVzZW50KGZhY3RzPy5ba10sIG5vd01zKSlcclxufVxyXG5cclxuZnVuY3Rpb24gcG9zKGZpZWxkKSB7XHJcbiAgY29uc3QgdiA9IGZpZWxkPy52YWx1ZVxyXG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ251bWJlcicgJiYgdiA+IDAgPyB2IDogbnVsbFxyXG59XHJcblxyXG4vKiogVGVzdCAxIFx1MjAxNCBjbG9zZXMgcHJvYmxlbSAjNSAocG9uemkgQVBZKS4gQm90aCBvcGVyYW5kcyBtdXN0IGJlIHBvc2l0aXZlIHZlcmlmaWVkIG51bWJlcnMuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB5aWVsZFJlYWxpdHkoZmFjdHMpIHtcclxuICBjb25zdCBkaXN0ID0gcG9zKGZhY3RzPy5hbm51YWxpemVkRGlzdHJpYnV0ZWQpXHJcbiAgY29uc3QgcmV2ID0gcG9zKGZhY3RzPy5wcm90b2NvbFJldmVudWUpXHJcbiAgaWYgKGRpc3QgPT0gbnVsbCB8fCByZXYgPT0gbnVsbCkge1xyXG4gICAgcmV0dXJuIHsgcmF0aW86IG51bGwsIHZlcmRpY3Q6ICd1bmtub3duJywgaW5wdXRzOiB7IGRpc3QsIHJldiB9IH1cclxuICB9XHJcbiAgY29uc3QgcmF0aW8gPSBkaXN0IC8gcmV2XHJcbiAgcmV0dXJuIHsgcmF0aW8sIHZlcmRpY3Q6IHJhdGlvIDwgUE9OWklfUkFUSU9fTUFYID8gJ3JlYWwnIDogJ3BvbnppJywgaW5wdXRzOiB7IGRpc3QsIHJldiB9IH1cclxufVxyXG5cclxuY29uc3QgY2xhbXAwMSA9ICh4KSA9PiBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCB4KSlcclxuXHJcbi8qKiBUZXN0IDIgXHUyMDE0IGNsb3NlcyBwcm9ibGVtICM0IChleHBsb2l0L2hhY2spLiBBdWRpdCBpcyBhIEhBUkQgZ2F0ZTsgc2NvcmUgZ3JhZGVzIHRoZSByZXN0LiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2VjdXJpdHlTY29yZShmYWN0cykge1xyXG4gIGNvbnN0IGF1ZGl0R2F0ZSA9IGZhY3RzPy5hdWRpdD8udmFsdWUgPT09ICdhdWRpdGVkJyA/ICdwYXNzJyA6ICdmYWlsJ1xyXG4gIGNvbnN0IGFnZVNpZyA9IGNsYW1wMDEoKGZhY3RzPy5hZ2VEYXlzPy52YWx1ZSA/PyAwKSAvIEFHRV9DQVBfREFZUylcclxuICBjb25zdCB0dmwgPSBmYWN0cz8udHZsPy52YWx1ZSA/PyAwXHJcbiAgY29uc3QgdHZsU2lnID1cclxuICAgIHR2bCA8PSAwXHJcbiAgICAgID8gMFxyXG4gICAgICA6IGNsYW1wMDEoXHJcbiAgICAgICAgICAoTWF0aC5sb2cxMCh0dmwpIC0gTWF0aC5sb2cxMChUVkxfRkxPT1IpKSAvIChNYXRoLmxvZzEwKFRWTF9DQVApIC0gTWF0aC5sb2cxMChUVkxfRkxPT1IpKVxyXG4gICAgICAgIClcclxuICBjb25zdCBhZG1pblNpZyA9IEFETUlOX0xFVkVMU1tmYWN0cz8uYWRtaW5LZXk/LnZhbHVlXSA/PyAwXHJcbiAgY29uc3Qgc2NvcmUgPSBNYXRoLnJvdW5kKFxyXG4gICAgMTAwICogKEFHRV9XRUlHSFQgKiBhZ2VTaWcgKyBUVkxfV0VJR0hUICogdHZsU2lnICsgQURNSU5fV0VJR0hUICogYWRtaW5TaWcpXHJcbiAgKVxyXG4gIHJldHVybiB7IHNjb3JlLCBhdWRpdEdhdGUsIGNvbXBvbmVudHM6IHsgYWdlOiBhZ2VTaWcsIHR2bDogdHZsU2lnLCBhZG1pbktleTogYWRtaW5TaWcgfSB9XHJcbn1cclxuXHJcbi8qKiBDb21iaW5lIHRoZSB0d28gdGVzdHMgaW50byBhIGZhaWwtY2xvc2VkIHZlcmRpY3QuIG5vd01zIGRlZmF1bHRzIHRvIERhdGUubm93KCkgaW4gcHJvZHVjdGlvbi4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGV2YWx1YXRlKGlucHV0LCBub3dNcyA9IERhdGUubm93KCkpIHtcclxuICBjb25zdCB7IHByb3RvY29sLCBmYWN0cywgaXNGaXh0dXJlID0gZmFsc2UgfSA9IGlucHV0XHJcbiAgY29uc3QgcmVhc29ucyA9IFtdXHJcbiAgY29uc3QgcHJlc2VudCA9IGFsbFJlcXVpcmVkRmFjdHNQcmVzZW50KGZhY3RzLCBub3dNcylcclxuICBpZiAoIXByZXNlbnQpIHJlYXNvbnMucHVzaCgnbWlzc2luZyBvciBzdGFsZSByZXF1aXJlZCBkYXRhJylcclxuICBjb25zdCB5ciA9IHlpZWxkUmVhbGl0eShmYWN0cylcclxuICBpZiAoeXIudmVyZGljdCA9PT0gJ3BvbnppJylcclxuICAgIHJlYXNvbnMucHVzaChgeWllbGQvcmV2ZW51ZSByYXRpbyAke3lyLnJhdGlvLnRvRml4ZWQoMil9IChwb256aSA+PSAke1BPTlpJX1JBVElPX01BWH0pYClcclxuICBpZiAoeXIudmVyZGljdCA9PT0gJ3Vua25vd24nKSByZWFzb25zLnB1c2goJ3lpZWxkL3JldmVudWUgdW52ZXJpZmlhYmxlJylcclxuICBjb25zdCBzZWMgPSBzZWN1cml0eVNjb3JlKGZhY3RzKVxyXG4gIGlmIChzZWMuYXVkaXRHYXRlID09PSAnZmFpbCcpIHJlYXNvbnMucHVzaCgndW5hdWRpdGVkIChhdWRpdCBnYXRlKScpXHJcbiAgaWYgKHNlYy5zY29yZSA8IFNFQ1VSSVRZX01JTilcclxuICAgIHJlYXNvbnMucHVzaChgc2VjdXJpdHkgJHtzZWMuc2NvcmV9LzEwMCAob3VyIHdlaWdodGluZykgYmVsb3cgJHtTRUNVUklUWV9NSU59YClcclxuICAvLyBMaWZlYm9hdCBGOCBzY3JlZW5pbmcgXHUyMDE0IHRoZSBwYXNzaXZlIGhhbGYgb2YgdGhlIGxpZmVib2F0OiB0aGUgZXhwbG9pdCBjbGFzcyB0aGF0IGFjdHVhbGx5XHJcbiAgLy8gaGl0IEJsZW5kIChZaWVsZEJsb3gsIDIwMjYtMDItMjIpIGlzIHByZXZlbnRhYmxlIGhlcmUsIG5vdCBieSBhbnkgcmVhY3Rpb24gcmFkYXIuXHJcbiAgaWYgKGZhY3RzPy5wb29sQ2xhc3M/LnZhbHVlICE9IG51bGwgJiYgZmFjdHMucG9vbENsYXNzLnZhbHVlICE9PSAnY3VyYXRlZCcpXHJcbiAgICByZWFzb25zLnB1c2goJ2NvbW11bml0eS1tYW5hZ2VkIHBvb2wnKVxyXG4gIGlmIChmYWN0cz8ub3JhY2xlVHlwZT8udmFsdWUgIT0gbnVsbCAmJiAhT1JBQ0xFX1RZUEVTX09LLmluY2x1ZGVzKGZhY3RzLm9yYWNsZVR5cGUudmFsdWUpKVxyXG4gICAgcmVhc29ucy5wdXNoKCdvcmFjbGUgd2l0aG91dCBjaXJjdWl0IGJyZWFrZXInKVxyXG4gIGlmIChcclxuICAgIGZhY3RzPy5jb2xsYXRlcmFsTGlxdWlkaXR5RGVwdGhVc2Q/LnZhbHVlICE9IG51bGwgJiZcclxuICAgIGZhY3RzLmNvbGxhdGVyYWxMaXF1aWRpdHlEZXB0aFVzZC52YWx1ZSA8IE1JTl9DT0xMQVRFUkFMX0xJUVVJRElUWV9VU0RcclxuICApXHJcbiAgICByZWFzb25zLnB1c2goJ3RoaW4gY29sbGF0ZXJhbCBsaXF1aWRpdHknKVxyXG4gIGlmIChcclxuICAgIGZhY3RzPy5zdXBwbGllckNvbmNlbnRyYXRpb25QY3Q/LnZhbHVlICE9IG51bGwgJiZcclxuICAgIGZhY3RzLnN1cHBsaWVyQ29uY2VudHJhdGlvblBjdC52YWx1ZSA+IE1BWF9TVVBQTElFUl9DT05DRU5UUkFUSU9OX1BDVFxyXG4gIClcclxuICAgIHJlYXNvbnMucHVzaCgnc3VwcGxpZXIgY29uY2VudHJhdGlvbiB0b28gaGlnaCcpXHJcbiAgLy8gRmFpbC1jbG9zZWQ6IGFuIGFkbWluS2V5IHZhbHVlIG91dHNpZGUgQURNSU5fTEVWRUxTIGlzIHVudmVyaWZpYWJsZSBnb3Zlcm5hbmNlIFx1MjAxNCByZWplY3QgaXRcclxuICAvLyByYXRoZXIgdGhhbiBzaWxlbnRseSBzY29yaW5nIGl0IDAgKHdoaWNoIHdvdWxkIGNvbmZsYXRlIFwidW5rbm93blwiIHdpdGggdGhlIGtub3duLXdvcnN0IFwiZW9hXCIpLlxyXG4gIGNvbnN0IGFkbWluS25vd24gPSBBRE1JTl9MRVZFTFNbZmFjdHM/LmFkbWluS2V5Py52YWx1ZV0gIT0gbnVsbFxyXG4gIGlmIChwcmVzZW50ICYmICFhZG1pbktub3duKSByZWFzb25zLnB1c2goJ3VucmVjb2duaXplZCBnb3Zlcm5hbmNlIGtleSAodW52ZXJpZmlhYmxlKScpXHJcbiAgY29uc3QgbGlmZWJvYXRTY3JlZW5PayA9XHJcbiAgICBmYWN0cz8ucG9vbENsYXNzPy52YWx1ZSA9PT0gJ2N1cmF0ZWQnICYmXHJcbiAgICBPUkFDTEVfVFlQRVNfT0suaW5jbHVkZXMoZmFjdHM/Lm9yYWNsZVR5cGU/LnZhbHVlKSAmJlxyXG4gICAgKGZhY3RzPy5jb2xsYXRlcmFsTGlxdWlkaXR5RGVwdGhVc2Q/LnZhbHVlID8/IDApID49IE1JTl9DT0xMQVRFUkFMX0xJUVVJRElUWV9VU0QgJiZcclxuICAgIChmYWN0cz8uc3VwcGxpZXJDb25jZW50cmF0aW9uUGN0Py52YWx1ZSA/PyAxMDEpIDw9IE1BWF9TVVBQTElFUl9DT05DRU5UUkFUSU9OX1BDVFxyXG4gIGNvbnN0IGVsaWdpYmxlID1cclxuICAgIHByZXNlbnQgJiZcclxuICAgIGFkbWluS25vd24gJiZcclxuICAgIGxpZmVib2F0U2NyZWVuT2sgJiZcclxuICAgIHlyLnZlcmRpY3QgPT09ICdyZWFsJyAmJlxyXG4gICAgc2VjLmF1ZGl0R2F0ZSA9PT0gJ3Bhc3MnICYmXHJcbiAgICBzZWMuc2NvcmUgPj0gU0VDVVJJVFlfTUlOXHJcbiAgcmV0dXJuIHsgcHJvdG9jb2wsIGVsaWdpYmxlLCB5aWVsZFJlYWxpdHk6IHlyLCBzZWN1cml0eTogc2VjLCByZWFzb25zLCBpc0ZpeHR1cmUsIGZhY3RzIH1cclxufVxyXG5cclxuZnVuY3Rpb24gaGFzaFZlcmRpY3QodmVyZGljdCkge1xyXG4gIGNvbnN0IGJhc2lzID0gYCR7dmVyZGljdC5wcm90b2NvbH18JHt2ZXJkaWN0LnlpZWxkUmVhbGl0eT8udmVyZGljdH18JHt2ZXJkaWN0LnNlY3VyaXR5Py5zY29yZX18JHt2ZXJkaWN0LnNlY3VyaXR5Py5hdWRpdEdhdGV9YFxyXG4gIGxldCBoID0gMFxyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYmFzaXMubGVuZ3RoOyBpKyspIGggPSAoTWF0aC5pbXVsKDMxLCBoKSArIGJhc2lzLmNoYXJDb2RlQXQoaSkpIHwgMFxyXG4gIHJldHVybiBTdHJpbmcoaCA+Pj4gMClcclxufVxyXG5cclxuLyoqIEludGVybmFsIGZhaWwtY2xvc2VkIGFzc2VydGlvbiB0b2tlbiAoTk9UIGEgc2VjdXJpdHkgYm91bmRhcnkgXHUyMDE0IHRoZSBvbi1jaGFpbiBzY29wZSBib3VuZHMgbWFsaWNlKS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG1pbnRUb2tlbih2ZXJkaWN0LCBwbGFuSW5kZXgsIG5vd01zID0gRGF0ZS5ub3coKSkge1xyXG4gIGlmICghdmVyZGljdC5lbGlnaWJsZSkgdGhyb3cgbmV3IEVycm9yKCdjYW5ub3QgbWludCB0b2tlbiBmb3IgaW5lbGlnaWJsZSB2ZXJkaWN0JylcclxuICByZXR1cm4ge1xyXG4gICAgcHJvdG9jb2xTbHVnOiB2ZXJkaWN0LnByb3RvY29sLFxyXG4gICAgcGxhbkluZGV4LFxyXG4gICAgZWxpZ2libGU6IHRydWUsXHJcbiAgICB2ZXJkaWN0SGFzaDogaGFzaFZlcmRpY3QodmVyZGljdCksXHJcbiAgICBhc09mOiBub3dNcyxcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB2ZXJpZnlUb2tlbih0b2tlbiwgdmVyZGljdCwgbm93TXMgPSBEYXRlLm5vdygpKSB7XHJcbiAgaWYgKCF0b2tlbiB8fCB0b2tlbi5lbGlnaWJsZSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlXHJcbiAgaWYgKG5vd01zIC0gdG9rZW4uYXNPZiA+IE1BWF9UT0tFTl9BR0VfTVMpIHJldHVybiBmYWxzZVxyXG4gIHJldHVybiB0b2tlbi52ZXJkaWN0SGFzaCA9PT0gaGFzaFZlcmRpY3QodmVyZGljdClcclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmZcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvZWxpZ2liaWxpdHkuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9lbGlnaWJpbGl0eS5qc1wiO2ltcG9ydCB7IGV2YWx1YXRlIH0gZnJvbSAnLi4vLi4vc3JjL3N0cmF0ZWd5L2VsaWdpYmlsaXR5R2F0ZS5qcydcclxuaW1wb3J0IHsgcmVzb2x2ZSBhcyByZXNvbHZlVmF1bHRGYWN0cyB9IGZyb20gJy4uLy4uL3NyYy9zdHJhdGVneS92YXVsdEZhY3RzLmpzJ1xyXG5pbXBvcnQgeyBzdG9yZUZyb20gfSBmcm9tICcuL19kYi5qcydcclxuaW1wb3J0IHsgcmVxdWlyZVZmS2V5IH0gZnJvbSAnLi9fdmZhdXRoLmpzJ1xyXG5cclxuY29uc3QgYmlnaW50U2FmZSA9IChfLCB2KSA9PiAodHlwZW9mIHYgPT09ICdiaWdpbnQnID8gdi50b1N0cmluZygpIDogdilcclxuY29uc3QganNvbiA9IChyZXMsIHN0YXR1cywgb2JqKSA9PiB7XHJcbiAgcmVzLnN0YXR1c0NvZGUgPSBzdGF0dXNcclxuICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpXHJcbiAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShvYmosIGJpZ2ludFNhZmUpKVxyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKHJlcSwgcmVzKSB7XHJcbiAgY29uc3QgY3R4ID0gYXdhaXQgcmVxdWlyZVZmS2V5KHJlcSwgcmVzLCBzdG9yZUZyb20ocmVxKSwge1xyXG4gICAgc2NvcGU6ICdtYXJrZXQnLFxyXG4gICAgZW5kcG9pbnQ6ICdlbGlnaWJpbGl0eScsXHJcbiAgfSlcclxuICBpZiAoIWN0eCkgcmV0dXJuXHJcbiAgY29uc3QgeyB2YXVsdCwgYW1vdW50LCBwcm90b2NvbCB9ID0gcmVxLmJvZHkgPz8ge31cclxuICBsZXQgYW10XHJcbiAgdHJ5IHtcclxuICAgIGFtdCA9IEJpZ0ludChhbW91bnQpXHJcbiAgfSBjYXRjaCB7XHJcbiAgICByZXR1cm4ganNvbihyZXMsIDQwMCwgeyBlcnJvcjogJ0ludmFsaWQgYW1vdW50JyB9KVxyXG4gIH1cclxuICBpZiAodHlwZW9mIHZhdWx0ICE9PSAnc3RyaW5nJyB8fCAhdmF1bHQpIHJldHVybiBqc29uKHJlcywgNDAwLCB7IGVycm9yOiAnTWlzc2luZyB2YXVsdCcgfSlcclxuICBjb25zdCB7IGZhY3RzIH0gPSByZXNvbHZlVmF1bHRGYWN0cyhwcm90b2NvbCB8fCAnYmxlbmQtdXNkYycpXHJcbiAgY29uc3QgdmVyZGljdCA9IGV2YWx1YXRlKHsgdmF1bHQsIGFtb3VudDogYW10LCBmYWN0cyB9KVxyXG4gIGpzb24ocmVzLCAyMDAsIHtcclxuICAgIGFsbG93OiB2ZXJkaWN0LmVsaWdpYmxlID8/IGZhbHNlLFxyXG4gICAgdmVyZGljdCxcclxuICAgIHJlYXNvbnM6IHZlcmRpY3QucmVhc29ucyA/PyBbXSxcclxuICB9KVxyXG59XHJcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92ZlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9wcmljZXMuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9wcmljZXMuanNcIjsvLyBEZUZpTGxhbWEgY29pbnMgQVBJIFx1MjAxNCBrZXlsZXNzIHVwc3RyZWFtLiBodHRwczovL2NvaW5zLmxsYW1hLmZpL3ByaWNlcy9jdXJyZW50L3tjb2luc31cclxuaW1wb3J0IHsgc3RvcmVGcm9tIH0gZnJvbSAnLi9fZGIuanMnXHJcbmltcG9ydCB7IHJlcXVpcmVWZktleSB9IGZyb20gJy4vX3ZmYXV0aC5qcydcclxuXHJcbmNvbnN0IERFRkFVTFRfQ09JTlMgPSAnY29pbmdlY2tvOnN0ZWxsYXIsY29pbmdlY2tvOnVzZC1jb2luJ1xyXG5cclxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihyZXEsIHJlcykge1xyXG4gIGNvbnN0IGN0eCA9IGF3YWl0IHJlcXVpcmVWZktleShyZXEsIHJlcywgc3RvcmVGcm9tKHJlcSksIHsgc2NvcGU6ICdtYXJrZXQnIH0pXHJcbiAgaWYgKCFjdHgpIHJldHVyblxyXG4gIGNvbnN0IGNvaW5zID0gbmV3IFVSTChyZXEudXJsLCAnaHR0cDovL2xvY2FsJykuc2VhcmNoUGFyYW1zLmdldCgnY29pbnMnKSB8fCBERUZBVUxUX0NPSU5TXHJcbiAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKVxyXG4gIHRyeSB7XHJcbiAgICBjb25zdCB1cHN0cmVhbSA9IGF3YWl0IGZldGNoKFxyXG4gICAgICBgaHR0cHM6Ly9jb2lucy5sbGFtYS5maS9wcmljZXMvY3VycmVudC8ke2VuY29kZVVSSUNvbXBvbmVudChjb2lucyl9YCxcclxuICAgICAgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNTAwMCkgfVxyXG4gICAgKVxyXG4gICAgaWYgKCF1cHN0cmVhbS5vaykgdGhyb3cgbmV3IEVycm9yKCdiYWQgc3RhdHVzJylcclxuICAgIHJlcy5zdGF0dXNDb2RlID0gMjAwXHJcbiAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGF3YWl0IHVwc3RyZWFtLmpzb24oKSkpXHJcbiAgfSBjYXRjaCB7XHJcbiAgICByZXMuc3RhdHVzQ29kZSA9IDUwMlxyXG4gICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAndXBzdHJlYW0nIH0pKSAvLyBuZXZlciBsZWFrIHByb3ZpZGVyIGRldGFpbFxyXG4gIH1cclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmZcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvYnVpbGQtdHguanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9idWlsZC10eC5qc1wiOy8vIEJ1aWxkcyBhbiBVTlNJR05FRCBTb3JvYmFuIHZhdWx0IGRlcG9zaXQgdHguIE5vbi1jdXN0b2RpYWw6IHNpZ25pbmcgaGFwcGVucyBvbi1kZXZpY2UuXHJcbmltcG9ydCB7IHN0b3JlRnJvbSB9IGZyb20gJy4vX2RiLmpzJ1xyXG5pbXBvcnQgeyByZXF1aXJlVmZLZXkgfSBmcm9tICcuL192ZmF1dGguanMnXHJcblxyXG5jb25zdCBqc29uID0gKHJlcywgc3RhdHVzLCBvYmopID0+IHtcclxuICByZXMuc3RhdHVzQ29kZSA9IHN0YXR1c1xyXG4gIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJylcclxuICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KG9iaikpXHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZERlcG9zaXRDb3JlKHsgZnJvbSwgYW1vdW50LCB2YXVsdCwgcGFzc3BocmFzZSwgcnBjU2VydmVyIH0pIHtcclxuICBjb25zdCB7IENvbnRyYWN0LCBUcmFuc2FjdGlvbkJ1aWxkZXIsIEFkZHJlc3MsIG5hdGl2ZVRvU2NWYWwsIEJBU0VfRkVFIH0gPVxyXG4gICAgYXdhaXQgaW1wb3J0KCdAc3RlbGxhci9zdGVsbGFyLXNkaycpXHJcbiAgY29uc3QgYWNjb3VudCA9IGF3YWl0IHJwY1NlcnZlci5nZXRBY2NvdW50KGZyb20pXHJcbiAgY29uc3QgY29udHJhY3QgPSBuZXcgQ29udHJhY3QodmF1bHQpXHJcbiAgY29uc3QgdHggPSBuZXcgVHJhbnNhY3Rpb25CdWlsZGVyKGFjY291bnQsIHsgZmVlOiBCQVNFX0ZFRSwgbmV0d29ya1Bhc3NwaHJhc2U6IHBhc3NwaHJhc2UgfSlcclxuICAgIC5hZGRPcGVyYXRpb24oXHJcbiAgICAgIGNvbnRyYWN0LmNhbGwoJ2RlcG9zaXQnLCBuZXcgQWRkcmVzcyhmcm9tKS50b1NjVmFsKCksIG5hdGl2ZVRvU2NWYWwoYW1vdW50LCB7IHR5cGU6ICdpMTI4JyB9KSlcclxuICAgIClcclxuICAgIC5zZXRUaW1lb3V0KDMwMClcclxuICAgIC5idWlsZCgpXHJcbiAgY29uc3QgcHJlcGFyZWQgPSBhd2FpdCBycGNTZXJ2ZXIucHJlcGFyZVRyYW5zYWN0aW9uKHR4KVxyXG4gIHJldHVybiB7IHhkcjogcHJlcGFyZWQudG9YRFIoKSB9XHJcbn1cclxuXHJcbmV4cG9ydCBkZWZhdWx0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIocmVxLCByZXMpIHtcclxuICBjb25zdCBjdHggPSBhd2FpdCByZXF1aXJlVmZLZXkocmVxLCByZXMsIHN0b3JlRnJvbShyZXEpLCB7IHNjb3BlOiAndHgnIH0pXHJcbiAgaWYgKCFjdHgpIHJldHVyblxyXG4gIGNvbnN0IHsga2luZCwgZnJvbSwgYW1vdW50IH0gPSByZXEuYm9keSA/PyB7fVxyXG4gIGNvbnN0IHZhdWx0ID0gcHJvY2Vzcy5lbnYuU09ST0JBTl9WQVVMVF9BRERSRVNTIHx8ICcnXHJcbiAgaWYgKCF2YXVsdCkgcmV0dXJuIGpzb24ocmVzLCA1MDMsIHsgY29uZmlndXJlZDogZmFsc2UsIGVycm9yOiAnVmF1bHQgbm90IGNvbmZpZ3VyZWQnIH0pXHJcbiAgY29uc3QgeyBTdHJLZXkgfSA9IGF3YWl0IGltcG9ydCgnQHN0ZWxsYXIvc3RlbGxhci1zZGsnKVxyXG4gIGxldCBhbXRcclxuICB0cnkge1xyXG4gICAgYW10ID0gQmlnSW50KGFtb3VudClcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBqc29uKHJlcywgNDAwLCB7IGVycm9yOiAnSW52YWxpZCBhbW91bnQnIH0pXHJcbiAgfVxyXG4gIGlmIChraW5kICE9PSAnZGVwb3NpdCcgfHwgIVN0cktleS5pc1ZhbGlkRWQyNTUxOVB1YmxpY0tleShmcm9tIHx8ICcnKSB8fCBhbXQgPD0gMG4pIHtcclxuICAgIHJldHVybiBqc29uKHJlcywgNDAwLCB7IGVycm9yOiAnSW52YWxpZCBidWlsZCByZXF1ZXN0JyB9KVxyXG4gIH1cclxuICB0cnkge1xyXG4gICAgY29uc3QgeyBycGMgfSA9IGF3YWl0IGltcG9ydCgnQHN0ZWxsYXIvc3RlbGxhci1zZGsnKVxyXG4gICAgY29uc3QgcnBjU2VydmVyID0gbmV3IHJwYy5TZXJ2ZXIoXHJcbiAgICAgIHByb2Nlc3MuZW52LlNPUk9CQU5fUlBDX1VSTCB8fCAnaHR0cHM6Ly9zb3JvYmFuLXRlc3RuZXQuc3RlbGxhci5vcmcnXHJcbiAgICApXHJcbiAgICBjb25zdCBvdXQgPSBhd2FpdCBidWlsZERlcG9zaXRDb3JlKHtcclxuICAgICAgZnJvbSxcclxuICAgICAgYW1vdW50OiBhbXQsXHJcbiAgICAgIHZhdWx0LFxyXG4gICAgICBwYXNzcGhyYXNlOiBwcm9jZXNzLmVudi5TVEVMTEFSX05FVFdPUktfUEFTU1BIUkFTRSB8fCAnVGVzdCBTREYgTmV0d29yayA7IFNlcHRlbWJlciAyMDE1JyxcclxuICAgICAgcnBjU2VydmVyLFxyXG4gICAgfSlcclxuICAgIGpzb24ocmVzLCAyMDAsIG91dClcclxuICB9IGNhdGNoIHtcclxuICAgIGpzb24ocmVzLCA1MDIsIHsgZXJyb3I6ICd1cHN0cmVhbScgfSlcclxuICB9XHJcbn1cclxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmL3NpbXVsYXRlLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvc2ltdWxhdGUuanNcIjtpbXBvcnQgeyBzdG9yZUZyb20gfSBmcm9tICcuL19kYi5qcydcclxuaW1wb3J0IHsgcmVxdWlyZVZmS2V5IH0gZnJvbSAnLi9fdmZhdXRoLmpzJ1xyXG5cclxuY29uc3QganNvbiA9IChyZXMsIHN0YXR1cywgb2JqKSA9PiB7XHJcbiAgcmVzLnN0YXR1c0NvZGUgPSBzdGF0dXNcclxuICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpXHJcbiAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShvYmopKVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2ltdWxhdGVDb3JlKHsgeGRyLCBwYXNzcGhyYXNlLCBycGNTZXJ2ZXIsIHBhcnNlIH0pIHtcclxuICBjb25zdCB0eCA9IHBhcnNlKHhkciwgcGFzc3BocmFzZSlcclxuICBjb25zdCBzaW0gPSBhd2FpdCBycGNTZXJ2ZXIuc2ltdWxhdGVUcmFuc2FjdGlvbih0eClcclxuICByZXR1cm4ge1xyXG4gICAgb2s6ICFzaW0uZXJyb3IsXHJcbiAgICBlcnJvcjogc2ltLmVycm9yID8gJ3NpbXVsYXRpb24gZmFpbGVkJyA6IHVuZGVmaW5lZCxcclxuICAgIGxhdGVzdExlZGdlcjogc2ltLmxhdGVzdExlZGdlcixcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBkZWZhdWx0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIocmVxLCByZXMpIHtcclxuICBjb25zdCBjdHggPSBhd2FpdCByZXF1aXJlVmZLZXkocmVxLCByZXMsIHN0b3JlRnJvbShyZXEpLCB7IHNjb3BlOiAndHgnIH0pXHJcbiAgaWYgKCFjdHgpIHJldHVyblxyXG4gIGNvbnN0IHhkciA9IHJlcS5ib2R5Py54ZHJcclxuICBpZiAodHlwZW9mIHhkciAhPT0gJ3N0cmluZycgfHwgIXhkcikgcmV0dXJuIGpzb24ocmVzLCA0MDAsIHsgZXJyb3I6ICdNaXNzaW5nIHhkcicgfSlcclxuICB0cnkge1xyXG4gICAgY29uc3Qgc2RrID0gYXdhaXQgaW1wb3J0KCdAc3RlbGxhci9zdGVsbGFyLXNkaycpXHJcbiAgICBjb25zdCBycGNTZXJ2ZXIgPSBuZXcgc2RrLnJwYy5TZXJ2ZXIoXHJcbiAgICAgIHByb2Nlc3MuZW52LlNPUk9CQU5fUlBDX1VSTCB8fCAnaHR0cHM6Ly9zb3JvYmFuLXRlc3RuZXQuc3RlbGxhci5vcmcnXHJcbiAgICApXHJcbiAgICBjb25zdCBwYXNzcGhyYXNlID0gcHJvY2Vzcy5lbnYuU1RFTExBUl9ORVRXT1JLX1BBU1NQSFJBU0UgfHwgJ1Rlc3QgU0RGIE5ldHdvcmsgOyBTZXB0ZW1iZXIgMjAxNSdcclxuICAgIGNvbnN0IG91dCA9IGF3YWl0IHNpbXVsYXRlQ29yZSh7XHJcbiAgICAgIHhkcixcclxuICAgICAgcGFzc3BocmFzZSxcclxuICAgICAgcnBjU2VydmVyLFxyXG4gICAgICBwYXJzZTogKHgsIHApID0+IHNkay5UcmFuc2FjdGlvbkJ1aWxkZXIuZnJvbVhEUih4LCBwKSxcclxuICAgIH0pXHJcbiAgICBqc29uKHJlcywgMjAwLCBvdXQpXHJcbiAgfSBjYXRjaCB7XHJcbiAgICBqc29uKHJlcywgNTAyLCB7IGVycm9yOiAndXBzdHJlYW0nIH0pXHJcbiAgfVxyXG59XHJcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92ZlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9zdWJtaXQuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9zdWJtaXQuanNcIjsvLyBLZXktYXV0aGVkIGdhc2xlc3MgcmVsYXkuIFJldXNlcyB0aGUgcmV2aWV3ZWQgcmVsYXkgY29yZSAoZmVlLWJ1bXAgKyBkZXBvc2l0LW9ubHlcclxuLy8gYXNzZXJ0VmF1bHREZXBvc2l0IGd1YXJkIGxpdmUgaW5zaWRlIGZlZUJ1bXBBbmRTdWJtaXQpLiBOb24tY3VzdG9kaWFsOiB0aGUgWERSIGlzXHJcbi8vIGFscmVhZHkgc2lnbmVkIG9uLWRldmljZTsgdGhlIHNlcnZlciBvbmx5IHBheXMgdGhlIGZlZS5cclxuaW1wb3J0IHsgc3RvcmVGcm9tIH0gZnJvbSAnLi9fZGIuanMnXHJcbmltcG9ydCB7IHJlcXVpcmVWZktleSB9IGZyb20gJy4vX3ZmYXV0aC5qcydcclxuXHJcbmNvbnN0IGpzb24gPSAocmVzLCBzdGF0dXMsIG9iaikgPT4ge1xyXG4gIHJlcy5zdGF0dXNDb2RlID0gc3RhdHVzXHJcbiAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKVxyXG4gIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkob2JqKSlcclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN1Ym1pdENvcmUoeyB4ZHIsIGRlcHMgfSkge1xyXG4gIHJldHVybiBkZXBzLnJlbGF5KHsgeGRyIH0pXHJcbn1cclxuXHJcbmV4cG9ydCBkZWZhdWx0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIocmVxLCByZXMpIHtcclxuICBjb25zdCBjdHggPSBhd2FpdCByZXF1aXJlVmZLZXkocmVxLCByZXMsIHN0b3JlRnJvbShyZXEpLCB7IHNjb3BlOiAnc3VibWl0JyB9KVxyXG4gIGlmICghY3R4KSByZXR1cm5cclxuICBjb25zdCB4ZHIgPSByZXEuYm9keT8ueGRyXHJcbiAgaWYgKHR5cGVvZiB4ZHIgIT09ICdzdHJpbmcnIHx8ICF4ZHIpIHJldHVybiBqc29uKHJlcywgNDAwLCB7IGVycm9yOiAnTWlzc2luZyB4ZHInIH0pXHJcbiAgY29uc3Qgc2VjcmV0ID0gcHJvY2Vzcy5lbnYuU1RFTExBUl9SRUxBWUVSX1NFQ1JFVCB8fCAnJ1xyXG4gIGlmICghc2VjcmV0KSByZXR1cm4ganNvbihyZXMsIDUwMywgeyBjb25maWd1cmVkOiBmYWxzZSwgZXJyb3I6ICdSZWxheSBub3QgY29uZmlndXJlZCcgfSlcclxuICB0cnkge1xyXG4gICAgY29uc3Qgc2RrID0gYXdhaXQgaW1wb3J0KCdAc3RlbGxhci9zdGVsbGFyLXNkaycpXHJcbiAgICBjb25zdCB7IGZlZUJ1bXBBbmRTdWJtaXQgfSA9IGF3YWl0IGltcG9ydCgnLi4vc3RlbGxhci1yZWxheS5qcycpXHJcbiAgICBjb25zdCBycGNTZXJ2ZXIgPSBuZXcgc2RrLnJwYy5TZXJ2ZXIoXHJcbiAgICAgIHByb2Nlc3MuZW52LlNPUk9CQU5fUlBDX1VSTCB8fCAnaHR0cHM6Ly9zb3JvYmFuLXRlc3RuZXQuc3RlbGxhci5vcmcnXHJcbiAgICApXHJcbiAgICBjb25zdCBvdXQgPSBhd2FpdCBzdWJtaXRDb3JlKHtcclxuICAgICAgeGRyLFxyXG4gICAgICBkZXBzOiB7XHJcbiAgICAgICAgcmVsYXk6ICh7IHhkcjogeCB9KSA9PlxyXG4gICAgICAgICAgZmVlQnVtcEFuZFN1Ym1pdCh7XHJcbiAgICAgICAgICAgIHhkcjogeCxcclxuICAgICAgICAgICAgc2VjcmV0LFxyXG4gICAgICAgICAgICBwYXNzcGhyYXNlOlxyXG4gICAgICAgICAgICAgIHByb2Nlc3MuZW52LlNURUxMQVJfTkVUV09SS19QQVNTUEhSQVNFIHx8ICdUZXN0IFNERiBOZXR3b3JrIDsgU2VwdGVtYmVyIDIwMTUnLFxyXG4gICAgICAgICAgICB2YXVsdEFkZHI6IHByb2Nlc3MuZW52LlNPUk9CQU5fVkFVTFRfQUREUkVTUyB8fCAnJyxcclxuICAgICAgICAgICAgc2RrLFxyXG4gICAgICAgICAgICBycGNTZXJ2ZXIsXHJcbiAgICAgICAgICB9KSxcclxuICAgICAgfSxcclxuICAgIH0pXHJcbiAgICBqc29uKHJlcywgMjAwLCBvdXQpXHJcbiAgfSBjYXRjaCB7XHJcbiAgICBqc29uKHJlcywgNTAyLCB7IGVycm9yOiAndXBzdHJlYW0nIH0pXHJcbiAgfVxyXG59XHJcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92ZlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9zY2FuLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvc2Nhbi5qc1wiOy8vIFNjYW4tYmVmb3JlLXNlbmQ6IFN0cktleSBjbGFzc2lmaWNhdGlvbiArIGtub3duLXZhdWx0IGNoZWNrICsgRjggZWxpZ2liaWxpdHkgdmVyZGljdC5cclxuLy8gSE9ORVNUWTogYXBwLWxheWVyIHZlcmRpY3Qgb25seSBcdTIwMTQgbm90IG9uLWNoYWluLXZlcmlmaWFibGUuXHJcbmltcG9ydCB7IFN0cktleSB9IGZyb20gJ0BzdGVsbGFyL3N0ZWxsYXItc2RrJ1xyXG5pbXBvcnQgeyBldmFsdWF0ZSB9IGZyb20gJy4uLy4uL3NyYy9zdHJhdGVneS9lbGlnaWJpbGl0eUdhdGUuanMnXHJcbmltcG9ydCB7IHJlc29sdmUgYXMgcmVzb2x2ZVZhdWx0RmFjdHMgfSBmcm9tICcuLi8uLi9zcmMvc3RyYXRlZ3kvdmF1bHRGYWN0cy5qcydcclxuaW1wb3J0IHsgc3RvcmVGcm9tIH0gZnJvbSAnLi9fZGIuanMnXHJcbmltcG9ydCB7IHJlcXVpcmVWZktleSB9IGZyb20gJy4vX3ZmYXV0aC5qcydcclxuXHJcbmNvbnN0IGJpZ2ludFNhZmUgPSAoXywgdikgPT4gKHR5cGVvZiB2ID09PSAnYmlnaW50JyA/IHYudG9TdHJpbmcoKSA6IHYpXHJcblxyXG5leHBvcnQgZGVmYXVsdCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKHJlcSwgcmVzKSB7XHJcbiAgY29uc3QgY3R4ID0gYXdhaXQgcmVxdWlyZVZmS2V5KHJlcSwgcmVzLCBzdG9yZUZyb20ocmVxKSwgeyBzY29wZTogJ3NjYW4nIH0pXHJcbiAgaWYgKCFjdHgpIHJldHVyblxyXG4gIGNvbnN0IHRhcmdldCA9IFN0cmluZyhyZXEuYm9keT8udGFyZ2V0IHx8ICcnKVxyXG4gIGNvbnN0IHByb3RvY29sID0gcmVxLmJvZHk/LnByb3RvY29sIHx8ICdibGVuZC11c2RjJ1xyXG4gIGNvbnN0IGtpbmQgPSBTdHJLZXkuaXNWYWxpZEVkMjU1MTlQdWJsaWNLZXkodGFyZ2V0KVxyXG4gICAgPyAnYWNjb3VudCdcclxuICAgIDogU3RyS2V5LmlzVmFsaWRDb250cmFjdCh0YXJnZXQpXHJcbiAgICAgID8gJ2NvbnRyYWN0J1xyXG4gICAgICA6ICdpbnZhbGlkJ1xyXG4gIGNvbnN0IGlzS25vd25WYXVsdCA9IGtpbmQgPT09ICdjb250cmFjdCcgJiYgdGFyZ2V0ID09PSAocHJvY2Vzcy5lbnYuU09ST0JBTl9WQVVMVF9BRERSRVNTIHx8ICcnKVxyXG4gIGNvbnN0IG91dCA9IHsga2luZCwgaXNLbm93blZhdWx0IH1cclxuICBpZiAoaXNLbm93blZhdWx0KSB7XHJcbiAgICBjb25zdCB7IGZhY3RzIH0gPSByZXNvbHZlVmF1bHRGYWN0cyhwcm90b2NvbClcclxuICAgIG91dC5lbGlnaWJpbGl0eSA9IGV2YWx1YXRlKHsgdmF1bHQ6IHRhcmdldCwgYW1vdW50OiAxMDAwMDAwMG4sIGZhY3RzIH0pXHJcbiAgfVxyXG4gIHJlcy5zdGF0dXNDb2RlID0gMjAwXHJcbiAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKVxyXG4gIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkob3V0LCBiaWdpbnRTYWZlKSlcclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmZcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvc3RyYXRlZ3kuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS92Zi9zdHJhdGVneS5qc1wiOy8vIEFJIGFsbG9jYXRpb24gc3RyYXRlZ3kuIExMTSAoRGVlcFNlZWssIHNlcnZlciBrZXkpIHdpdGggYSBkZXRlcm1pbmlzdGljIGVxdWFsLXNwbGl0XHJcbi8vIGZhbGxiYWNrIFx1MjAxNCB0aGUgc3RyYXRlZ2lzdCBORVZFUiBibG9ja3MgdGhlIGZsb3cgKG1pcnJvcnMgc3JjL3ZlbmljZS5qcyBwaGlsb3NvcGh5KS5cclxuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCdcclxuaW1wb3J0IHsgc3RvcmVGcm9tIH0gZnJvbSAnLi9fZGIuanMnXHJcbmltcG9ydCB7IHJlcXVpcmVWZktleSB9IGZyb20gJy4vX3ZmYXV0aC5qcydcclxuXHJcbmNvbnN0IERFRVBTRUVLX1VSTCA9ICdodHRwczovL2FwaS5kZWVwc2Vlay5jb20vdjEvY2hhdC9jb21wbGV0aW9ucydcclxuY29uc3QgTU9ERUwgPSAnZGVlcHNlZWstdjQtZmxhc2gnXHJcblxyXG5jb25zdCBqc29uID0gKHJlcywgc3RhdHVzLCBvYmopID0+IHtcclxuICByZXMuc3RhdHVzQ29kZSA9IHN0YXR1c1xyXG4gIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJylcclxuICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KG9iaikpXHJcbn1cclxuXHJcbmNvbnN0IElucHV0U2NoZW1hID0gei5vYmplY3Qoe1xyXG4gIGFtb3VudFVzZDogei5udW1iZXIoKS5wb3NpdGl2ZSgpLFxyXG4gIHJpc2tMZXZlbDogei5lbnVtKFsnbG93JywgJ21lZGl1bScsICdoaWdoJ10pLFxyXG4gIHZhdWx0Q291bnQ6IHoubnVtYmVyKCkuaW50KCkubWluKDEpLm1heCgxMCksXHJcbn0pXHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZXF1YWxTcGxpdChwcm90b2NvbHMsIHZhdWx0Q291bnQpIHtcclxuICBjb25zdCBwaWNrcyA9IHByb3RvY29scy5zbGljZSgwLCBNYXRoLm1heCgxLCBNYXRoLm1pbih2YXVsdENvdW50LCBwcm90b2NvbHMubGVuZ3RoKSkpXHJcbiAgY29uc3QgYmFzZSA9IE1hdGguZmxvb3IoMTAwIC8gcGlja3MubGVuZ3RoKVxyXG4gIHJldHVybiBwaWNrcy5tYXAoKHByb3RvY29sLCBpKSA9PiAoe1xyXG4gICAgcHJvdG9jb2wsXHJcbiAgICBwY3Q6IGkgPT09IDAgPyAxMDAgLSBiYXNlICogKHBpY2tzLmxlbmd0aCAtIDEpIDogYmFzZSxcclxuICB9KSlcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlTGxtUGxhbih0ZXh0LCBwcm90b2NvbHMpIHtcclxuICB0cnkge1xyXG4gICAgY29uc3Qgb2JqID0gSlNPTi5wYXJzZSh0ZXh0KVxyXG4gICAgY29uc3QgYWxsb2NhdGlvbnMgPSBvYmo/LmFsbG9jYXRpb25zXHJcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoYWxsb2NhdGlvbnMpIHx8IGFsbG9jYXRpb25zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGxcclxuICAgIGxldCBzdW0gPSAwXHJcbiAgICBmb3IgKGNvbnN0IGEgb2YgYWxsb2NhdGlvbnMpIHtcclxuICAgICAgaWYgKCFwcm90b2NvbHMuaW5jbHVkZXMoYS5wcm90b2NvbCkpIHJldHVybiBudWxsXHJcbiAgICAgIGlmICh0eXBlb2YgYS5wY3QgIT09ICdudW1iZXInIHx8IGEucGN0IDw9IDApIHJldHVybiBudWxsXHJcbiAgICAgIHN1bSArPSBhLnBjdFxyXG4gICAgfVxyXG4gICAgaWYgKE1hdGguYWJzKHN1bSAtIDEwMCkgPiAxKSByZXR1cm4gbnVsbFxyXG4gICAgcmV0dXJuIHsgYWxsb2NhdGlvbnMsIHJlYXNvbmluZzogdHlwZW9mIG9iai5yZWFzb25pbmcgPT09ICdzdHJpbmcnID8gb2JqLnJlYXNvbmluZyA6ICcnIH1cclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBudWxsXHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgZGVmYXVsdCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKHJlcSwgcmVzKSB7XHJcbiAgY29uc3QgY3R4ID0gYXdhaXQgcmVxdWlyZVZmS2V5KHJlcSwgcmVzLCBzdG9yZUZyb20ocmVxKSwgeyBzY29wZTogJ3N0cmF0ZWd5JyB9KVxyXG4gIGlmICghY3R4KSByZXR1cm5cclxuICBjb25zdCBwYXJzZWQgPSBJbnB1dFNjaGVtYS5zYWZlUGFyc2UocmVxLmJvZHkgPz8ge30pXHJcbiAgaWYgKCFwYXJzZWQuc3VjY2VzcykgcmV0dXJuIGpzb24ocmVzLCA0MDAsIHsgZXJyb3I6ICdJbnZhbGlkIHN0cmF0ZWd5IHJlcXVlc3QnIH0pXHJcbiAgY29uc3QgeyBhbW91bnRVc2QsIHJpc2tMZXZlbCwgdmF1bHRDb3VudCB9ID0gcGFyc2VkLmRhdGFcclxuICBjb25zdCBwcm90b2NvbHMgPSAocHJvY2Vzcy5lbnYuVkZfVkFVTFRfQ0FUQUxPRyB8fCAnYmxlbmQtdXNkYycpXHJcbiAgICAuc3BsaXQoJywnKVxyXG4gICAgLm1hcCgocykgPT4gcy50cmltKCkpXHJcbiAgICAuZmlsdGVyKEJvb2xlYW4pXHJcblxyXG4gIGNvbnN0IGFwaUtleSA9IHByb2Nlc3MuZW52LkRFRVBTRUVLX0FQSV9LRVlcclxuICBpZiAoYXBpS2V5KSB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB1cHN0cmVhbSA9IGF3YWl0IGZldGNoKERFRVBTRUVLX1VSTCwge1xyXG4gICAgICAgIG1ldGhvZDogJ1BPU1QnLFxyXG4gICAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJywgQXV0aG9yaXphdGlvbjogYEJlYXJlciAke2FwaUtleX1gIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDgwMDApLFxyXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICAgIG1vZGVsOiBNT0RFTCxcclxuICAgICAgICAgIHJlc3BvbnNlX2Zvcm1hdDogeyB0eXBlOiAnanNvbl9vYmplY3QnIH0sXHJcbiAgICAgICAgICBtZXNzYWdlczogW1xyXG4gICAgICAgICAgICB7XHJcbiAgICAgICAgICAgICAgcm9sZTogJ3N5c3RlbScsXHJcbiAgICAgICAgICAgICAgY29udGVudDpcclxuICAgICAgICAgICAgICAgICdZb3UgYXJlIGEgY29uc2VydmF0aXZlIERlRmkgYWxsb2NhdGlvbiBzdHJhdGVnaXN0LiBSZXBseSBPTkxZIHdpdGggSlNPTjogJyArXHJcbiAgICAgICAgICAgICAgICAne1wiYWxsb2NhdGlvbnNcIjpbe1wicHJvdG9jb2xcIjo8c3RyaW5nPixcInBjdFwiOjxudW1iZXI+fV0sXCJyZWFzb25pbmdcIjo8c3RyaW5nPn0gXHUyMDE0IHBjdHMgc3VtIHRvIDEwMCwgJyArXHJcbiAgICAgICAgICAgICAgICAncHJvdG9jb2xzIHN0cmljdGx5IGZyb20gdGhlIGdpdmVuIGNhdGFsb2cuJyxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAge1xyXG4gICAgICAgICAgICAgIHJvbGU6ICd1c2VyJyxcclxuICAgICAgICAgICAgICBjb250ZW50OiBgYW1vdW50VXNkPSR7YW1vdW50VXNkfSByaXNrTGV2ZWw9JHtyaXNrTGV2ZWx9IHZhdWx0Q291bnQ9JHt2YXVsdENvdW50fSBjYXRhbG9nPSR7cHJvdG9jb2xzLmpvaW4oJywnKX1gLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgXSxcclxuICAgICAgICB9KSxcclxuICAgICAgfSlcclxuICAgICAgaWYgKHVwc3RyZWFtLm9rKSB7XHJcbiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHVwc3RyZWFtLmpzb24oKVxyXG4gICAgICAgIGNvbnN0IHBsYW4gPSBwYXJzZUxsbVBsYW4oZGF0YT8uY2hvaWNlcz8uWzBdPy5tZXNzYWdlPy5jb250ZW50ID8/ICcnLCBwcm90b2NvbHMpXHJcbiAgICAgICAgaWYgKHBsYW4pIHJldHVybiBqc29uKHJlcywgMjAwLCB7IC4uLnBsYW4sIHNvdXJjZTogJ2xsbScgfSlcclxuICAgICAgfVxyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgIC8vIGZhbGwgdGhyb3VnaCB0byB0aGUgZGV0ZXJtaW5pc3RpYyBmYWxsYmFjayBcdTIwMTQgbmV2ZXIgYmxvY2tcclxuICAgIH1cclxuICB9XHJcbiAganNvbihyZXMsIDIwMCwge1xyXG4gICAgYWxsb2NhdGlvbnM6IGVxdWFsU3BsaXQocHJvdG9jb2xzLCB2YXVsdENvdW50KSxcclxuICAgIHJlYXNvbmluZzogJ0VxdWFsIHNwbGl0IGFjcm9zcyB0aGUgdmV0dGVkIGNhdGFsb2cgKGRldGVybWluaXN0aWMgZmFsbGJhY2spLicsXHJcbiAgICBzb3VyY2U6ICdmYWxsYmFjaycsXHJcbiAgfSlcclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmZcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvdmYvX3JvdXRlci5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vbW50L0I0N0VEMTA2N0VEMEMyNzIvcHJvamVjdC92aWJpbmdmYXJtZXIvZnJvbnRlbmQvYXBpL3ZmL19yb3V0ZXIuanNcIjsvLyBTaW5nbGUgZGlzcGF0Y2hlciBmb3IgL2FwaS92Zi8qLiBPbmUgdml0ZSBtb3VudCArIG9uZSBQYWdlcyBjYXRjaC1hbGwgd3JhcCB0aGlzLlxyXG4vLyBHYXRld2F5IGVuZHBvaW50cyBhdXRoZW50aWNhdGUgd2l0aCB0aGUgQmVhcmVyIHZmXyBrZXkgKHJlcXVpcmVWZktleSBpbnNpZGUgZWFjaFxyXG4vLyBoYW5kbGVyKSBcdTIwMTQgc28gQ09SUyBoZXJlIGlzIHBlcm1pc3NpdmUgKGFueSBicm93c2VyIG9yaWdpbiBtYXkgY2FycnkgYSBrZXkpLlxyXG5pbXBvcnQgYXV0aENoYWxsZW5nZSBmcm9tICcuL2F1dGgtY2hhbGxlbmdlLmpzJ1xyXG5pbXBvcnQgYXV0aFRva2VuIGZyb20gJy4vYXV0aC10b2tlbi5qcydcclxuaW1wb3J0IHsgbGlzdEtleXMsIGNyZWF0ZUtleSwgZGVsZXRlS2V5IH0gZnJvbSAnLi9rZXlzLmpzJ1xyXG5pbXBvcnQgdmF1bHRGYWN0cyBmcm9tICcuL3ZhdWx0LWZhY3RzLmpzJ1xyXG5pbXBvcnQgZWxpZ2liaWxpdHkgZnJvbSAnLi9lbGlnaWJpbGl0eS5qcydcclxuaW1wb3J0IHByaWNlcyBmcm9tICcuL3ByaWNlcy5qcydcclxuaW1wb3J0IGJ1aWxkVHggZnJvbSAnLi9idWlsZC10eC5qcydcclxuaW1wb3J0IHNpbXVsYXRlIGZyb20gJy4vc2ltdWxhdGUuanMnXHJcbmltcG9ydCBzdWJtaXQgZnJvbSAnLi9zdWJtaXQuanMnXHJcbmltcG9ydCBzY2FuIGZyb20gJy4vc2Nhbi5qcydcclxuaW1wb3J0IHN0cmF0ZWd5IGZyb20gJy4vc3RyYXRlZ3kuanMnXHJcblxyXG5leHBvcnQgY29uc3Qgcm91dGVzID0ge1xyXG4gICdHRVQgL2F1dGgvY2hhbGxlbmdlJzogYXV0aENoYWxsZW5nZSxcclxuICAnUE9TVCAvYXV0aC90b2tlbic6IGF1dGhUb2tlbixcclxuICAnR0VUIC9rZXlzJzogbGlzdEtleXMsXHJcbiAgJ1BPU1QgL2tleXMnOiBjcmVhdGVLZXksXHJcbiAgJ0RFTEVURSAva2V5cyc6IGRlbGV0ZUtleSxcclxuICAnR0VUIC92YXVsdC1mYWN0cyc6IHZhdWx0RmFjdHMsXHJcbiAgJ1BPU1QgL2VsaWdpYmlsaXR5JzogZWxpZ2liaWxpdHksXHJcbiAgJ0dFVCAvcHJpY2VzJzogcHJpY2VzLFxyXG4gICdQT1NUIC9idWlsZC10eCc6IGJ1aWxkVHgsXHJcbiAgJ1BPU1QgL3NpbXVsYXRlJzogc2ltdWxhdGUsXHJcbiAgJ1BPU1QgL3N1Ym1pdCc6IHN1Ym1pdCxcclxuICAnUE9TVCAvc2Nhbic6IHNjYW4sXHJcbiAgJ1BPU1QgL3N0cmF0ZWd5Jzogc3RyYXRlZ3ksXHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzdWJQYXRoKHJlcSkge1xyXG4gIGNvbnN0IHBhdGhuYW1lID0gbmV3IFVSTChyZXEudXJsLCAnaHR0cDovL2xvY2FsJykucGF0aG5hbWVcclxuICBjb25zdCBpID0gcGF0aG5hbWUuaW5kZXhPZignL2FwaS92ZicpXHJcbiAgcmV0dXJuIChpID49IDAgPyBwYXRobmFtZS5zbGljZShpICsgJy9hcGkvdmYnLmxlbmd0aCkgOiBwYXRobmFtZSkgfHwgJy8nXHJcbn1cclxuXHJcbi8vIEluIHZpdGUgZGV2IG1pZGRsZXdhcmUgYHJlcWAgaXMgYSByYXcgTm9kZSBzdHJlYW0gXHUyMDE0IHJlcS5ib2R5IGlzIHVucGFyc2VkLiBUaGUgUGFnZXNcclxuLy8gYWRhcHRlciBhbmQgdW5pdCB0ZXN0cyBwcmUtc2V0IHJlcS5ib2R5IChvYmplY3QpLCBzbyB0aGlzIGVhcmx5LXJldHVybnMgdGhlcmUgYW5kIHRoZVxyXG4vLyBzdHJlYW0vQnVmZmVyIHBhdGggb25seSBydW5zIHVuZGVyIHJhdyBOb2RlLCB3aGVyZSBib3RoIGV4aXN0LiBNaXJyb3JzIGFwaS9mYXVjZXQuanMuXHJcbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZUJvZHkocmVxKSB7XHJcbiAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnIHx8IHJlcS5tZXRob2QgPT09ICdIRUFEJykgcmV0dXJuXHJcbiAgaWYgKHJlcS5ib2R5ICYmIHR5cGVvZiByZXEuYm9keSA9PT0gJ29iamVjdCcpIHJldHVyblxyXG4gIGNvbnN0IGNodW5rcyA9IFtdXHJcbiAgdHJ5IHtcclxuICAgIGZvciBhd2FpdCAoY29uc3QgYyBvZiByZXEpIGNodW5rcy5wdXNoKGMpXHJcbiAgICBjb25zdCByYXcgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoJ3V0ZjgnKVxyXG4gICAgcmVxLmJvZHkgPSByYXcgPyBKU09OLnBhcnNlKHJhdykgOiB7fVxyXG4gIH0gY2F0Y2gge1xyXG4gICAgcmVxLmJvZHkgPSB7fSAvLyBtYWxmb3JtZWQgYm9keSBcdTIxOTIgaGFuZGxlciB2YWxpZGF0aW9uIHJlamVjdHMgaXQgZG93bnN0cmVhbVxyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gdmZSb3V0ZXIocmVxLCByZXMpIHtcclxuICByZXMuc2V0SGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nLCAnKicpXHJcbiAgcmVzLnNldEhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcycsICdHRVQsUE9TVCxERUxFVEUsT1BUSU9OUycpXHJcbiAgcmVzLnNldEhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVycycsICdDb250ZW50LVR5cGUsIEF1dGhvcml6YXRpb24nKVxyXG4gIGlmIChyZXEubWV0aG9kID09PSAnT1BUSU9OUycpIHtcclxuICAgIHJlcy5zdGF0dXNDb2RlID0gMjA0XHJcbiAgICByZXR1cm4gcmVzLmVuZCgnJylcclxuICB9XHJcbiAgYXdhaXQgZW5zdXJlQm9keShyZXEpXHJcbiAgY29uc3QgaGFuZGxlciA9IHJvdXRlc1tgJHtyZXEubWV0aG9kfSAke3N1YlBhdGgocmVxKX1gXVxyXG4gIGlmICghaGFuZGxlcikge1xyXG4gICAgcmVzLnN0YXR1c0NvZGUgPSA0MDRcclxuICAgIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJylcclxuICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdOb3QgZm91bmQnIH0pKVxyXG4gIH1cclxuICByZXR1cm4gaGFuZGxlcihyZXEsIHJlcylcclxufVxyXG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9tbnQvQjQ3RUQxMDY3RUQwQzI3Mi9wcm9qZWN0L3ZpYmluZ2Zhcm1lci9mcm9udGVuZC9hcGkvb25yYW1wLXNlc3Npb24uanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL21udC9CNDdFRDEwNjdFRDBDMjcyL3Byb2plY3QvdmliaW5nZmFybWVyL2Zyb250ZW5kL2FwaS9vbnJhbXAtc2Vzc2lvbi5qc1wiOy8vIFNlcnZlci1zaWRlIFRyYW5zYWsgXCJDcmVhdGUgV2lkZ2V0IFVSTFwiIHNlc3Npb24gcHJveHkgKFNQNCBvbi1yYW1wLCBwcmltYXJ5IHByb3ZpZGVyKS5cclxuLy8gTWludHMgYSBzaG9ydC1saXZlZCwgb25lLXRpbWUgd2lkZ2V0VXJsIHNvIHRoZSBUUkFOU0FLX0FDQ0VTU19UT0tFTiBzZWNyZXQgbmV2ZXIgcmVhY2hlc1xyXG4vLyB0aGUgY2xpZW50IGJ1bmRsZSBcdTIwMTQgbWlycm9ycyB0aGlzIGNvZGViYXNlJ3MgZXhpc3Rpbmcgc3RlbGxhci1yZWxheS5qcyBnYXNsZXNzLXJlbGF5IHBhdHRlcm5cclxuLy8gKHNlcnZlciBob2xkcyB0aGUgc2VjcmV0LCBjbGllbnQgb25seSBldmVyIGNhbGxzIHRoaXMgcHJveHkpLlxyXG4vLyBodHRwczovL2RvY3MudHJhbnNhay5jb20vZ3VpZGVzL21pZ3JhdGlvbi10by1hcGktYmFzZWQtdHJhbnNhay13aWRnZXQtdXJsXHJcbi8vXHJcbi8vIEFjdGlvbnMgKFBPU1QgYm9keSk6XHJcbi8vICAgeyBwcm92aWRlcjogJ3RyYW5zYWsnIChkZWZhdWx0KSwgYWRkcmVzcywgYW1vdW50PyB9ICAgICAgXHUyMTkyIHsgd2lkZ2V0VXJsIH1cclxuLy8gICB7IHByb3ZpZGVyOiAnY29pbmJhc2UtYmFzZScsIGFkZHJlc3MsIGFtb3VudD8gfSAgICAgICAgICBcdTIxOTIgNTAxIChkb2N1bWVudGVkIGZhbGxiYWNrLFxyXG4vLyAgICAgZGVsaWJlcmF0ZWx5IG5vdCB3aXJlZCB5ZXQgXHUyMDE0IHNlZSB0aGUgYnJhbmNoIGJlbG93IGZvciB3aHkpXHJcblxyXG5pbXBvcnQgeyBhcHBseUNvcnMsIHJhdGVMaW1pdCB9IGZyb20gJy4vX2d1YXJkLmpzJ1xyXG5cclxuY29uc3QgQVBJX0tFWSA9ICgpID0+IHByb2Nlc3MuZW52LlRSQU5TQUtfQVBJX0tFWSB8fCAnJ1xyXG5jb25zdCBBQ0NFU1NfVE9LRU4gPSAoKSA9PiBwcm9jZXNzLmVudi5UUkFOU0FLX0FDQ0VTU19UT0tFTiB8fCAnJ1xyXG5jb25zdCBFTlZJUk9OTUVOVCA9ICgpID0+IHByb2Nlc3MuZW52LlRSQU5TQUtfRU5WSVJPTk1FTlQgfHwgJ1NUQUdJTkcnXHJcbmNvbnN0IFJFRkVSUkVSX0RPTUFJTiA9ICgpID0+IHByb2Nlc3MuZW52LlRSQU5TQUtfUkVGRVJSRVJfRE9NQUlOIHx8ICdsb2NhbGhvc3QnXHJcblxyXG4vLyBWRVJJRlk6IGNvbmZpcm0gdGhlc2UgYXJlIHN0aWxsIHRoZSBjdXJyZW50IFNlc3Npb24gQVBJIGhvc3RzIGZvciBib3RoIFNUQUdJTkcgYW5kXHJcbi8vIFBST0RVQ1RJT04gYmVmb3JlIGdvLWxpdmUgXHUyMDE0IGh0dHBzOi8vZG9jcy50cmFuc2FrLmNvbS9hcGkvcHVibGljL2VuZC1wb2ludHNcclxuY29uc3QgU0VTU0lPTl9BUElfVVJMID0ge1xyXG4gIFNUQUdJTkc6ICdodHRwczovL2FwaS1nYXRld2F5LXN0Zy50cmFuc2FrLmNvbS9hcGkvdjIvYXV0aC9zZXNzaW9uJyxcclxuICBQUk9EVUNUSU9OOiAnaHR0cHM6Ly9hcGktZ2F0ZXdheS50cmFuc2FrLmNvbS9hcGkvdjIvYXV0aC9zZXNzaW9uJyxcclxufVxyXG5cclxuZnVuY3Rpb24gaXNTdGVsbGFyQWRkcmVzcyhhZGRyKSB7XHJcbiAgcmV0dXJuIHR5cGVvZiBhZGRyID09PSAnc3RyaW5nJyAmJiAvXkdbQS1aMi03XXs1NX0kLy50ZXN0KGFkZHIpXHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhZChyZXMsIG1zZykge1xyXG4gIHJlcy5zdGF0dXNDb2RlID0gNDAwXHJcbiAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogbXNnIH0pKVxyXG59XHJcblxyXG4vKipcclxuICogQnVpbGQgdGhlIFRyYW5zYWsgYHdpZGdldFBhcmFtc2AgYm9keSBmb3IgYSBVU0RDLXRvLVN0ZWxsYXIgb24tcmFtcCBzZXNzaW9uLiBMb2NrcyB0aGVcclxuICogbmV0d29yay9hc3NldC9kZXN0aW5hdGlvbiBzbyB0aGUgd2lkZ2V0IGNhbid0IGJlIHJlZGlyZWN0ZWQgdG8gYSBkaWZmZXJlbnQgY2hhaW4gb3Igd2FsbGV0LlxyXG4gKiBWRVJJRlk6IGBkaXNhYmxlV2FsbGV0QWRkcmVzc0Zvcm1gICsgYG5ldHdvcms6J3N0ZWxsYXInYCB0b2dldGhlciBcdTIwMTQgVHJhbnNhaydzIG93biBleGFtcGxlc1xyXG4gKiBvbmx5IHNob3cgdGhpcyBjb21ibyB3aXRoIGFuIEVWTSAweFx1MjAyNiBhZGRyZXNzOyB0aGUgY3J5cHRvLWN1cnJlbmNpZXMgQVBJIGNvbmZpcm1zXHJcbiAqIG5ldHdvcms6J3N0ZWxsYXInICsgVVNEQyBpcyBhIHZhbGlkLCBidXktYWxsb3dlZCBwYWlyLCBidXQgdGhlIGV4YWN0IHdhbGxldC1mb3JtLWxvY2sgVVggZm9yXHJcbiAqIGEgbm9uLUVWTSBhZGRyZXNzIGZvcm1hdCBpcyB3b3J0aCBhIG1hbnVhbCBzYW5kYm94IHJ1biBiZWZvcmUgZ28tbGl2ZS5cclxuICogaHR0cHM6Ly9kb2NzLnRyYW5zYWsuY29tL2d1aWRlcy9ob3ctdG8tY3JlYXRlLWEtd2lkZ2V0LXVybC1hbmQtdGVzdC1kaWZmZXJlbnQtc2NlbmFyaW9zXHJcbiAqIEBwYXJhbSB7eyBhZGRyZXNzOiBzdHJpbmcsIGFtb3VudD86IG51bWJlciB9fSBwXHJcbiAqIEByZXR1cm5zIHtvYmplY3R9XHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRXaWRnZXRQYXJhbXMoeyBhZGRyZXNzLCBhbW91bnQgfSkge1xyXG4gIGNvbnN0IHBhcmFtcyA9IHtcclxuICAgIGFwaUtleTogQVBJX0tFWSgpLFxyXG4gICAgcmVmZXJyZXJEb21haW46IFJFRkVSUkVSX0RPTUFJTigpLFxyXG4gICAgcHJvZHVjdHNBdmFpbGVkOiAnQlVZJyxcclxuICAgIG5ldHdvcms6ICdzdGVsbGFyJyxcclxuICAgIGNyeXB0b0N1cnJlbmN5Q29kZTogJ1VTREMnLFxyXG4gICAgd2FsbGV0QWRkcmVzczogYWRkcmVzcyxcclxuICAgIGRpc2FibGVXYWxsZXRBZGRyZXNzRm9ybTogdHJ1ZSxcclxuICB9XHJcbiAgaWYgKGFtb3VudCkge1xyXG4gICAgcGFyYW1zLmZpYXRDdXJyZW5jeSA9ICdVU0QnXHJcbiAgICBwYXJhbXMuZmlhdEFtb3VudCA9IGFtb3VudFxyXG4gIH1cclxuICByZXR1cm4gcGFyYW1zXHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlYWRCb2R5KHJlcSkge1xyXG4gIGlmIChyZXEuYm9keSAmJiB0eXBlb2YgcmVxLmJvZHkgPT09ICdvYmplY3QnKSByZXR1cm4gcmVxLmJvZHlcclxuICBjb25zdCBjaHVua3MgPSBbXVxyXG4gIGZvciBhd2FpdCAoY29uc3QgYyBvZiByZXEpIGNodW5rcy5wdXNoKGMpXHJcbiAgY29uc3QgcmF3ID0gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKCd1dGY4JylcclxuICByZXR1cm4gcmF3ID8gSlNPTi5wYXJzZShyYXcpIDoge31cclxufVxyXG5cclxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihyZXEsIHJlcykge1xyXG4gIGlmIChyZXEubWV0aG9kICE9PSAnUE9TVCcpIHtcclxuICAgIHJlcy5zdGF0dXNDb2RlID0gNDA1XHJcbiAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnTWV0aG9kIG5vdCBhbGxvd2VkJyB9KSlcclxuICB9XHJcbiAgaWYgKCFhcHBseUNvcnMocmVxLCByZXMpKSByZXR1cm5cclxuICBpZiAoIXJhdGVMaW1pdChyZXEsIHJlcywgeyBtYXg6IDEwLCB3aW5kb3dNczogNjBfMDAwLCBidWNrZXQ6ICdvbnJhbXAtc2Vzc2lvbicgfSkpIHJldHVyblxyXG4gIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJylcclxuXHJcbiAgY29uc3QgYXBpS2V5ID0gQVBJX0tFWSgpXHJcbiAgY29uc3QgYWNjZXNzVG9rZW4gPSBBQ0NFU1NfVE9LRU4oKVxyXG4gIGlmICghYXBpS2V5IHx8ICFhY2Nlc3NUb2tlbikge1xyXG4gICAgcmVzLnN0YXR1c0NvZGUgPSA1MDNcclxuICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdPbi1yYW1wIG5vdCBjb25maWd1cmVkJywgY29uZmlndXJlZDogZmFsc2UgfSkpXHJcbiAgfVxyXG5cclxuICB0cnkge1xyXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRCb2R5KHJlcSlcclxuICAgIGNvbnN0IHByb3ZpZGVyID0gYm9keS5wcm92aWRlciB8fCAndHJhbnNhaydcclxuXHJcbiAgICBpZiAocHJvdmlkZXIgPT09ICdjb2luYmFzZS1iYXNlJykge1xyXG4gICAgICAvLyBEb2N1bWVudGVkIGZhbGxiYWNrIChzcGVjIFx1MDBBNzkpIFx1MjAxNCBkZWxpYmVyYXRlbHkgTk9UIHdpcmVkIHlldC4gQ29pbmJhc2UncyBTZXNzaW9uIFRva2VuXHJcbiAgICAgIC8vIEFQSSBhdXRoZW50aWNhdGVzIHdpdGggYSBDRFAta2V5LXNpZ25lZCBKV1QgKGEgU2VjcmV0IEFQSSBLZXkgKyBjZHBjdXJsLXN0eWxlIHNpZ25pbmcpLFxyXG4gICAgICAvLyBhIG1hdGVyaWFsbHkgc2VwYXJhdGUgaW50ZWdyYXRpb24gZnJvbSBUcmFuc2FrJ3Mgc3RhdGljIGFjY2Vzcy10b2tlbiBoZWFkZXIuIEJ1aWxkIHRoaXNcclxuICAgICAgLy8gYnJhbmNoIG9ubHkgaWYgVHJhbnNhayBiZWNvbWVzIHVuYXZhaWxhYmxlIGZvciBhIHRhcmdldCBjb3VudHJ5L0tZQyB0aWVyLlxyXG4gICAgICAvLyBodHRwczovL2RvY3MuY2RwLmNvaW5iYXNlLmNvbS9vbnJhbXAvaW50cm9kdWN0aW9uL3F1aWNrc3RhcnRcclxuICAgICAgcmVzLnN0YXR1c0NvZGUgPSA1MDFcclxuICAgICAgcmV0dXJuIHJlcy5lbmQoXHJcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ2NvaW5iYXNlLWJhc2UgcHJvdmlkZXIgbm90IHlldCBpbXBsZW1lbnRlZCcsIGNvbmZpZ3VyZWQ6IGZhbHNlIH0pXHJcbiAgICAgIClcclxuICAgIH1cclxuICAgIGlmIChwcm92aWRlciAhPT0gJ3RyYW5zYWsnKSB7XHJcbiAgICAgIHJldHVybiBiYWQocmVzLCAnVW5rbm93biBwcm92aWRlcicpXHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCFpc1N0ZWxsYXJBZGRyZXNzKGJvZHkuYWRkcmVzcykpIHJldHVybiBiYWQocmVzLCAnSW52YWxpZCBTdGVsbGFyIGFkZHJlc3MnKVxyXG4gICAgaWYgKGJvZHkuYW1vdW50ICE9IG51bGwgJiYgKHR5cGVvZiBib2R5LmFtb3VudCAhPT0gJ251bWJlcicgfHwgYm9keS5hbW91bnQgPD0gMCkpIHtcclxuICAgICAgcmV0dXJuIGJhZChyZXMsICdJbnZhbGlkIGFtb3VudCcpXHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgd2lkZ2V0UGFyYW1zID0gYnVpbGRXaWRnZXRQYXJhbXMoeyBhZGRyZXNzOiBib2R5LmFkZHJlc3MsIGFtb3VudDogYm9keS5hbW91bnQgfSlcclxuICAgIGNvbnN0IHNlc3Npb25VcmwgPSBTRVNTSU9OX0FQSV9VUkxbRU5WSVJPTk1FTlQoKV0gfHwgU0VTU0lPTl9BUElfVVJMLlNUQUdJTkdcclxuXHJcbiAgICBjb25zdCB1cHN0cmVhbSA9IGF3YWl0IGZldGNoKHNlc3Npb25VcmwsIHtcclxuICAgICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICAgIGhlYWRlcnM6IHsgJ2FjY2Vzcy10b2tlbic6IGFjY2Vzc1Rva2VuLCAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXHJcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgd2lkZ2V0UGFyYW1zIH0pLFxyXG4gICAgfSlcclxuICAgIGlmICghdXBzdHJlYW0ub2spIHtcclxuICAgICAgcmVzLnN0YXR1c0NvZGUgPSA1MDJcclxuICAgICAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ09uLXJhbXAgc2Vzc2lvbiByZXF1ZXN0IGZhaWxlZCcgfSkpXHJcbiAgICB9XHJcbiAgICBjb25zdCBkYXRhID0gYXdhaXQgdXBzdHJlYW0uanNvbigpXHJcbiAgICAvLyBWRVJJRlk6IFRyYW5zYWsncyBkb2N1bWVudGVkIHJlc3BvbnNlIG5lc3RzIGFzIHsgcmVzcG9uc2U6IHsgd2lkZ2V0VXJsIH0gfSAoY29uZmlybWVkLFxyXG4gICAgLy8gc2VlIGRvY3MudHJhbnNhay5jb20vZ3VpZGVzL21pZ3JhdGlvbi10by1hcGktYmFzZWQtdHJhbnNhay13aWRnZXQtdXJsKSBcdTIwMTQgdGhlIGZsYXRcclxuICAgIC8vIGZhbGxiYWNrIGJlbG93IGlzIGRlZmVuc2l2ZSBvbmx5LCBpbiBjYXNlIHRoZXkgY2hhbmdlIHRoZSBlbnZlbG9wZSBzaGFwZS5cclxuICAgIGNvbnN0IHdpZGdldFVybCA9IGRhdGE/LnJlc3BvbnNlPy53aWRnZXRVcmwgfHwgZGF0YT8ud2lkZ2V0VXJsXHJcbiAgICBpZiAoIXdpZGdldFVybCkge1xyXG4gICAgICByZXMuc3RhdHVzQ29kZSA9IDUwMlxyXG4gICAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnT24tcmFtcCBzZXNzaW9uIHJlc3BvbnNlIG1pc3Npbmcgd2lkZ2V0VXJsJyB9KSlcclxuICAgIH1cclxuICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgd2lkZ2V0VXJsIH0pKVxyXG4gIH0gY2F0Y2ggKGVycikge1xyXG4gICAgY29uc29sZS5lcnJvcignW2FwaS9vbnJhbXAtc2Vzc2lvbl0gZXJyb3I6JywgZXJyPy5tZXNzYWdlIHx8IGVycilcclxuICAgIHJlcy5zdGF0dXNDb2RlID0gNTAyXHJcbiAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnT24tcmFtcCBzZXNzaW9uIGZhaWxlZCcgfSkpXHJcbiAgfVxyXG59XHJcbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7O0FBdUJPLFNBQVMsaUJBQWlCO0FBQy9CLFFBQU0sVUFBVSxRQUFRLElBQUksaUJBQ3hCLFFBQVEsSUFBSSxlQUFlLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLElBQ3pELENBQUM7QUFDTCxTQUFPLENBQUMsR0FBSSxTQUFTLENBQUMsSUFBSSxhQUFjLEdBQUcsT0FBTyxFQUFFLE9BQU8sT0FBTztBQUNwRTtBQU1PLFNBQVMsVUFBVSxLQUFLLEtBQUs7QUFDbEMsUUFBTSxTQUFTLElBQUksUUFBUSxVQUFVO0FBQ3JDLE1BQUksQ0FBQyxlQUFlLEVBQUUsU0FBUyxNQUFNLEdBQUc7QUFDdEMsUUFBSSxhQUFhO0FBQ2pCLFFBQUksVUFBVSxnQkFBZ0Isa0JBQWtCO0FBQ2hELFFBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxPQUFPLFlBQVksQ0FBQyxDQUFDO0FBQzlDLFdBQU87QUFBQSxFQUNUO0FBQ0EsTUFBSSxVQUFVLCtCQUErQixNQUFNO0FBQ25ELE1BQUksVUFBVSxnQ0FBZ0MsTUFBTTtBQUNwRCxNQUFJLFVBQVUsZ0NBQWdDLGNBQWM7QUFDNUQsU0FBTztBQUNUO0FBWUEsU0FBUyxTQUFTLEtBQUs7QUFJckIsUUFBTSxPQUFPLElBQUksUUFBUSxXQUFXO0FBQ3BDLE1BQUksT0FBTyxTQUFTLFlBQVksS0FBSyxLQUFLLEVBQUcsUUFBTyxLQUFLLEtBQUs7QUFNOUQsUUFBTSxNQUFNLElBQUksUUFBUSxpQkFBaUI7QUFDekMsTUFBSSxtQkFBbUIsS0FBSyxPQUFPLFFBQVEsWUFBWSxJQUFJLEtBQUssR0FBRztBQUNqRSxVQUFNLFFBQVEsSUFBSSxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUss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RDtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTCxTQUFTLENBQUMsTUFBTSxHQUFHLGNBQWM7QUFBQSxJQUNqQyxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsTUFDTCxRQUFRO0FBQUEsTUFDUixlQUFlO0FBQUEsUUFDYixVQUFVLENBQUM7QUFBQSxRQUNYLFFBQVE7QUFBQSxVQUNOLGFBQWEsSUFBSTtBQUNmLGdCQUFJLENBQUMsR0FBRyxTQUFTLGNBQWMsRUFBRztBQU9sQyxnQkFBSSxHQUFHLFNBQVMsZUFBZSxFQUFHLFFBQU87QUFDekMsbUJBQU87QUFBQSxVQUNUO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsSUFDQSxRQUFRO0FBQUEsTUFDTixvQkFBb0I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLE1BS3BCLElBQUk7QUFBQSxRQUNGLE9BQU8sQ0FBQyxRQUFRO0FBQUEsTUFDbEI7QUFBQSxJQUNGO0FBQUEsSUFDQSxTQUFTO0FBQUEsTUFDUCxvQkFBb0I7QUFBQSxJQUN0QjtBQUFBLElBQ0EsY0FBYztBQUFBLE1BQ1osU0FBUyxDQUFDLHNCQUFzQjtBQUFBLElBQ2xDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBTUEsTUFBTTtBQUFBLE1BQ0osS0FBSztBQUFBLFFBQ0gsMkJBQTJCO0FBQUEsUUFDM0IsMEJBQTBCO0FBQUEsUUFDMUIsMEJBQTBCO0FBQUEsUUFDMUIsMEJBQTBCO0FBQUEsTUFDNUI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbImhhbmRsZXIiLCAiS2V5cGFpciIsICJzZW5kIiwgInJlYWRCb2R5IiwgInJlYWRCb2R5IiwgImhhbmRsZXIiLCAiUEFTU1BIUkFTRSIsICJSUENfVVJMIiwgIlRPS0VOX0FERFIiLCAiS2V5cGFpciIsICJyZWFkQm9keSIsICJiYWQiLCAiaGFuZGxlciIsICJoYW5kbGVyIiwgImpzb24iLCAiaGFuZGxlciIsICJyYXRlTGltaXQiLCAianNvbiIsICJyYXRlTGltaXQiLCAiaGFuZGxlciIsICJqc29uIiwgImhhbmRsZXIiLCAiaGFuZGxlciIsICJqc29uIiwgImhhbmRsZXIiLCAiU3RyS2V5IiwgImpzb24iLCAiaGFuZGxlciIsICJqc29uIiwgImhhbmRsZXIiLCAiZmVlQnVtcEFuZFN1Ym1pdCIsICJTdHJLZXkiLCAiYmlnaW50U2FmZSIsICJoYW5kbGVyIiwgIlN0cktleSIsICJ6IiwgIkRFRVBTRUVLX1VSTCIsICJqc29uIiwgInoiLCAiaGFuZGxlciIsICJoYW5kbGVyIiwgImJhZCIsICJyZWFkQm9keSIsICJoYW5kbGVyIiwgImhhbmRsZXIiXQp9Cg==
