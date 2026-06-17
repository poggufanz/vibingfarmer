# Step 7 — Consensus Gate + Decision Logging

**Inspired by**: ACC pattern dari EvoDS — sub-agent context compression sebelum verdict aggregation. Manager-level orchestration dan Self-Evolving components (ASA, Agentic RL) sengaja di-scope out karena live trading risk profile.

> **Referensi**: EvoDS: Self-Evolving Autonomous Data Science Agent with Skill Learning and Context Management
> arXiv:2606.03841v1 — Zherui Yang et al., HKUST Guangzhou, Juni 2026
> https://arxiv.org/abs/2606.03841v1

## Narasi

EvoDS menggunakan Adaptive Context Compression (ACC) di dua level: sub-agents mengkompresi output eksekusi mereka sebelum dikirim ke Manager Agent, dan Manager Agent sendiri punya mekanisme kompresi adaptif untuk mengelola long-term context history-nya. Di atas itu, EvoDS adalah self-evolving system — sub-agents bisa mensintesis skill baru secara otonom, dan seluruh sistem dioptimasi dengan agentic reinforcement learning dua tahap.

Vibing Farmer mengadopsi **hanya satu aspek**: pola ACC di level sub-agent. Sub-agents (technical, sentiment, on-chain) tidak dump raw analisis — mereka distill ke compressed verdict sebelum dikirim ke Consensus Gate. Ini yang membuat token overhead tetap rendah dan keputusan tetap auditable.

Dua komponen EvoDS lainnya — Autonomous Skill Acquisition dan Agentic RL — sengaja tidak diadopsi. Bukan karena tidak relevan, tapi karena domain constraints-nya berbeda fundamental: di live trading, exploration cost adalah uang nyata, reward signal-nya delayed dan noisy, dan market regime berubah cukup cepat untuk membuat "skill yang dipelajari" di satu kondisi aktif berbahaya di kondisi lain.

Sebagai gantinya, Consensus Gate dirancang deterministic dan auditable by design — dengan decision log lengkap sebagai fondasi untuk calibration manual dan Bayesian confidence update di iterasi berikutnya.

---

## Mapping EvoDS → Vibing Farmer

| EvoDS | Vibing Farmer | Status |
|---|---|---|
| ACC — sub-agent level | Compressed verdict (signal + confidence + summary) | ✅ Diadopsi |
| ACC — Manager level (long-term context history) | Tidak ada | ❌ Di-scope out |
| Manager Agent (LLM orchestrator aktif) | Consensus Gate (deterministic threshold) | ⚠️ Disederhanakan |
| Autonomous Skill Acquisition | Tidak ada | ❌ Di-scope out (exploration cost = uang) |
| Agentic Reinforcement Learning | Decision log → Bayesian calibration manual | ⚠️ Diganti feedback loop lebih aman |

---

## Consensus Logic (Deterministic)

```
verdicts = [
  { agent: "technical",  signal: "BUY",  confidence: 0.82 },
  { agent: "sentiment",  signal: "BUY",  confidence: 0.71 },
  { agent: "on-chain",   signal: "HOLD", confidence: 0.65 },
]

MIN_CONFIDENCE = 0.70
MAJORITY_THRESHOLD = 2  # dari 3

majority_signal = mode(verdicts.signal)           # "BUY"
majority_count  = count(signal == majority_signal) # 2
avg_confidence  = mean(confidence where signal == majority_signal) # 0.765

if majority_count >= MAJORITY_THRESHOLD AND avg_confidence >= MIN_CONFIDENCE:
    decision = majority_signal  # → BUY
else:
    decision = "HOLD"
```

### Edge cases yang perlu di-handle

**3-way split** (BUY / SELL / HOLD masing-masing 1) → HOLD otomatis, tidak ada majority.

**High confidence tapi minority** — misal 1 agent bilang SELL dengan confidence 0.95, 2 agent bilang BUY dengan confidence 0.55 → HOLD karena confidence BUY di bawah threshold, meski majority. Ini intentional: confidence gate mencegah "low-conviction majority."

**All HOLD** → HOLD, tidak perlu dihitung.

---

## Decision Log Schema

Setiap keputusan dicatat lengkap untuk auditability:

```json
{
  "timestamp": "2026-06-11T10:23:00Z",
  "verdicts": [
    { "agent": "technical",  "signal": "BUY",  "confidence": 0.82, "summary": "RSI oversold, MACD crossover" },
    { "agent": "sentiment",  "signal": "BUY",  "confidence": 0.71, "summary": "Positive news flow, low fear index" },
    { "agent": "on-chain",   "signal": "HOLD", "confidence": 0.65, "summary": "TVL flat, no whale movement" }
  ],
  "majority_signal": "BUY",
  "majority_count": 2,
  "avg_confidence": 0.765,
  "final_decision": "BUY",
  "reason": "2/3 majority + confidence 0.765 >= threshold 0.70"
}
```

Log ini adalah sumber utama untuk:
- **Post-mortem analysis** — kenapa keputusan tertentu diambil
- **Confidence calibration** — adjust threshold berdasarkan historical accuracy
- **Agent performance tracking** — agent mana yang paling sering benar

---

## Catatan Implementasi

**Compressed verdict format** yang dikirim tiap sub-agent ke consensus gate harus minimal tapi informatif:

```python
class AgentVerdict(TypedDict):
    signal: Literal["BUY", "SELL", "HOLD"]
    confidence: float          # 0.0 - 1.0
    summary: str               # max 1-2 kalimat, bukan raw analysis
    timestamp: str
```

`summary` adalah versi compressed dari full agent output — ini yang mengadaptasi pola ACC dari EvoDS. Sub-agent tidak dump seluruh analisis, tapi distill ke insight terpenting yang cukup untuk Manager (Consensus Gate) membuat keputusan.
