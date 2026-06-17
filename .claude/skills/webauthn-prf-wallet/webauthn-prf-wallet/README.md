# webauthn-prf-wallet

An Agent Skill for implementing an **iframe-isolated, passkey-derived Ethereum wallet** using the WebAuthn PRF extension.

This skill teaches an AI coding agent how to build a non-custodial EVM wallet where:

- The private key is deterministically derived from a user's **passkey** via the WebAuthn PRF extension + HKDF-SHA-256.
- The key lives only inside an **isolated, same-origin iframe** — the parent page's JavaScript can never read it, substantially reducing XSS and supply-chain risk.
- Users on platforms without PRF support fall back to **LongBlob** (`credBlob` / `largeBlob`) and/or an AES-encrypted **recovery phrase**, so nobody is locked out.
- The server **never** sees the private key, the PRF output, or anything derived from it — it only verifies WebAuthn signatures.

It was extracted from a production implementation and distilled into framework-agnostic guidance plus a concrete Next.js example.

## What's in this skill

```
webauthn-prf-wallet/
├── SKILL.md                          # Top-level entry point — read first
├── README.md                         # You are here
├── references/
│   ├── prf-derivation.md             # PRF output → secp256k1 key (HKDF)
│   ├── platform-support.md           # Browser/OS/webview compatibility gating
│   ├── iframe-isolation.md           # Postmate RPC + the display:none gotcha
│   ├── longblob-fallback.md          # credBlob / largeBlob / recovery phrase
│   ├── server-integration.md         # WebAuthn RP endpoints (framework-agnostic)
│   └── nextjs-example.md             # Concrete Next.js App Router walkthrough
└── assets/
    ├── prfToValidEthPrivKey.ts       # Copy-ready HKDF derivation (Web Crypto)
    ├── platformSupport.ts            # Copy-ready isWebview / isPlatformSupported
    └── WalletIframeSketch.ts         # Copy-ready iframe wallet helper
```

## How to use this skill

### With a Cursor / Claude / other agent

Point your agent at `SKILL.md`. The frontmatter `description` is written to trigger on prompts like:

- "add a passkey-based Ethereum wallet"
- "derive a private key from a WebAuthn credential"
- "I want a non-custodial wallet that doesn't require a seed phrase"
- "check if the browser supports WebAuthn PRF"

The agent will then read `SKILL.md`, pull in relevant `references/*.md` files, and copy / adapt the files in `assets/` into the host project.

### Manually

1. Read [`SKILL.md`](./SKILL.md) end-to-end first — it's the overview and lists the critical nuances.
2. Copy `assets/prfToValidEthPrivKey.ts` and `assets/platformSupport.ts` into your project's client utilities.
3. Use `assets/WalletIframeSketch.ts` as the starting point for the iframe page's helper class.
4. Follow [`references/iframe-isolation.md`](./references/iframe-isolation.md) to set up the parent `WalletProxy` and the Postmate handshake.
5. Follow [`references/server-integration.md`](./references/server-integration.md) (or [`references/nextjs-example.md`](./references/nextjs-example.md) for Next.js specifically) to wire up the WebAuthn relying party endpoints.
6. Add [`references/longblob-fallback.md`](./references/longblob-fallback.md) if you need to support devices without PRF.

## Prerequisites

- A web app you control (SPA, Next.js, SvelteKit, etc.) with HTTPS in production.
- A server endpoint for WebAuthn registration/authentication with a short-TTL challenge store (Redis, Cloudflare KV, DynamoDB with TTL, etc.).
- A database for users and passkey credentials.

## Runtime dependencies

The snippets in `assets/` assume:

```bash
npm install @simplewebauthn/browser @simplewebauthn/server ethers postmate bowser
```

`@simplewebauthn/server` and `ethers` versions work with any recent major; the code does not depend on bleeding-edge features.

## License

MIT. Adapt freely. If you publish derivatives, a link back is appreciated but not required.

## Security considerations

This skill documents a pattern that hardens wallet key handling, but does not magically make your app secure. At minimum:

- **Serve the iframe from the same origin** as the parent. Cross-origin iframes break the security model (and most browsers will refuse the `publickey-credentials-get` permission anyway).
- **Set a strict Content-Security-Policy** on both the parent and iframe routes.
- **Never log or transmit** the PRF output, derived private key, or ceremony extension results. Audit your logging paths.
- **Require a fresh passkey ceremony for every wallet operation**. The iframe may cache the wallet in memory for a single user action, but do not persist across navigations.
- **Version your derivation label** (see `references/prf-derivation.md`). Changing the label after users register breaks their wallets.
- Run a security review before shipping. This is wallet-adjacent code; treat it accordingly.

## Credits

Extracted from the 1Shot Payments implementation. Thanks to the W3C WebAuthn WG for the PRF extension and to the MetaMask Snap / Delegation Toolkit teams for demonstrating non-custodial patterns on the EVM.
