# Awwwards-Style Design + AI Agent yang Pinter Desain

*Generated: 2026-07-11 | Sources: ~25+ (web + X) | Confidence: **High** untuk pola desain; **Medium–High** untuk praktik AI agent (field cepat berubah)*

## Executive Summary

Desain “Awwwards-style” **bukan** sekadar animasi mewah. Yang menang SOTD biasanya menggabungkan: **art direction yang kuat**, **tipografi berani**, **motion yang punya tujuan**, **performa/UX**, dan **cerita merek**—bukan efek demi efek.

Di X (2025–2026), konsensus praktisi sama: animasi di fondasi jelek = murahan; foundation dulu (hierarchy, type, spacing), baru motion.

Untuk AI agent: output jelek hampir selalu karena **AI tebak-tebak** (generic layout, warna acak, type lemah). Yang bikin “pintar” adalah **design system dulu** (`DESIGN.md` / tokens / anti-pattern), **arah kreatif eksplisit**, **referensi visual**, lalu **loop review** (bukan one-shot prompt).

---

## 1. Apa yang dinilai “Awwwards-worthy”?

### 1.1 Kriteria formal (platform)

Awwwards menilai roughly lewat:

| Sumbu | Artinya |
|--------|---------|
| **Design** | Estetika, identitas, keberanian visual |
| **UX** | Navigasi nyaman, alur jelas |
| **Technique** | Smooth, cepat, clean code |
| **Content** | Storytelling yang memikat |

SOTD = skor harian tertinggi; SOTM/SOTY lebih ketat (jury + community vote). Honorable Mention biasanya dari ~6.5+.

### 1.2 Checklist “DNA” situs juara (dari analisis SOTY/SOTD)

Dari review praktis situs award-winning:

1. **Design principles dulu** — hierarchy, spacing; boleh break rules *sengaja* (layout aneh, skala berlebih)
2. **Huge typography** — type sebagai hero, bukan body copy kecil
3. **Page transitions, loaders, staggered motion**
4. **Animasi kreatif** (bukan library default)
5. **Imagery/illustration unik**
6. **Cursor / hover interaction**
7. **Parallax + smooth scroll**
8. **3D / shaders / AR-VR** (kalau relevan)
9. **Randomness / variation** — reload/interaksi terasa hidup

**Catatan penting:** item di atas **bukan resep wajib**. Tanpa **storytelling + art direction**, daftar itu cuma “efek mahal”.

### 1.3 5 kunci “few ingredients” (praktis studio)

Dari konten “5 keys to design AWWWARD winning websites”:

- **Sedikit bahan:** 1–2 typeface terbukti, 2–3 warna solid
- **Master typography**
- **Hierarchy ketat** (sedikit level visual, bukan semua sama penting)
- Fokus & restraint — premium = pilihan, bukan tumpukan tren

Ini selaras dengan voice X: *motion di atas desain jelek = terasa murahan*.

### 1.4 Tips menang SOTD (studio perspective)

Studio Elias merangkum: innovate design + UX + technique + content; lalu: study winners, storytelling, animasi *subtle*, mobile-first, performa, user test, video, submission rapi.

---

## 2. Tren visual 2025–2026 yang sering “terasa Awwwards”

Dari Figma “Top Web Design Trends for 2026” dan contoh SOTD terkini:

| Tren | Bagaimana SOTD memakainya |
|------|---------------------------|
| **3D / immersive (WebGL)** | Produk yang bisa di-spin, world scroll, depth |
| **Experimental navigation** | Bukan cuma Home/About/Contact linear |
| **Bold / kinetic type** | Headline oversized, variable fonts, type as brand |
| **Motion & scrollytelling** | Motion *membawa cerita*, bukan dekorasi |
| **Dark mode / cinematic luxury** | “Depo Luxe” SOTD: cinematic luxury + microinteraction |
| **Vibrant / maximal / neo-brutal** | Brand yang mau berani & anti-template |
| **Performance-first creativity** | Award + Developer Award: speed, a11y, SEO |

Di X, @awwwards menonjolkan tag #animation #microinteraction pada SOTD; reviewer independen memuji **restraint** (whitespace, quiet type, motion yang tidak buru-buru) dan **scroll as narrative**.

**Polaritas yang sehat (2026):**

- **Cinematic / luxury restraint** *atau*
- **Bold maximal / experimental**

Yang kalah: “template SaaS + 12 animasi random”.

---

## 3. Apa kata X (desainer & builder) — ringkasan signal

### 3.1 Award ≠ anti-bisnis

@by__huy (SOTD + FWA + CSSDA untuk OH Architecture): award vs conversion adalah false dichotomy; yang gagal = **strategy jelek**, bukan “cantik”. Premium client mau *clarity wrapped in craft*; **intentional restraint** > kebebasan tanpa konteks.

### 3.2 Foundation > motion

Tiga fondasi sebelum animasi:

1. Visual hierarchy yang mengarahkan keputusan
2. Typography system yang intentional
3. Spacing / whitespace yang berirama

Baru motion untuk attention, state change, continuity.

### 3.3 AI site “tercium AI” kalau…

- Layout generik
- Warna acak
- Typography lemah
- Zero personality

Perbaikan yang berulang di X: **bukan prompt ajaib**, tapi **design instincts + system dulu**.

### 3.4 Workflow builder yang “pro-looking”

- **Meng To:** variasi layout → copy HTML → refine (font, icon, scroll anim) → continuous specs (AI bagus generic kalau tidak di-feed spek terus)
- **Joey Primiani:** interview → plan → prototype → design review skill → iterate; *“Anyone can generate. Taste is the moat.”*
- **Praktisi:** moodboard (Awwwards/Godly/Mobbin/Dribbble) → design system → AI scale; jangan 100% handoff ke AI
- **Tren open-source:** `DESIGN.md` / awesome-design-md — tokens, components, *reasoning* di file yang di-consume agent

---

## 4. Bagaimana biar AI agent “pintar” bikin desain

### 4.1 Diagnosis: kenapa AI jelek di UI

| Penyebab | Gejala |
|----------|--------|
| Prompt fungsional saja | “Buat dashboard” → Bootstrap vibes |
| Tidak ada sistem visual | Warna/font beda tiap section |
| Tidak ada referensi | Clone Linear+Stripe tanpa identitas |
| One-shot generate | 1 section keren, sisanya generic |
| Motion tanpa hierarchy | “AI slop animation” |
| Tidak ada eval loop | Tidak ada kritik hierarchy/spacing/a11y |

Studi LinkedIn (180 AI web design prompts): **structured prompts** menang; vague = average; *prompt structure becomes the new design system*.

### 4.2 Playbook: bikin agent design-capable

#### A. Pisahkan fase (jangan “design + code sekaligus” di awal)

```
1. Creative brief + audience + goals
2. Art direction (mood, 1–2 type, 2–3 colors, do/don't)
3. DESIGN.md / tokens / component rules
4. Structure (section order, hierarchy)
5. Implement
6. Design review (checklist)
7. Motion layer (hanya setelah foundation OK)
```

#### B. Beri “design instincts” lewat file, bukan chat panjang

Isi `DESIGN.md` / skill yang agent *wajib* baca:

- Brand personality (3 kata) + anti-pattern (“no Inter+purple gradient SaaS”, “no default shadcn purple”)
- Color tokens + contrast rules
- Type scale (H1 hero vs body)
- Spacing scale (4/8 atau 8-pt)
- Layout patterns (asymmetric hero, bento, editorial)
- Motion rules (easing, duration, reduce-motion)
- Reference sites (3 URL Awwwards-level) + *apa yang dicopy vs dilarang*
- Component API (button variants, cards, nav)

Ini pola yang ramai di X: design system → Claude stop guessing.

#### C. Prompt formula yang terbukti lebih bagus

Pola “brief designer senior + stack modern”:

```text
Create a [product type] that looks SOTD-ready, not a template.

Audience: …
Business goal: …

Art direction:
- Aesthetic: [cinematic luxury | editorial bold | neo-brutal | product minimal]
- Type: [1 display + 1 body], huge headlines, tight hierarchy
- Palette: [2–3 colors + neutrals], CSS variables only
- Motion: purposeful only (hero entrance, section reveal, CTA hover)
- References: [3 sites] — steal structure, not identity

Constraints:
- Mobile-first, WCAG AA contrast
- No generic Inter/Roboto pairings unless justified
- No animation on weak layouts
- Few ingredients: max 2 fonts, max 3 accent colors

Output order:
1) creative direction (1 page)
2) design tokens
3) section wire + visual hierarchy notes
4) then code
```

#### D. Multi-agent / skill stack (cara “enterprise”)

| Role | Job |
|------|-----|
| **Art director agent** | Mood, type, color, story |
| **UI system agent** | Tokens, components, states |
| **Implementer** | Code only from tokens |
| **Design reviewer** | Hierarchy, spacing, brand, a11y, “AI slop” |
| **Motion specialist** | Baru setelah review foundation pass |

Pola brand-consistent agent: generate → evaluate vs brand guidelines → revise prompt → regenerate (loop).

#### E. Feed visual, bukan hanya teks

Praktisi: screenshot Awwwards/Pinterest/Godly/Mobbin → masukkan ke model vision.  
Variasi layout (shuffle) + keep essence → hindari “satu komponen keren, sisanya kosong”.

#### F. Anti-pattern list (wajib di system prompt agent)

- Default purple/indigo SaaS glass everywhere
- 5 font families
- Border-radius 16px di semua elemen
- Lottie/GSAP di setiap div
- Centered hero + 3 feature cards + logo cloud tanpa story
- Placeholder gray boxes tanpa imagery art direction
- Dark mode dengan gray-on-gray (contrast fail)

---

## 5. Mapping: elemen Awwwards → instruksi agent

| Elemen SOTD | Instruksi agent yang konkret |
|-------------|------------------------------|
| Huge type | `clamp()` H1 48–120px; 1 display face; letter-spacing tuned |
| Hierarchy | Max 3 text levels per section; CTA setelah eye path |
| Whitespace | Spacing scale; “generous pause points”; fewer dividers |
| Motion | Only: page load, scroll reveal, hover/state; respect `prefers-reduced-motion` |
| Microinteraction | Button press, nav indicator, card lift — 150–300ms |
| Imagery | One style bible (photo grade / 3D / illustration) |
| Storytelling | Each section = one beat of brand story |
| Technique | Perf budget; lazy media; no janky scroll hijack on mobile |
| Originality | One signature moment (cursor, transition, 3D object) — not ten |

---

## 6. Untuk Vibing Farmer / product DeFi (aplikasi praktis)

Awwwards penuh *portfolio & brand site*; product app beda constraint. Yang bisa dipinjam:

| Pinjam | Jangan paksa |
|--------|----------------|
| Bold type + clear hierarchy di hero/farm flow | Full WebGL di setiap page |
| Signature motion ringan (graph agents, deposit success) | Scroll-jacking di dashboard |
| Few ingredients + dark cinematic | Neo-brutal random di trust-critical money UI |
| Story: “Set once. Vibe forever.” | Award effects yang bikin user ragu “apakah uangku aman?” |

**Prinsip:** craft premium + **kejelasan risiko & action** = brand trust (bukan pure art site).

Repo ini sudah punya `DESIGN.md` + skill `ui-ux-pro-max` / design-taste — itu **tepat** arah agent design: system dulu, generate belakangan.

---

## Key Takeaways

1. **Awwwards-style = art direction + craft + story + technique**, bukan “banyak animasi”.
2. **Foundation triad:** hierarchy, typography, spacing → baru motion.
3. **Few ingredients** (type/color) terasa lebih mahal daripada tumpukan tren.
4. AI jelek karena **tebak**; AI bagus karena **DESIGN.md + constraints + references + review loop**.
5. **Taste is the moat** — human curates moodboard & anti-pattern; agent scales execution.
6. Untuk product: pinjam *craft*, jaga *clarity & trust* di alur uang.

---

## Sources (pilihan)

1. [A Guide on Building Awwwards Worthy Websites – Alex Streza](https://medium.com/@alex.streza/a-guide-on-building-awwwards-worthy-websites-c4fa710b1c43) — checklist SOTY traits + ranking
2. [10 tips to win SOTD – Studio Elias](https://www.elias.studio/en/blog/post/10-conseils-pour-gagner-un-site-of-the-day-sotd-sur-awwwards) — kriteria jury + tips
3. [Top Web Design Trends for 2026 – Figma](https://www.figma.com/resource-library/web-design-trends/) — tren 3D, type, motion, maximal, etc.
4. [Awwwards SOTD / winners](https://www.awwwards.com/) — referensi live
5. [Claude AI Design Guide – Milind Sahu](https://medium.com/@milindkusahu/build-lovable-dev-quality-ui-the-developers-claude-ai-design-guide-2fd91ee9d824) — prompt structure Awwwards-level
6. X: @by__huy — awards + business results; foundation before motion
7. X: @MengTo — variation → specs continuous → less generic AI
8. X: @jp (Joey Primiani) — interview → review skill → taste
9. X: design-system-first workflows / `DESIGN.md` / UI UX Pro Max skill discourse
10. YouTube: “5 keys to design AWWWARD winning websites” (BONT) — few ingredients

---

## Methodology

- **Sub-questions:** (1) DNA Awwwards, (2) tren 2025–26, (3) signal X, (4) cara AI agent design-smart, (5) aplikasi product.
- **Tools:** web search + full-page reads + X semantic/keyword search.
- **Gap:** Firecrawl/Exa MCP tidak tersedia di sesi riset; Awwwards evaluation page detail skor bobot bisa bergeser—cek [about evaluation](https://www.awwwards.com/about-evaluation/) sebelum submit resmi. Beberapa post X bersifat promo workflow (baca kritis).

---

## Optional next step (repo)

Bisa dilanjut ke **agent design pack** untuk Vibing Farmer:

- `DESIGN.md` Awwwards-inspired + anti-AI-slop rules
- review checklist khusus brand “Set once. Vibe forever.”
- tanpa mengubah product logic on-chain
