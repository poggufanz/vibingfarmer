# VIBING FARMER — Design System

> **Versi:** 3.2 (Vibing Farmer · multi-agent · Stellar) · **Tanggal:** 2026-07-11  
> **Tujuan:** Base design system buat VIBING FARMER + handoff ke implementasi React / Soroban.  
> **Aesthetic:** *Editorial financial-document* — restrained, data-forward, trust-first.  
> **Changelog 3.2:** Surface tiers (A shell / B marketing / C extension); accent budget max 2; Newsreader wordmark truth; Stellar vocabulary (no EVM fossils); page-type catalog; live-status motion family; semantic left-border exception; default locale EN.

---

## 0. Bacaan singkat

VIBING FARMER adalah produk DeFi multi-agent di **Stellar/Soroban**. Sebuah **Orchestrator** nge-spawn beberapa **Worker Agent**, masing-masing dengan **skill JSON** yang user review sebelum execution. User menandatangani **satu wallet signature** (`funding_router.grant` — budget + expiry); tiap worker pakai scoped `agent_account` + session key, deposit paralel ke autofarm vault (Blend yield) lewat **fee-bump relay**. Karena user nge-trust agent untuk move money, **design-nya harus serius secara visual** — bukan crypto-bro vibey, bukan generic AI-dashboard, tapi document-grade yang ngebuat user yakin batasan permission-nya dihormati.

---

## 1. Prinsip Desain

Setiap keputusan visual diuji terhadap lima prinsip ini. Kalau melanggar salah satu, redesign.

| Prinsip | Penjelasan | Cek |
|---|---|---|
| **Restraint over decoration** | Border + spacing + typography melakukan kerja. Gradient, glow, blur, dan animasi dekoratif dihindari. | Setiap efek harus jawab "ini ngomong apa ke user?" Kalau gak bisa jawab, hapus. |
| **One accent, one job** | Satu warna brand (acid lime), dipake hanya untuk current action / current state. Bukan untuk dekorasi. | **Accent budget hard:** max **2** moments per Tier-A screen (primary CTA **or** active step + optional one data emphasis). Never gradient-fill text, dual-hue accent→ok, or glow box-shadow. |
| **Data is the design** | Angka besar dengan tabular figures jadi visual anchor tiap screen. Bukan ilustrasi, bukan ikon raksasa. | Tiap screen harus punya 1 angka signature (amount, APY, progress, deposited). |
| **Motion has meaning** | Animasi cuma untuk state transition + real-time feedback. Tidak ada shimmer/pulse dekoratif. | Approved live-status family only (below). Always honor `prefers-reduced-motion`. |
| **Trust through transparency** | Permission scope, fee-bump / gas, tx hash, semua ditampilkan literal (Stellar G…/C…, not EVM abstractions). | Document-grade output — user bisa pause dan baca tiap field. |

### Surface tiers (v3.2)

| Tier | Surfaces | Decoration allowed |
|---|---|---|
| **A — App shell** | Strategy flow, grant, dashboard, rail, modals, settings forms | Full restraint: no decorative gradient/blur/glow |
| **B — Marketing / explorer** | Landing, Ecosystem, Explorer, Replay, public NavBar | 1 ambient grid **or** 1 radial vignette ≤3% opacity; nav glass `backdrop-blur ≤16px` with scrim ≥70% opaque; max 1 accent CTA glow on hover only |
| **C — Extension** | VF Wallet popup | Same as A (trust UI) |

### Live-status motion family (approved)

| Name | Max concurrent | Allowed when |
|---|---|---|
| `status-blink` | 1 per component | Single active op |
| `live-dot` | N static/status dots | Connected/running network (one **pulsing** dot per visual group max) |
| `progress-shimmer` | 1 track | Known in-flight work only |
| **Banned** | page-wide pulse glow, full-card skeleton sweep, accent box-shadow ring expand | — |

### Anti-patterns yang HARUS dihindari

- ❌ Emoji sebagai icon (🦊, ⚡, 🔒, dll) — pakai SVG / text mark
- ❌ Radial / linear gradient sebagai background atmosphere (**Tier A/C**; Tier B: 1 vignette max)
- ❌ Italic colored `<em>` accent di dalam headline
- ❌ Pulse / shimmer animation di luar live-status family
- ❌ Conic-gradient avatar / placeholder identicon
- ❌ Stepper wizard chrome (numbered circles connected by lines)
- ❌ Backdrop-blur "glass" effects (**Tier A/C**; Tier B nav only)
- ❌ Letter-spaced uppercase monospace di **semua** label (Tier A: never; Tier B kicker only, max 24 chars)
- ❌ Chip-with-dot status badge: max **one pulsing** dot per visual group; static dots OK
- ❌ Generic 2×2 vanity stat grid — prefer max 3-metric strip or document rows
- ❌ Card left-border **brand accent** — semantic status edge (`ok`/`warn`/`danger`, 1–2px) allowed on list rows only
- ❌ Font overused (Inter, Roboto, Fraunces, Arial)
- ❌ EVM fossils in product UI: EOA, ERC-7710/7715, 0x-as-primary, maxGas ETH, Sourcify as Stellar verification

---

## 2. Color Tokens

Color disimpan sebagai CSS custom properties di `:root`. Empat palette tersedia (default = Acid Yield), switching via `[data-palette="..."]` attribute di `<html>`.

### Token contract (semua palette HARUS define)

| Token | Peran |
|---|---|
| `--bg-base` | Outermost canvas — di antara kolom layout |
| `--bg-canvas` | Kolom utama (sidebar, main, rail) |
| `--bg-card` | Card content area |
| `--bg-elev` | Elevated surface (input, pop, exec-row) |
| `--bg-elev-2` | Selected state |
| `--bg-input` | Form input background (jarang dipake) |
| `--border` | Default 1px divider (≈ 6% opacity) |
| `--border-strong` | Stronger divider (≈ 13% opacity) |
| `--border-accent` | Accent-tinted border (focus, active) |
| `--text` | Primary text |
| `--text-muted` | Body / supporting text |
| `--text-faint` | Tertiary labels, annotations |
| `--accent` | Brand accent — current action only |
| `--accent-soft` | Accent low-opacity bg (8%) |
| `--accent-fg` | FG color on accent bg |
| `--info` `--warn` `--danger` `--ok` | Status semantics |

### Palette: Acid Yield (default)

```css
--bg-base:   #0e0f0c;   /* warm near-black */
--bg-canvas: #131410;
--bg-card:   #1a1b16;
--bg-elev:   #22231d;
--text:      #ecebe1;   /* warm cream */
--text-muted:#95958a;
--text-faint:#7a7a70;   /* ≥3:1 on base for 11px+ annotations (was #56564f) */
--accent:    #cfff3d;   /* acid lime — sparingly */
--accent-fg: #0e0f0c;
```

### Palette: Mono Slate

Most restrained — zero chroma di accent. Cocok kalau brand butuh feel lebih korporat. **Must define full token contract** (border, text-muted/faint, status colors).

```css
--bg-base:   #0c0d10;
--bg-card:   #161820;
--text:      #e8ebf3;
--text-muted:#9aa0b0;
--text-faint:#7a8090;
--accent:    #e6edff;   /* near-white, treats accent as "highlight" not "color" */
--border: rgba(255,255,255,0.07);
--border-strong: rgba(255,255,255,0.14);
```

### Palette: Liquid Mint

Teal undertone. Cocok kalau ingin DeFi/crypto vibe tanpa lime. **Full token contract required.**

```css
--bg-base:   #0a1310;
--bg-card:   #11201b;
--text:      #e4f0eb;
--text-muted:#8aa89c;
--text-faint:#6a8a7c;
--accent:    #5ee6c5;
```

### Palette: Bone Paper (light)

Light editorial mode — paper-feel untuk presentation atau printing.

```css
--bg-base:   #f4f1e9;
--bg-card:   #e3dfd2;
--text:      #1a180f;
--text-muted:#6a675c;
--text-faint:#6a675c;   /* was #95928a — raise to ≥3:1 */
--accent:    #1a180f;   /* accent = darkest text in light mode */
```

### Contrast targets (semua palette)

- Primary text vs background: **≥ 7:1** (AAA)
- Muted text vs background: **≥ 4.5:1** (AA)
- Faint text vs background: **≥ 3:1** (AA large only — pakai cuma untuk 11px+ annotations)
- Accent vs accent-fg: **≥ 7:1**

### Aturan pakai accent

1. **Tidak pernah** dipake sebagai bg dekoratif (no accent-tinted card)
2. Dipake hanya untuk:
   - Current step indicator (step rail underline + number color)
   - Active state marker (exec-row marker, permission status dot, focus-within border)
   - Primary CTA button background
   - Critical inline emphasis (max amount value, signed authorization status)
3. **Accent budget (hard):** max **2** accent moments per Tier-A screen (v3.2). Marketing Tier-B: max 1 primary CTA.

---

## 3. Typography

Tiga font, masing-masing punya peran spesifik. **Tidak ada italic colored accent dalam headline.** Hierarchy lewat scale & weight, bukan color.

### Font stacks

```css
--font-display: "Geist", "Söhne", system-ui, sans-serif;
--font-body:    "Geist", system-ui, sans-serif;
--font-mono:    "JetBrains Mono", "Geist Mono", ui-monospace, monospace;
--font-script:  "Newsreader", "Times New Roman", serif; /* brand wordmark only */
```

### Pemakaian

| Font | Pakai untuk | Tidak pakai untuk |
|---|---|---|
| **Geist** | Headlines, body, button labels, vault names | Numbers (pakai mono), brand "vibing" wordmark |
| **JetBrains Mono** | Numbers, addresses, tx hashes, code, technical labels (eyebrow), permission scope keys | Headlines, body prose |
| **Newsreader (italic)** | **Satu** kegunaan: brand wordmark **"vibing"** (not "farmer") di topbar/nav | Headlines, accents, decoration |

### Scale

| Token | Size | Pakai untuk |
|---|---|---|
| `.figure-lg` | `clamp(48px, 8vw, 96px)` | Hero signature number (jarang — landing only) |
| `.figure-md` | `clamp(36px, 5.2vw, 64px)` | Per-screen signature (APY, progress count) |
| `.figure-sm` | `clamp(28px, 3.6vw, 36px)` | Secondary big number |
| `.amount-input` | `clamp(40px, 7.2vw, 72px)` | Amount input (special — fluid font for narrow viewport) |
| `.h-display` | 38px desktop / 32px compact | Per-card headline (no italic accents) |
| `.h-sub` | 22px | Section sub-heading |
| `.rec-vault-name` | 28px | Editorial product name (vault title) |
| Body | 14px | Default prose |
| `.lede` | 15px | Subheading prose (after `.h-display`) |
| Body small | 13px | Right-rail content |
| Eyebrow / annotation | 11–12px | Always mono |

### Aturan headline

- **No italic accents.** Hierarchy via scale & weight. Bukan via colored `<em>`.
- `text-wrap: balance` untuk h-display
- `text-wrap: pretty` untuk lede paragraphs
- `letter-spacing: -0.02em` to `-0.03em` untuk display weights
- `letter-spacing: -0.01em` untuk semua mono (mono looks too wide otherwise)
- Max line length: ≈ 580px (≈ 65ch)

### Tabular numbers

Setiap angka yang ditampilkan sebagai data WAJIB tabular:

```css
font-variant-numeric: tabular-nums;
font-feature-settings: "tnum" 1, "lnum" 1;
```

Gunakan class `.tnum` atau apply via `.figure`, `.balance-cell .val`, `.exec-progress .value`, `.amount-input-row input`.

### Eyebrow lockup pattern

Setiap card mulai dengan satu lockup ini — substitute untuk wizard-stepper chrome:

```html
<div class="eyebrow">
  <span class="num">01</span>
  <span>Preferensi · venice ai</span>
  <span class="rule"></span>
  <span>05 langkah</span>
</div>
```

Selalu: `[step-number] · [section-name] —— [meta-right]`. Mono, 11px, lowercase, accent color hanya pada step number.

---

## 4. Spacing, Radius, Borders

### Spacing scale

Pakai kelipatan 4 (4 / 8 / 12 / 14 / 16 / 18 / 22 / 24 / 28 / 32 / 36 / 56).

| Konteks | Spacing |
|---|---|
| Tight gap dalam komponen | 4–8px |
| Form field internal | 14px (padding-bottom on input rows) |
| Section dalam card | 18–22px |
| Major divider antar group | 28–36px |
| Card padding | 36px (24px compact) |
| Topbar/sidebar padding | 14–28px |
| Stage padding | 28px (18px compact) |

### Border radius

Kecil dan crisp. Tidak ada radius di atas 18px.

```css
--radius-sm: 4px;   /* icon buttons, tags, small chips */
--radius-md: 8px;   /* buttons, form rows, mm-pop */
--radius-lg: 14px;  /* cards */
--radius-xl: 18px;  /* modal */
```

`[data-density="compact"]` ngurangi semua ke 6 / 10 / 14px.

### Border

- **Default:** `1px solid var(--border)` — ≈ 6% opacity white (atau 8% dark on light)
- **Strong:** `1px solid var(--border-strong)` — ≈ 13% opacity
- **Accent:** `1px solid var(--border-accent)` — used only on focus-within
- Tidak ada border 2px+, tidak ada dashed border kecuali untuk `tx hash` underline
- **Document-pattern divider:** stack rows pakai `border-bottom: 1px solid var(--border)` di tiap row, bukan card-per-row

---

## 5. Layout

### App shell — 3 kolom

```
┌────┬──────────────────────┬──────────────┐
│ SB │       MAIN           │     RAIL     │
│ 58 │   minmax(0, 1fr)     │     360      │
└────┴──────────────────────┴──────────────┘
```

- **Sidebar (58px):** icon-only nav, no labels (icons cuma untuk top-level), no active highlight bar — cuma background tint
- **Main (1fr):** topbar + step rail + stage (scrollable)
- **Rail (360px):** persistent wallet + permission + activity panels, scrollable

Grid template-columns **harus** `minmax(0, 1fr)`, **bukan** `1fr`, untuk mencegah child overflow.

### Stage pattern

```
┌────────────────────────────────┐
│  topbar                        │
├────────────────────────────────┤
│  step-rail (subtle underline)  │
├────────────────────────────────┤
│  ┌──────────────────────────┐  │
│  │       card (signature)   │  │
│  │                          │  │
│  └──────────────────────────┘  │
│           (scrollable)         │
└────────────────────────────────┘
```

Satu card per stage. Card adalah satu-satunya container yang punya bg-card, semua nested element di-divide pakai border.

### Card internal structure

```
┌────────────────────────────────┐
│  eyebrow (01 · section ── meta)│
│                                │
│  h-display headline            │
│  lede paragraph                │
│                                │
│  [content — data block]        │
│                                │
│  ─────────────────────────── ←  divider
│  foot-note · primary CTA       │
└────────────────────────────────┘
```

Action row selalu di-divide dari content via `border-top: 1px solid var(--border)`.

### Step rail (6 langkah · Vibing Farmer)

Numeric, subtle, underline-on-active. Bukan circle-with-line wizard.

```
┌────────────────────────────────────────────────────────────────────────┐
│ 01 AI Strategy  02 Connect & Upgrade  03 Review Skills  04 Grant       │
│ ─────                                                                  │
│ 05 Auto-Execute  06 Complete                                           │
└────────────────────────────────────────────────────────────────────────┘
```

| # | Stage id | Label | Yang terjadi di stage |
|---|---|---|---|
| 01 | `strategy` | AI Strategy | Input + thinking + orchestrator-generated multi-agent strategy |
| 02 | `connect` | Connect | Stellar wallet (Freighter / xBull / Albedo) — no EOA upgrade |
| 03 | `skills` | Review Skills | User reviews/edits skill JSON per worker agent |
| 04 | `permission` | Single-signature grant | `funding_router.grant` — budget + expiry, deploys N agents |
| 05 | `execute` | Auto-Execute | Agent Graph live · parallel workers · fee-bump relay · Memory |
| 06 | `done` | Complete | Multi-agent deployment summary |


- 14px vertical padding per item
- 18px horizontal padding per item
- Active: text color = `--text`, num color = `--accent`, underline 1px accent at bottom
- Done: text + num color = `--text-muted`, no underline
- Idle: text + num color = `--text-faint`

---

## 6. Components

### Buttons

| Variant | Class | Pakai untuk |
|---|---|---|
| Primary | `.btn .btn-primary` | Satu per screen — primary CTA |
| Ghost | `.btn .btn-ghost` | Secondary action |
| Text | `.btn .btn-text` | Tertiary / dismissive |

Sizes: default `padding: 11px 18px`, large `padding: 14px 22px`. Radius `--radius-md` (8px). Font weight 500.

**Hover / focus (v3.2 base):** animated accent gradient flow + light sheen sweep — interaction feedback only (not ambient page decoration). Primary uses full accent gradient; ghost uses soft elev/accent wash; text stays color-only. Soft accent ring on hover is allowed; no infinite glow pulse. Honor `prefers-reduced-motion` (static highlight, no flow animation).

### Amount input (signature pattern)

Pattern khusus VIBING FARMER — input numerik dengan font raksasa sebagai visual anchor:

```html
<div class="amount-input-row">
  <input type="number" placeholder="0" />
  <span class="ticker">USDC</span>
</div>
```

- Font: mono, tabular, `clamp(40px, 7.2vw, 72px)`
- Border: cuma bottom — `1px solid var(--border-strong)`, jadi accent ketika focus-within
- Ticker label: 18px mono, baseline-aligned

### Risk row (segmented)

Three options inline, bukan stacked vertical:

```
┌──────┬──────┬──────┐
│ Low  │ Med  │ High │
│ sub  │ sub  │ sub  │
└──────┴──────┴──────┘
```

Inner border, no rounded corners di item, parent radius `--radius-md`. Selected = `bg-elev-2`, label sub jadi accent color.

### MetaMask pseudo-dialog (`.mm-pop`)

Document-grade dev-tool feel. Tidak ada fox emoji.

```
┌─────────────────────────────────────────┐
│ [MM] MetaMask         vibing-farmer.app │ ← header
│ ──────────────────────────────────────  │
│ title…                                  │
│ key       value                         │
│ key       value                         │
│ ...                                     │
└─────────────────────────────────────────┘
```

- `MM` mark = 22×22 box dengan border, mono 9px text
- Key column: 100px fixed, `var(--text-faint)`
- Value column: 1fr, `var(--text)`
- `.v.accent` untuk highlight (max amount, status, dll)

### Permission scope doc (`.perm-doc`)

Treats permission seperti dokumen formal. Setiap row = `key: value · annotation`.

```
┌───────────────────────────────────────────────┐
│ action.type      vault-deposit · swap → ...   │
│ allowed.vault    0xABCD...aBcDe · single-...  │
│ max.amount       100 USDC · hard cap · exc... │
│ expires.at       26 Mei 2026, 14:30           │
│ revocable        yes · kapanpun · onchain     │
└───────────────────────────────────────────────┘
```

- Key: mono 11px, left column 180px
- Value: mono 13px, `var(--text)`
- Annotation: mono 11px, `var(--text-faint)`, gap 10px dari value
- Accent value: `.accent` class — dipake **cuma** untuk max.amount

### Execution log (terminal-style)

Bukan stepper dengan icon raksasa. Cuma marker dot + title + tx + status.

```
┌────────────────────────────────────────────────┐
│ ● Swap via DEX               step 01  confirmed│
│   USDC → USDC pool · 0.05%   tx · 0x9f3…a124 ↗ │
├────────────────────────────────────────────────┤
│ ◐ Approve vault spender      step 02  pending  │
│   ERC-20 approve · MockVault · broadcasting     │
├────────────────────────────────────────────────┤
│ ○ Deposit ke MockVault       step 03  queued   │
│   ERC-4626 deposit · mint shares                │
└────────────────────────────────────────────────┘
```

- Marker = 14px circle dengan border
- Active marker: inner 5px accent dot dengan `blink` animation (1.1s ease-in-out infinite) — satu-satunya animasi yang acceptable karena nge-convey "active operation"
- Done marker: fill solid accent
- Tx hash: `border-bottom: 1px dashed var(--text-faint)`, hover → accent

### Right rail panels

Tidak punya card chrome. Cuma `border-bottom` antar panel + 20px padding. Headline `.panel-title` 13px Geist + `.panel-meta` 10.5px mono di kanan.

### Modal

Kept minimal — `bg-card`, `border-strong`, `radius-lg`, padding 28px. Slide-up entrance 18ms. **Tidak ada backdrop-blur** — pakai `rgba(0, 0, 0, 0.6)` solid scrim.

---

## 7. Motion

### Aturan dasar

- Duration: **150–300ms** untuk micro-interactions (transition, button hover)
- Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` untuk entrance (sharp settle)
- Exit faster than enter (180ms vs 320ms)
- **Tidak ada infinite decorative loops** — kecuali `blink` di execution active marker (1.1s) karena nge-convey real ongoing operation
- Respect `prefers-reduced-motion: reduce` — semua entrance animation di-disable

### Approved animations

| Animasi | Durasi | Trigger |
|---|---|---|
| `enter` (translateY 8px + fade) | 320ms ease-out | New card mount (stage change) |
| `slideup` (modal) | 180ms ease-out | Modal open |
| `fadein` (modal backdrop) | 140ms ease-out | Modal open |
| `blink` (exec marker) | 1.1s ease-in-out infinite | Active execution step |
| Hover state transitions | 120ms ease | Buttons, icon-btns, panels |
| Progress bar fill | 600ms cubic-bezier | Exec progress update |

### Banned animations

- Shimmer / loading skeleton sweep
- Pulse glow (decorative)
- Rotation / spin (kecuali untuk genuine spinner, dan kita gak pake spinner)
- Page-scale entrance gymnastics
- Scroll-driven parallax decoration

---

## 8. Iconography

### Source

Custom inline SVG, **stroke 1.5px**, Lucide-style proportions. Disimpan dalam `Icon` component.

### Aturan

- **Tidak ada emoji** — pernah, untuk apapun
- Stroke width seragam (1.5px) — tidak ada mix dengan 1px atau 2px di hierarchy yang sama
- Outline-only — tidak ada filled icon kecuali untuk "checkmark" pattern di marker
- 14–18px default size (16px paling umum)
- Color = `currentColor` — di-control via parent text color, bukan via SVG fill

### Active icon set

`home`, `grid`, `layers`, `settings`, `bell`, `refresh`, `plus`, `arrow`, `check`, `x`, `copy`, `external`, `logout`, `chev`, `chevDown`

Tambah icon baru hanya kalau truly dibutuhkan — kebanyakan UI element bisa pakai text label.

### Brand marks

- **Sidebar logo:** `v/` — mono 14px, di dalam 32×32 box dengan border. Bukan filled tile, bukan colored gradient.
- **Wallet mark:** mono monogram (e.g. `FW` Freighter / `VF` VF Wallet) — 9px, 22×22 box. No fox emoji.
- **Brand wordmark:** `vibing/farmer` — **Newsreader italic** on **"vibing"**, `--text-faint` slash (never accent), **mono** on **"farmer"**. *Serif italic only on `.vibe` / wordmark "vibing".*

---

## 9. Per-Screen Signatures

Tiap screen harus punya **satu angka besar** (atau document-grade skill set) sebagai visual anchor.

### Page-type catalog (v3.2)

| Type | Layout | Signature | Accent budget |
|---|---|---|---|
| Wizard stage | 3-col + single card | §9 table below | 2 |
| App dashboard (Home) | main + optional rail | 1 hero balance/APY | 2 |
| Document (Grant/perm) | perm-doc rows | max amount | 2 |
| Marketing (Landing/Eco) | full-bleed, Tier B deco | optional figure | 1 CTA |
| Data explorer | table + ≤3-metric strip | primary KPI mono | 1 |
| Modal | existing | none required | 1 CTA |

| Screen | Signature number | Source data |
|---|---|---|
| 01a Input | Amount input (`clamp(40px, 7.2vw, 72px)`) | User-typed amount |
| 01b Strategy | Blended APY (`figure-md`) | Weighted across agents |
| 02 Connect | — (transitional; eyebrow + lede do the work) | — |
| 03 Skills | — (the **skill cards** are the anchor — JSON itself is the data) | N skill JSONs |
| 04 Permission / Grant | Total max amount (accent, one place) | User's total budget |
| 05 Execute | `done/total` + agent graph | Real-time |
| 06 Success | 1 hero figure + meta rows (not vanity 2×2) | Final state |
| Home dashboard | Portfolio USDC or live APY | Positions |
| Landing | Optional one figure or “1 signature” | Product claim |

---

## 10. Content & Copy

### Bahasa

- **Default locale: English** (product UI). Optional `id` via settings when i18n keys exist.
- Tone (both): sentence case, direct; technical terms literal (`funding_router`, fee-bump, session key).
- Eyebrow/meta: English-lowercase (locale-invariant).
- Sentence case untuk headlines — bukan title case
- Mono labels = lowercase — *kecuali* tx hash, address, dan kode (case sensitive)
- Annotation pattern: `keyword · context · constraint` (titik dot sebagai separator)

### Tone

| Konteks | Tone |
|---|---|
| Headlines | Direct, conversational ("Set deposit kamu", "Izinkan agent — tapi cuma sebatas yang ini") |
| Lede prose | Explainer, no jargon dump (tapi technical term DI-tulis literal: "session key", "fee-bump", "funding_router") |
| Foot note | Reassurance + technical fact ("Agent **tidak punya akses** ke saldo wallet di luar scope ini.") |
| Eyebrow | Telegraphic — `nn · section · meta` |
| Activity log | Event-name first (mono, structured), then meta (mono) — see §10b |

### 10b. Activity event vocabulary (agent-level)

Activity feed gak nge-mix narrative + technical lagi — sekarang **event-name first**, structured. Tiap entry: `[marker] [EventName] [agent-id?] [meta]`.

| Event | Marker | Color | Meta example |
|---|---|---|---|
| `OrchestratorPlanned` | `·` | muted | `3 worker spawned · 11.8% blended apy` |
| `Connected` | `·` | muted | `0xA36f3c…26a4` |
| `Authorized` | `·` | muted | `eip-7702 · tx 0x9f3…a124` |
| `SkillApproved` | `·` | muted | `skill JSON approved · ready to bind` |
| `PermissionGranted` | `·` | muted | `vault 0xABCD…aBcDe · 50 usdc max` |
| `PermissionRevoked` | `·` | danger | `agent halted · scope cleared` |
| `AgentStarted` | `●` | warn (amber) | `aave-v3 · 50 usdc` |
| `SwapExecuted` | `↻` | info | `tx 0x9f3…a124` |
| `ApproveExecuted` | `✓` | info | `tx 0x9f3…a124` |
| `DepositExecuted` | `↓` | info | `tx 0x9f3…a124` |
| `AgentCompleted` | `✓` | ok (green) | `50 usdc → MockVault USDC` |
| `AgentFailed` | `✕` | danger | `swap reverted · slippage exceeded` |

- Marker char is mono, colored via `EVENT_STYLES` map in `app.jsx`.
- `agent` id (e.g. `worker-1`) rendered as 1px-bordered chip after event name.
- Newest at top; auto-scroll disabled (don't fight the user).

### Number formatting

- USD/USDC: tanpa currency symbol di front (pakai unit di belakang: `100 USDC`)
- Percentages: 1 decimal max (`8.2%`)
- Tx hash: short form `6…4` (Stellar or hex — no required `0x` prefix)
- Address: Stellar `G…`/`C…` short **4…4** (lists); full form in permission/receipt docs
- Fee display: `0 XLM · fee-bump sponsored` (not `0 ETH`)
- Timestamp: locale-aware from settings (`en-US` default)
- Duration: `86 400s` (with thin-space thousand separator dalam mono context)

---

## 11. Tweakable Surface

User bisa swap via panel:

| Tweak | Options | Effect |
|---|---|---|
| Brand palette | Acid Yield · Mono Slate · Liquid Mint · Bone Paper | `[data-palette]` attribute → swap accent + bg tokens |
| Demo speed | Fast · Med · Slow | Multiplier untuk timeout (220 / 600 / 1100 ms base) |
| Density | Comfortable · Compact | `[data-density]` attribute → smaller padding + radii |
| Jump to step | 6 buttons | Stage transition (untuk review tiap screen) |

Tweaks persisted via host protocol di `EDITMODE-BEGIN`/`EDITMODE-END` block — JSON dengan keys `palette`, `density`, `speed`.

---

## 12. Implementation Notes

### File structure (canonical — v3.2)

```
frontend/index.html           — fonts (Geist, JetBrains Mono, Newsreader)
frontend/style.css            — tokens + app components
frontend/src/app.jsx          — shell + stage machine
frontend/src/components/*     — Home, Landing, Explorer, Ecosystem, Replay, Settings, …
frontend/src/agents.jsx       — AgentGraph (react-force-graph-2d), tiles, memory
frontend/src/skills.jsx       — skill review cards (Stellar pull/deposit scope)
frontend/src/screens.jsx      — deposit flow stages
frontend/src/tweaks-panel.jsx — design tweaks (dev)
frontend/extension/popup.jsx  — VF Wallet (Tier C)
design/                       — historical prototype only (non-canonical)
```

### React patterns

- Vite + React (build via `frontend/npm run build`)
- Graph: `react-force-graph-2d` in `agents.jsx` (not vis-network)
- State machine (in `app.jsx`):
  - `stage`: `strategy` | `connect` | `skills` | `permission` | `execute` | `done`
  - `strategyPhase`: `input` | `thinking` | `ready` (sub-state of stage=strategy)
  - `thinkingPhase`: 0-2 — progress in checklist
  - `strategy`: `{ agents, total, blendedApy, risk }` — generated by strategist
  - `connectPhase`: `idle` | `connecting` | `connected` | …
  - `skillStates`: `{ [agentId]: { state: 'pending'|'editing'|'approved', skill } }`
  - `editingTexts`: `{ [agentId]: { text, error } }`
  - `permPhase`: `idle` | `prompting`
  - `permActive`: boolean
  - `execMap`: `{ [agentId]: { status, activeStep, steps: {swap,approve,deposit}, hashes, memory[], metrics } }`
  - `openAgentId`: which agent's Memory Modal is open (null = closed)
  - `logs`: structured event entries `{ id, time, event, agent?, meta }`
- All animations timer-based via `setTimeout(..., speed * multiplier)` — speed comes from tweaks
- Agent execution staggered by `idx * speed * 0.6` so the graph reads sequentially even though workers run in parallel

### Naming conventions

- BEM-ish flat classes (`.exec-row`, `.exec-marker`, `.exec-title`) — no deeply nested
- Variant via modifier class (`.exec-row.done`, `.exec-row.active`, `.exec-row.idle`)
- Utility class minimum (`.flex`, `.gap-3`, `.tnum`, `.muted`, `.faint`, `.mono`)

### Accessibility floor (must-have)

- All interactive elements `≥ 32×32px` hit target (icon-btn = 30px borderline OK at desktop; bump to 44px for mobile)
- `aria-label` on icon-only buttons
- `role="radiogroup"` on risk-row, `aria-checked` per option
- `role="progressbar"` + `aria-valuenow`/`aria-valuemax` on step rail
- `role="dialog"` + `aria-modal="true"` on MetaMask permission modal
- Focus-visible ring via native browser (no `outline: none` override)
- Color contrast verified untuk semua palette (Acid Yield + Mono Slate + Bone Paper minimum)

---

## 13. Extending the System

Kalau perlu screen / komponen baru, ikuti urutan ini:

1. **Identify signature data point** — apa angka besar yang anchor screen ini?
2. **Pick the layout pattern** — card with eyebrow + headline + content + action-row? Atau lebih ke document-doc style (perm-doc)? Atau log-style (exec-log)?
3. **Reuse existing tokens** — jangan invent warna baru, jangan invent radius baru
4. **Mono untuk data, Geist untuk prose** — strict
5. **One accent moment** — di mana accent muncul di screen ini? Itu satu, dan dia jelas
6. **Run through anti-pattern list di §1** — sebelum commit, cek ulang

Kalau bingung apakah suatu treatment qualify atau "AI-slop": tanya "apakah ini bantuin user nge-trust permission scope mereka, atau ini cuma making it look 'designed'?" Kalau yang kedua — drop.

---

## 14. Reference Files

| File | Status |
|---|---|
| `Vibing Farmer Prototype.html` | Current (v3 · Vibing Farmer) — base reference |
| `Vibing Farmer Prototype v1.html` | Original — kept for compare (AI-slop baseline) |
| `styles-v1.css`, `src/components-v1.jsx`, `src/screens-v1.jsx` | v1 snapshot |
| `styles.css`, `src/{app,components,screens,skills,agents,tweaks-panel}.jsx` | v3 active design system |

---

## 16. Vibing Farmer — multi-agent architecture

VIBING FARMER v3 ngubah arsitektur dari "satu user, satu agent, satu vault" jadi **orchestrator + N workers**. Design system reflects this lewat tiga komponen baru: **Strategy Card** (replaces RecommendCard), **Skill Review** (new step), **Agent Graph** (replaces flat exec log).

### Hierarki

```
Orchestrator (1)
    │
    ├──► Worker Agent 01 ──► Swap → Approve → Deposit ──► Vault A
    ├──► Worker Agent 02 ──► Swap → Approve → Deposit ──► Vault B
    └──► Worker Agent 03 ──► Swap → Approve → Deposit ──► Vault C
```

### Risk profile → jumlah agent

| Risk profile | # agents | Allocation split | Total skill JSON to review |
|---|---|---|---|
| **Low** | 1 | `[100%]` | 1 |
| **Medium** | 2 | `[60%, 40%]` | 2 |
| **High** | 3 | `[40%, 35%, 25%]` | 3 |

Allocation di-derive di `buildStrategy(amount, risk)` di `agents.jsx`. AGENT_PROTOCOLS array ngandung pool data per-agent (vault address, protocol, APY, drawdown).

### State model — `execMap`

Per-agent execution state shape:
```js
{
  status: 'idle' | 'running' | 'confirmed' | 'failed',
  activeStep: 'swap' | 'approve' | 'deposit' | null,
  steps: { swap: '...', approve: '...', deposit: '...' },  // same enum
  hashes: { [stepId]: '0x...' },
  memory: [{ status, title, meta, hash?, lesson?, t }],
  metrics: { totalRuns, successRate, startedAt, completedAt }
}
```

Orchestrator state di-derived dari aggregate worker states (`computeOrchestratorState`) — bukan separate state. Aturannya: any-failed → failed; all-confirmed → confirmed; any-running → running; else idle.

---

## 17. Agent Graph (vis.js Network)

Hierarchical force-disabled graph yang nge-visualisasikan orchestrator → workers → steps → vaults sebagai live execution view.

### Library

`vis-network@9.1.9` (UMD CDN). Static — physics disabled, drag-view disabled, zoom-view disabled. Tujuannya bukan free exploration; tujuannya **trustworthy status display**.

### Layout config

```js
layout: {
  hierarchical: {
    direction: 'UD',
    sortMethod: 'directed',
    levelSeparation: 110,
    nodeSpacing: 130,
    treeSpacing: 60,
    parentCentralization: true,
  }
},
physics: { enabled: false },
```

### Node levels & shapes

| Level | Group | Shape | Label format |
|---|---|---|---|
| 0 | `orchestrator` | box | `Orchestrator` (bold) |
| 1 | `worker` | box | `Worker N · Role\n50 USDC` |
| 2 | `step` | box | `Swap` / `Approve` / `Deposit` |
| 3 | `vault` | box | `MockVault USDC\naave-v3` |

Border-radius 4px (`shapeProperties.borderRadius`). Mono 11px label. Edges = thin cubicBezier with small arrow.

### Color mapping (`NODE_COLOR`)

Status colors **don't use brand accent** — they use the semantic palette tokens (info/warn/danger/ok). Brand accent stays reserved for "current user action" (CTAs, current step rail underline) per §1.

| State | bg | border | font (dark palette) |
|---|---|---|---|
| `idle` | `#22231d` | `#56564f` | `#95958a` |
| `running` | `#3a2d12` (amber-tinted dark) | `#f0b54a` (warn) | `#ecebe1` |
| `confirmed` | `#1a3322` (green-tinted dark) | `#6fe39a` (ok) | `#ecebe1` |
| `failed` | `#3a1a1c` (red-tinted dark) | `#ff7479` (danger) | `#ecebe1` |

Light palette (`bone-paper`) uses `NODE_COLOR_LIGHT` — separate map to maintain contrast.

### "Pulsing" amber for running

Single `setInterval(550ms)` di `AgentGraph` toggles `borderWidth` between 2 and 3 on running nodes only. This is the ONE place in v3 where we have a live decorative-feeling animation — but it expresses real ongoing operation (per §7 motion rules, this qualifies). Cleared on unmount.

### Click → Memory Modal

`network.on('click', ...)` — if clicked node id matches a worker agent id, call `onAgentClick(id)`. Step/vault/orchestrator clicks are ignored. Legend at the bottom hints `"click any agent node → open memory"`.

### Vault node state derivation

Vault node mirrors its agent's `steps.deposit` state — it only flips to confirmed when the deposit step confirms (because that's the moment the vault actually receives funds).

---

## 18. Skill Review (step 03)

Sebelum permission granted, user lihat skill JSON yang Orchestrator auto-generate per worker. User bisa review, edit JSON, atau approve apa adanya. **All skills harus approved sebelum bisa lanjut ke step 04.**

### Skill JSON schema

Generated by `buildSkillForAgent(agent, riskProfile)`:

```json
{
  "name": "yield_vault_deposit",
  "version": "1.2.0",
  "agent": "worker-1",
  "description": "Conservative · lending · single-vault deposit via scoped agent_account",
  "target": {
    "vault": "CB5VKYDU…JDYU",
    "protocol": "blend-autofarm",
    "chain": "stellar-testnet"
  },
  "steps": [
    { "id": "pull",    "action": "router_pull",   "params": { "amount": "exact" } },
    { "id": "deposit", "action": "vault_deposit", "params": { "asset": "USDC", "shares": "auto" } }
  ],
  "guards": {
    "maxAmount": "50 USDC",
    "maxGas": "200000",
    "expiresIn": "86400s",
    "revocable": true,
    "riskProfile": "med"
  }
}
```

### Skill card states

| State | Visual | Actions available |
|---|---|---|
| `pending` | Default border | `edit JSON`, `approve` |
| `editing` | Accent border | `cancel`, `save edits` (disabled if JSON invalid) |
| `approved` | OK-green border, status chip | `re-open` |

### Editor

`<textarea>` styled as code editor (`var(--font-mono)`, 11.5px, tabular nums, line-height 1.55). **No syntax-highlighting** — anti-pattern per §1 (decoration without function); raw text is more honest about what's being signed. JSON parse error displayed in red as `.skill-json-err` strip below the textarea.

### Batch action

`Approve all` ghost button — only shown when at least one skill is not yet approved. Primary CTA (`Lanjut · grant permission`) disabled until **all** skills approved.

### Foot note

"Skill di-sign sama smart account kamu. Edit JSON dengan hati-hati — schema validation jalan tiap save."

---

## 19. Memory Panel (per-agent modal)

Click an agent node in the Agent Graph (or an agent tile below) to open the Memory Modal — per-agent execution history dengan metrics + log + lessons.

### Layout

```
┌─────────────────────────────────────────┐
│  agent.memory · worker-1            [×] │  ← head
│  Worker 1 · Conservative                │
│  running · live execution               │
├─────────────────────────────────────────┤
│  runs   success  gas       vault apy    │  ← metrics (4 cells, divided)
│  1      —        0 ETH    8.2%          │
├─────────────────────────────────────────┤
│  execution log                          │
│  ● running   agent started              │
│  ● running   swap → broadcasting        │
│  ● confirmed swap confirmed   tx 0x...  │
│              lesson · slippage ok       │
│  ● confirmed approve confirmed          │
│  ...                                    │
├─────────────────────────────────────────┤
│  Memory stored onchain ...  [Close]     │
└─────────────────────────────────────────┘
```

### Sections

1. **Head** — `agent.memory · <id>` (mono eyebrow) + agent name (modal-title) + status sublabel
2. **Metrics** — 4-cell grid: runs, success rate, gas paid (user), vault APY. Border-divided, mono labels, tabular nums.
3. **Section title** — "execution log" (mono, lowercase)
4. **Log** — vertical list of memory rows
5. **Foot** — note + Close button

### Memory row structure

```
●  swap → usdc (slippage 0.05%)   [confirmed]
   broadcasting via 1Shot · tx 0x9f3…a124
   ╎ lesson · slippage within bounds — pool depth ok
                                              02:14:38
```

- **Marker dot** — color-coded (idle/running/confirmed/failed), pulsing if running (`legend-pulse` 1.1s)
- **Title** — Geist 13px medium + status tag chip (mono 10px)
- **Meta** — mono 11.5px muted, includes tx hash with dashed underline if present
- **Lesson** — optional, indented with left-border `var(--accent)`, mono 11.5px, `<key> lesson</key> <text>` pattern. Lessons di-derive dari STEP_FLOW config (per-step), e.g.:
  - swap: `"slippage within bounds — pool depth ok"`
  - approve: `"approval cached on smart account · reuse next run"`
  - deposit: `"share price 1.0241 · vault healthy"`
- **Time** — `HH:MM:SS` tabular

### When the modal is open

- Backdrop = solid `rgba(0, 0, 0, 0.6)` (no glass)
- ESC / click-outside / Close button = dismiss (handled via `onClick` on backdrop)
- Memory continues to update in real time even while modal is open (execMap updates flow through)

---

## 20. Right rail — multi-agent updates

### Permission panel

Switched from single-permission display to **multi-agent list**:

```
Active permissions             funding_router · SEP-41
● 3 permission · 23h 59m
─────────────────────────────────────────
01  worker-1                   40 USDC
    0xABCD…aBcDe
─────────────────────────────────────────
02  worker-2                   35 USDC
    0xDEF1…Ef12
─────────────────────────────────────────
03  worker-3                   25 USDC
    0x9876…1234
─────────────────────────────────────────
[ revoke all permissions ]
```

- Each agent row: idx (mono, accent) + name + truncated vault + amount (mono, tabular)
- `revoke all permissions` button — single action, halts all agents

### Activity panel

Now event-first (see §10b). `EVENT_STYLES` map controls marker char + color per event type. Agent ID rendered as small bordered chip after event name.

---

## 15. Open Questions / Future

Hal-hal yang belum di-resolve dan bisa di-iterate:

- **Mobile breakpoint** — saat ini design desktop-first 1024px+. Mobile butuh full rethink: sidebar jadi bottom-bar? Right rail jadi bottom-sheet? Belum di-design.
- **Empty states** — kalau user gak punya history, kalau Venice AI timeout, kalau 1Shot down. Belum punya treatment.
- **Error states** — permission revert toast, AI fail toast. Belum di-design.
- **Multi-vault dashboard** — kalau user punya >1 active position, gimana display. Belum di-scope.
- **Settings screen** — gear icon di sidebar belum punya tujuan.
- **Notifications panel** — bell icon di sidebar bottom belum punya tujuan.
- **Loading skeleton** — banned shimmer, tapi butuh pattern lain untuk genuine loading >300ms. Saat ini cuma pakai `blink` pada marker — mungkin perlu eksplor "step list dengan progressive reveal" sebagai genuine alternative.

Semua ini buat iterasi berikutnya. Base sudah cukup buat handoff implementasi.
