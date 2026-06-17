/**
 * Sketch: the iframe-side wallet helper.
 *
 * This is a minimal, copy-able version of `WalletFrame` from the 1Shot Payments
 * codebase. It handles:
 *   - fetching authentication options from your server
 *   - injecting the PRF extension with your constant infoLabel
 *   - running the WebAuthn ceremony
 *   - deriving an EVM private key from the PRF output
 *   - caching the unlocked wallet in iframe closure state
 *   - an RPC envelope for multiplexing responses through a single Postmate event
 *
 * Copy into your iframe route and adapt to your error types and API shape.
 *
 * Dependencies:
 *   npm install @simplewebauthn/browser ethers postmate
 *   npm install bowser           # for your platformSupport.ts
 */

import {
  startAuthentication,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { Wallet } from "ethers";
import type Postmate from "postmate";

import { prfToValidEthPrivKey } from "./prfToValidEthPrivKey";

// ---------------------------------------------------------------------------
// Constants — fill these in for your app
// ---------------------------------------------------------------------------

/** The forever-stable key derivation label. Version it (`-v1`) and never change. */
const ETH_KEY_DERIVATION_LABEL = "com.example.eth-key-v1";

/** The single Postmate event name used to return RPC responses to the parent. */
const RPC_CALLBACK_EVENT = "rpc:callback";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserModel {
  id: string;
  username: string;
  accountAddress: string | null;
}

export interface AuthResult {
  success: boolean;
  user?: UserModel;
  walletUnlocked: boolean;
  error?: string;
  canRetry?: boolean;
}

export interface FullAuthResult extends AuthResult {
  wallet?: Wallet;
}

// WebAuthn PRF extension typing (the SimpleWebAuthn types don't cover PRF yet)
interface PrfExtensionResults {
  prf?: { results?: { first?: unknown } };
}
type PrfRequestOptions = PublicKeyCredentialRequestOptionsJSON & {
  challengeId: string;
  extensions?: AuthenticationExtensionsClientInputs & {
    prf?: { eval: { first: Uint8Array } };
  };
};

interface RpcEnvelope<T> {
  callbackNonce: number;
  params: T;
}

interface RpcReturn {
  success: boolean;
  callbackNonce: number;
  result: string;
}

function decodeBase64URLOrBase64ToUint8Array(value: string): Uint8Array | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(normalized)) return null;

  const base64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
  if (base64.length % 4 === 1) return null;
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

  try {
    const binaryString = atob(padded);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

/**
 * Chrome sometimes exposes `clientExtensionResults.prf.results.first` as a plain
 * `Array` of byte values (0–255), not an ArrayBuffer or TypedArray.
 */
function uint8ArrayFromByteNumberArray(
  arr: readonly unknown[],
): Uint8Array | null {
  const len = arr.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const v = arr[i];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) {
      return null;
    }
    out[i] = v;
  }
  return out;
}

/**
 * Normalize runtime PRF output to ArrayBuffer.
 * Some provider/library combinations return non-BufferSource values.
 */
function normalizePrfOutput(prfOutput: unknown): ArrayBuffer | null {
  if (prfOutput instanceof ArrayBuffer) {
    return prfOutput;
  }
  if (ArrayBuffer.isView(prfOutput)) {
    const view = prfOutput as ArrayBufferView;
    return bytesToArrayBuffer(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  if (Array.isArray(prfOutput)) {
    const bytes = uint8ArrayFromByteNumberArray(prfOutput);
    return bytes ? bytesToArrayBuffer(bytes) : null;
  }
  if (typeof prfOutput === "string") {
    const decoded = decodeBase64URLOrBase64ToUint8Array(prfOutput);
    return decoded ? bytesToArrayBuffer(decoded) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WalletFrame
// ---------------------------------------------------------------------------

export class WalletFrame {
  private authResult: FullAuthResult | null = null;
  private ceremonyPromise: Promise<FullAuthResult> | null = null;

  constructor(private postmateModel: Postmate.Model) {}

  getAuthResultSync(): FullAuthResult | null {
    return this.authResult;
  }

  setAuthResult(result: FullAuthResult | null) {
    this.authResult = result;
  }

  clearAuthResult() {
    this.authResult = null;
  }

  /**
   * Check session status with the server. Never triggers a passkey ceremony.
   */
  async getStatus(): Promise<AuthResult> {
    try {
      const res = await fetch("/api/user", { credentials: "include" });
      if (!res.ok) return { success: false, walletUnlocked: false };
      const { session, user } = await res.json();
      if (!session || !user) return { success: false, walletUnlocked: false };

      this.authResult = {
        success: true,
        user,
        walletUnlocked: false,
        wallet: undefined,
      };
      return { success: true, user, walletUnlocked: false };
    } catch {
      return {
        success: false,
        walletUnlocked: false,
        error: "Failed to check session",
      };
    }
  }

  /**
   * Ensure the wallet is unlocked. Runs a passkey ceremony if needed.
   */
  async assureWallet(): Promise<Wallet> {
    if (this.authResult?.walletUnlocked && this.authResult.wallet) {
      return this.authResult.wallet;
    }
    if (!this.authResult?.user?.username) {
      throw new Error("Not authenticated; cannot unlock wallet");
    }
    const result = await this.authenticateWithPasskey(
      this.authResult.user.username,
    );
    if (!result.success || !result.wallet) {
      throw new Error(result.error ?? "Unlock failed");
    }
    return result.wallet;
  }

  /**
   * Run the full passkey ceremony: fetch options, start authentication with
   * PRF, derive the Ethereum key, verify with the server, cache the wallet.
   */
  async authenticateWithPasskey(username: string): Promise<FullAuthResult> {
    if (this.ceremonyPromise) return this.ceremonyPromise;

    const ceremony = (async (): Promise<FullAuthResult> => {
      // 1. Fetch authentication options
      const optionsRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username }),
      });
      if (!optionsRes.ok) {
        return {
          success: false,
          walletUnlocked: false,
          error: "Failed to fetch authentication options",
          canRetry: true,
        };
      }
      const authOptions = (await optionsRes.json()) as PrfRequestOptions;

      // 2. Inject PRF extension client-side (never trust the server for this)
      const infoLabel = new TextEncoder().encode(ETH_KEY_DERIVATION_LABEL);
      authOptions.extensions = {
        ...authOptions.extensions,
        prf: { eval: { first: infoLabel } },
      };

      // 3. Run the ceremony
      let credential;
      try {
        credential = await startAuthentication({ optionsJSON: authOptions });
      } catch (e) {
        return {
          success: false,
          walletUnlocked: false,
          error:
            "Passkey authentication cancelled or timed out. Make sure you're not in an in-app browser.",
          canRetry: true,
        };
      }

      // 4. Extract PRF output
      const rawPrfOutput = (
        credential.clientExtensionResults as PrfExtensionResults
      ).prf?.results?.first;
      const prfOutput = normalizePrfOutput(rawPrfOutput);
      if (!prfOutput) {
        console.warn("Unsupported PRF output shape", {
          type: typeof rawPrfOutput,
          constructorName:
            rawPrfOutput &&
            typeof rawPrfOutput === "object" &&
            "constructor" in rawPrfOutput
              ? rawPrfOutput.constructor.name
              : null,
          isArrayBuffer: rawPrfOutput instanceof ArrayBuffer,
          isArrayBufferView: ArrayBuffer.isView(rawPrfOutput),
        });
        return {
          success: false,
          walletUnlocked: false,
          error:
            "Passkey does not support PRF. Use the same passkey provider you registered with.",
          canRetry: false,
        };
      }

      // 5. Derive the EVM private key
      let privateKey;
      try {
        privateKey = await prfToValidEthPrivKey(prfOutput, infoLabel);
      } catch (e) {
        return {
          success: false,
          walletUnlocked: false,
          error: "Failed to derive wallet key from PRF output",
        };
      }
      const wallet = new Wallet(privateKey);

      // 6. Verify with the server
      const verifyRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          credential,
          challengeId: authOptions.challengeId,
          accountAddress: wallet.address,
        }),
      });
      if (!verifyRes.ok) {
        return {
          success: false,
          walletUnlocked: false,
          error: "Server rejected authentication",
        };
      }
      const { user } = (await verifyRes.json()) as { user: UserModel };

      this.authResult = { success: true, user, walletUnlocked: true, wallet };
      return this.authResult;
    })();

    this.ceremonyPromise = ceremony;
    try {
      return await ceremony;
    } finally {
      this.ceremonyPromise = null;
    }
  }

  getAccountAddress(): string | null {
    return this.authResult?.user?.accountAddress ?? null;
  }

  /**
   * RPC envelope: the parent sends `{ callbackNonce, params }` to a named method,
   * and the child replies via a single `rpc:callback` event with `{ success, callbackNonce, result }`.
   *
   * Usage in your Postmate.Model:
   *   signIn: async (paramString) => {
   *     walletFrame.rpcWrapper(paramString, ({ username }) => {
   *       return walletFrame.authenticateWithPasskey(username);
   *     });
   *   },
   */
  async rpcWrapper<TParams, TReturn>(
    paramString: string,
    handler: (params: TParams) => Promise<TReturn>,
  ): Promise<void> {
    let envelope: RpcEnvelope<TParams>;
    try {
      envelope = JSON.parse(paramString) as RpcEnvelope<TParams>;
    } catch {
      return;
    }

    const { callbackNonce, params } = envelope;

    try {
      const result = await handler(params);
      this.postmateModel.emit(
        RPC_CALLBACK_EVENT,
        JSON.stringify({
          success: true,
          callbackNonce,
          result: JSON.stringify(result),
        } satisfies RpcReturn),
      );
    } catch (err) {
      this.postmateModel.emit(
        RPC_CALLBACK_EVENT,
        JSON.stringify({
          success: false,
          callbackNonce,
          result: JSON.stringify({
            message: err instanceof Error ? err.message : String(err),
          }),
        } satisfies RpcReturn),
      );
    }
  }
}
