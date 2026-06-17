# Notes: EIP-7702 & ERC-7715 Test Findings

_Ditulis: 2026-05-27 | Relevan untuk: Phase 3 Integration_

---

## EIP-7702

- `eth_signAuthorization` **tidak bisa** dipanggil langsung via `window.ethereum`
- MetaMask Flask tidak expose raw EIP-7702 signing ke dApp
- EIP-7702 dihandle **internal** oleh MetaMask Smart Accounts Kit saat permission di-grant
- **Jangan** panggil `eth_signAuthorization` manual — pakai SAK actions (`erc7715ProviderActions`)

## ERC-7715 — Field Types yang Benar

```js
{
  permission: {
    type: 'erc20-token-periodic',
    data: {
      periodAmount: '0x' + value.toString(16),  // hex string ✅
      periodDuration: 86400,                     // plain integer ✅
    }
  },
  rules: [{
    type: 'expiry',
    data: { timestamp: Math.floor(Date.now() / 1000) + 3600 }  // plain integer ✅
  }]
}
```

## Error Messages

| Field | Salah | Error |
|-------|-------|-------|
| `periodAmount` | plain string `'10000000'` | `"data.periodAmount: Invalid hex value"` |
| `periodDuration` | hex string `'0x15180'` | `"data.periodDuration: Expected number, received string"` |
| `timestamp` | hex string | `"Expiry timestamp must be a valid positive integer"` |

## Status Gate Check Phase 1

| Check | Status |
|-------|--------|
| `wallet_getSupportedExecutionPermissions` | ✅ bekerja |
| `wallet_requestExecutionPermissions` | ✅ bekerja |
| EIP-7702 raw via injected provider | ❌ tidak bisa — pakai SAK |

## Action Phase 3

- Setup `@metamask/smart-accounts-kit` via ESM CDN
- Pakai `erc7715ProviderActions` wrapper — bukan raw `ethereum.request`
- Ref: https://docs.metamask.io/smart-accounts-kit/
