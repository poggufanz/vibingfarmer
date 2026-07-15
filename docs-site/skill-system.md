# The skill system

Each agent gets exactly one typed skill file. It is deposit-only, and every amount is expressed in 7-decimal base units.

```json
{
  "agentId": "worker-agent-1",
  "vaultAddress": "CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77",
  "skills": {
    "deposit": {
      "maxAmount": "1000000000",
      "vaultAddress": "CDWHNHIH…KM77",
      "expiresAt": 1749686400
    }
  },
  "generatedBy": "venice-ai",
  "approvedByUser": true
}
```

## Reading the fields

`maxAmount` is in 7-decimal base units, so `1000000000` means 100 USDC. `vaultAddress` pins the one vault this agent may deposit into. `expiresAt` is a hard expiry after which the skill is dead. `generatedBy` records which AI provider produced the plan, and `approvedByUser` is only ever true after you approve it in the Skills Drawer.

## Editing before approval

Every field is editable in the Skills Drawer before you sign. Lower a cap, shorten an expiry, or retarget a vault — nothing executes until you approve. You can also swap in custom skill files from **Settings** if you'd rather write them yourself.

## Why this shape matters

The skill file is a proposal, not an authority. Even a perfectly-formed skill file can't move funds on its own — execution is gated by the on-chain agent account, which enforces the same deposit-only, vault-pinned, capped, expiring scope independently of whatever the file claims. The file describes intent; the contract enforces it.
