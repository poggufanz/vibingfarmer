# Interactive Controls & Dead-Button Audit

This audit indexes every user interactive control (`onClick`, `onChange`, `href`) across the Yield Vibing frontend codebase, classifying its handler, live behavior, and status.

## 1. Interactive Controls Directory

| File | Line | Control / Label | Handler / Action | Verdict / Status |
|:---|:---|:---|:---|:---|
| `app.jsx` | 76 | Connect button | `handleConnect()` async | **LIVE** · Triggers MetaMask Flask wallet connect |
| `app.jsx` | 124 | Revoke permissions button | `handleRevoke()` | **LIVE** · Resets EIP-7715 permission state |
| `app.jsx` | 809 | Start New Strategy (TopBar) | `handleAgain()` | **LIVE** · Returns state machine to Strategy stage |
| `app.jsx` | 854 | Start New Strategy (dashboard) | `handleAgain()` | **LIVE** · Returns state machine to Strategy stage |
| `app.jsx` | 1196 | Jump to step (dev mode buttons) | `jumpTo(stageId)` | **LIVE** · Navigates stages (dev-only gated) |
| `AgentDashboard.jsx` | 95 | destructured props | removed `onOpenSettings` | **CLEANED** · Removed dead wire to legacy edit-mode |
| `AgentDashboard.jsx` | 185 | Withdraw button (positions row) | `setWithdrawVault(...)` | **LIVE** · Opens withdraw modal sheet |
| `AgentDashboard.jsx` | 205 | Alert Action Claim/Harvest | `onHarvest(...)` / `onEmergencyWithdraw(...)` | **LIVE** · Opens preview modal before triggering worker |
| `SettingsPage.jsx` | 71 | Show/Hide API key button | `setReveal((r) => !r)` | **LIVE** · UI visual toggle |
| `SettingsPage.jsx` | 72 | Clear API key button | `onClear()` | **LIVE** · Wipes local key store |
| `SettingsPage.jsx` | 75 | Test connection button | `onTest()` (e.g. `testVenice`, `testTavily`) | **LIVE** · Triggers AJAX ping with timeout fallback |
| `SettingsPage.jsx` | 195 | Change skill button | `onChangeSkill()` | **LIVE** · Opens SkillDrawer component |
| `SettingsPage.jsx` | 199-200 | AI Model radio choices | `set('modelPreference', ...)` | **HONEST** · Flash/Pro fictional models replaced with Auto/Venice x402 |
| `SettingsPage.jsx` | 323-324 | View on GitHub / HackQuest links | `ghUrl`, `hqUrl` href anchors | **FIXED** · Failsafe hide if variables default to `#` |
| `SkillDrawer.jsx` | 73 | Custom Strategy tab button | `selectCustom()` | **LIVE** · Focuses custom markdown text editor |
| `SkillDrawer.jsx` | 90 | Upload markdown button | `fileRef.current.click()` | **LIVE** · Triggers local browser file dialog |
| `WithdrawModal.jsx` | 81 | Percentage buttons (25%/50%/75%/Max) | `setPct(percentage)` | **LIVE** · Multiplies input amount by vault balance |
| `WithdrawModal.jsx` | 101 | Modal primary Withdraw button | `handleConfirm()` async | **LIVE** · Triggers ERC-7715 relayer execution |
| `AgentActionPreview.jsx`| 61 | Confirm withdraw / harvest | `onConfirm()` | **LIVE** · Dispatches worker execution block |

## 2. Dead-Button Remediation Summary

1. **onOpenSettings Dead Prop**: Destructured in `AgentDashboard.jsx` but never referenced in its render body (remnant of a removed inline edit-mode). Removed from `app.jsx` caller and destructured arguments.
2. **Settings About Links**: Originally pointed to `#` when VITE_GITHUB_URL and VITE_HACKQUEST_URL env vars were omitted, creating dead buttons. Wrapped links in conditional checks (`!== '#'`) to render cleanly only when URL values exist.
3. **No-Op Button Inventory**: Checked all component onClick handlers; zero dummy `onClick={() => {}}` or console-only no-ops remain. All buttons are fully wired to active React state modifiers or blockchain RPC methods.
