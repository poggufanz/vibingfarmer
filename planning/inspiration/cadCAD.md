# Panduan Arsitektur & Analisis cadCAD (Terkoreksi)

> **Versi dokumen ini**: Diverifikasi terhadap source code & dokumentasi resmi cadCAD v0.5.3
> **Repo**: https://github.com/cadCAD-org/cadCAD
> **Koreksi dari**: Dokumen sebelumnya yang mengandung inakurasi hasil AI-generation tanpa verifikasi

---

cadCAD (**complex adaptive systems Computer-Aided Design**) adalah Python package yang membantu proses designing, testing, dan validating complex systems melalui simulasi — dengan dukungan Monte Carlo methods, A/B testing, dan parameter sweeping.

Dibuat oleh **BlockScience**. Versi current: `0.5.3` (April 2024). Requires Python >= 3.9.

---

## 1. Peta Struktur Repositori

Berikut struktur direktori yang **terverifikasi** dari repo asli:

```
cadCAD/
├── cadCAD/
│   ├── __init__.py
│   ├── types.py
│   │
│   ├── configuration/
│   │   ├── __init__.py             # Kelas inti: Configuration, Experiment
│   │   └── utils/
│   │       ├── __init__.py         # config_sim(), TensorFieldReport, dll.
│   │       ├── depreciationHandler.py  # Backwards compatibility (API lama)
│   │       ├── policyAggregation.py
│   │       └── userDefinedObject.py
│   │
│   ├── engine/
│   │   ├── __init__.py             # Executor, ExecutionMode, ExecutionContext
│   │   ├── execution.py            # Runner: single-proc & multi-proc
│   │   ├── simulation.py           # Pipeline: Timestep → Substep → SUFs
│   │   └── utils.py
│   │
│   ├── tools/
│   │   ├── __init__.py
│   │   ├── preparation.py
│   │   └── utils.py
│   │
│   └── utils/
│       ├── __init__.py
│       └── execution.py
│
├── documentation/                  # Dokumentasi resmi
├── testing/
├── expected_results/
├── requirements.txt
└── setup.py
```

> ⚠️ **Koreksi dari dokumen lama**: `diagram/` **bukan** subfolder internal cadCAD package. Diagram tooling ada di repo terpisah: [`cadCAD-org/cadCAD_diagram`](https://github.com/cadCAD-org/cadCAD_diagram). Dokumen lama keliru menyebutkannya sebagai `cadCAD/diagram/`.

---

## 2. Konsep Inti: Empat Layer Model

Dari dokumentasi resmi, cadCAD beroperasi pada empat layer:

```
┌─────────────────────────────────────────────┐
│  POLICIES                                   │
│  Menentukan inputs ke system dynamic.       │
│  Bisa dari: user input, env observation,    │
│  atau algoritma.                            │
└──────────────────┬──────────────────────────┘
                   │ signals (dict)
                   ▼
┌─────────────────────────────────────────────┐
│  MECHANISMS (State Update Functions)        │
│  Menerima policy signals → update States.  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  STATES                                     │
│  Variabel yang merepresentasikan kondisi    │
│  sistem pada suatu titik waktu.             │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  METRICS (KPIs)                             │
│  Dihitung dari state variables untuk        │
│  menilai "kesehatan" sistem.                │
└─────────────────────────────────────────────┘
```

---

## 3. Komponen Konfigurasi (API v0.5.3)

### 3.1 State Variables

State variables adalah Python `dict` berisi initial values:

```python
genesis_states = {
    'state_variable_1': 0,
    'state_variable_2': 0,
    'state_variable_3': 1.5,
    'timestamp': '2019-01-01 00:00:00'
}
```

cadCAD bisa handle state variables dari **Python data type apapun**, termasuk custom classes.

### 3.2 Policy Functions

Policy function menghitung satu atau lebih **signals** yang di-pass ke State Update Functions via parameter `_input`.

```python
def policy_function_1(_params, substep, sH, s, **kwargs):
    # Observasi state, hitung sinyal
    return {'signal_1': value_1, 'signal_N': value_N}
```

**Parameter:**
- `_params` — system parameters (dari `M` di `config_sim`)
- `substep` — current substep index (int)
- `sH` — historical state (list of list of dicts) ⚠️ _deprecated di versi baru_
- `s` — current state dict
- `**kwargs` — feature extensions

> **Penting**: Policy functions **tidak boleh memodifikasi** parameter yang di-pass ke mereka — semua mutable Python objects yang cadCAD andalkan untuk jalankan simulasi.

**Policy Aggregation**: Di setiap PSUB, seluruh policy functions dieksekusi, lalu hasil (dict) dari semua policies di-aggregate menjadi single dict menggunakan fungsi reduksi (default: key-wise addition `dict1['key'] + dict2['key']`). Hasil agregasi ini yang di-pass sebagai `_input` ke SUFs.

### 3.3 State Update Functions (SUFs)

SUF merepresentasikan persamaan yang menentukan bagaimana state variables berubah. **Setiap SUF hanya boleh memodifikasi satu state variable**, dan harus return tuple `(nama_variabel, nilai_baru)`.

```python
def state_update_function_A(_params, substep, sH, s, _input, **kwargs):
    new_value = s['state_variable_1'] + _input['signal_1']
    return 'state_variable_1', new_value
```

**Parameter:**
- `_params` — system parameters
- `substep` — current substep (int)
- `sH` — historical state ⚠️ _deprecated_
- `s` — current state dict
- `_input` — aggregated signals dari semua policies di PSUB yang sama
- `**kwargs` — feature extensions

### 3.4 Partial State Update Blocks (PSUBs)

PSUB adalah unit eksekusi terkecil — kumpulan policies dan SUFs yang **independen satu sama lain** dalam satu blok.

**Aturan penting**: Jika state variable di-update dalam suatu PSUB, nilai barunya **tidak bisa** berdampak pada policies/SUFs di PSUB yang sama — hanya di PSUB berikutnya.

```python
PSUBs = [
    {
        "policies": {
            "b_1": policy_function_1,
            "b_2": policy_function_2
        },
        "variables": {
            "s_1": state_update_function_1,
            "s_2": state_update_function_2
        }
    },  # PSUB_1
    {
        "policies": {},
        "variables": {
            "s_3": state_update_function_3
        }
    }   # PSUB_2
]
```

Iterasi cadCAD atas `partial_state_update_blocks` di tiap timestep disebut **substep**. Setiap substep menghasilkan satu record state.

---

## 4. Konfigurasi Simulasi (API v0.5.3 — Verified)

> ⚠️ **Koreksi dari dokumen lama**: API lama menggunakan `Executor(exec_context, configs)` langsung dengan global `configs` object. API v0.5.3 menggunakan `Experiment` + `exp.configs`. Dokumen lama mendeskripsikan sintaks lama yang sudah deprecated (ada `depreciationHandler.py` untuk backwards compat).

### Step 1: Buat sim config

```python
from cadCAD.configuration.utils import config_sim

c = config_sim({
    "N": 5,          # Jumlah Monte Carlo runs
    "T": range(100), # Jumlah timesteps
    "M": {           # System parameters (bisa di-sweep)
        "alpha": [0.1, 0.2],
        "beta": [1.0]
    }
})
```

**Parameter sweep**: Jika `M` berisi list, cadCAD otomatis membuat konfigurasi terpisah per kombinasi parameter. `alpha: [0.1, 0.2]` + `beta: [1.0]` → 2 konfigurasi: `{alpha:0.1, beta:1.0}` dan `{alpha:0.2, beta:1.0}`.

### Step 2: Buat Experiment dan append model

```python
from cadCAD.configuration import Experiment

exp = Experiment()
exp.append_model(
    model_id='my_model',              # OPTIONAL: label
    initial_state=genesis_states,
    partial_state_update_blocks=PSUBs,
    policy_ops=[lambda a, b: a + b],  # OPTIONAL: default adalah key-wise addition
    sim_configs=c,
    user_id='user_1'                  # OPTIONAL
)
```

### Step 3: Execution

```python
from cadCAD.engine import ExecutionMode, ExecutionContext, Executor
import pandas as pd

exec_mode = ExecutionMode()

# Local mode: otomatis pilih single atau multi-process
local_mode_ctx = ExecutionContext(context=exec_mode.local_mode)

simulation = Executor(exec_context=local_mode_ctx, configs=exp.configs)

raw_system_events, tensor_field, sessions = simulation.execute()
df = pd.DataFrame(raw_system_events)
```

**Execution Modes yang tersedia:**
- `exec_mode.local_mode` — **default**, otomatis pilih single/multi
- `exec_mode.single_mode` — single-threaded, untuk satu konfigurasi
- `exec_mode.multi_mode` — multi-process, untuk banyak konfigurasi

---

## 5. Output Dataset

`simulation.execute()` return tiga nilai:

```python
raw_system_events, tensor_field, sessions = simulation.execute()
```

- `raw_system_events: List[dict]` — semua state records
- `tensor_field: pd.DataFrame` — mapping functions yang dipakai
- `sessions` — metadata eksekusi

**Struktur output DataFrame:**

```
+------+-----------+------------+--------+-----+---------+----------+
|  s1  | s2        | simulation | subset | run | substep | timestep |
|------+-----------|------------+--------+-----+---------+----------|
|    0 | 0.0       |          0 |      0 |   1 |       0 |        0 |
|    1 | 4         |          0 |      0 |   1 |       1 |        1 |
|    2 | 6         |          0 |      0 |   1 |       2 |        1 |
+------+-----------+------------+--------+-----+---------+----------+
```

**Index columns:**
- `subset` — parameter sweep subset index
- `run` — Monte Carlo run index (1 sampai N)
- `timestep` — discrete time unit
- `substep` — subdivision of timestep (= jumlah PSUBs)
- `simulation` — alpha, abaikan

**Total records**: `N × T × len(PSUBs)`

---

## 6. Mekanisme Multiprocessing

cadCAD menggunakan **`pathos`** (bukan `multiprocessing` bawaan Python) dengan alasan yang terverifikasi:

- `multiprocessing` standar bergantung pada `pickle` untuk serialisasi antar-process
- `pickle` **gagal** serialize lambda, nested functions, dan dynamic generators yang umum dipakai di cadCAD model definitions
- `pathos` menggunakan **`dill`** yang bisa serialize Python execution scope secara mendalam, termasuk function closures

Ini kenapa bisa nulis policy/SUF sebagai lambda atau nested function tanpa khawatir serialization error.

---

## 7. Performance Tips

### `deepcopy_off`

Di awal setiap substep, cadCAD melakukan `deepcopy` pada state terakhir untuk menghindari side effects mutasi. Ini lambat untuk state dengan nested dict/list yang besar.

```python
additional_objs = {'deepcopy_off': True}
simulation = Executor(
    exec_context=local_mode_ctx,
    configs=exp.configs,
    additional_objs=additional_objs
)
```

> **Catatan**: Dengan `deepcopy_off=True`, developer tidak boleh mutasi objek referensi secara in-place di dalam SUF. Kalau dilanggar, state corruption bisa terjadi antar-substep.

---

## 8. Common Errors

### "State Update Function not returning proper tuple"

SUF harus selalu return `(string_nama_variabel, nilai_baru)`.

```python
# ❌ Salah
def bad_suf(_params, substep, sH, s, _input):
    return s['x'] + 1

# ✅ Benar
def good_suf(_params, substep, sH, s, _input):
    return 'x', s['x'] + 1
```

### Parameter sweep error: "list lengths should either be 1 and/or equal"

Semua parameter list di `M` harus punya panjang yang sama, atau panjang 1 (broadcast).

```python
# ❌ Salah — alpha 2 elemen, beta 3 elemen
M = {'alpha': [0.1, 0.2], 'beta': [1.0, 2.0, 3.0]}

# ✅ Benar — sama panjang
M = {'alpha': [0.1, 0.2], 'beta': [1.0, 2.0]}

# ✅ Benar — beta broadcast ke semua alpha
M = {'alpha': [0.1, 0.2], 'beta': [1.0]}
```

---

## 9. Relevansi ke Vibing Farmer (Simulation Engine)

Pemetaan konsep cadCAD ke kebutuhan Step 5:

| Kebutuhan Vibing Farmer | Padanan cadCAD |
|---|---|
| "Alternate futures/timelines" | `N` Monte Carlo runs |
| "Different assumptions" | Parameter sweep via `M` |
| "Distribution of outcomes" | Aggregate hasil DataFrame per `run` index |
| "Expected value" | `df.groupby('run')['metric'].mean()` |
| "Rich context per scenario" | Seed tiap run dengan historical TVL/APY di `initial_state` |
| "APY scenario bull/bear/base" | 3 parameter set di `M` |

**Contoh skeleton untuk vibing-farmer:**

```python
from cadCAD.configuration.utils import config_sim
from cadCAD.configuration import Experiment
from cadCAD.engine import ExecutionMode, ExecutionContext, Executor
import pandas as pd

# State awal dengan on-chain context
genesis_states = {
    'tvl': 10_000_000,
    'apy': 0.15,
    'position_value': 10_000,
    'cumulative_yield': 0,
    'gas_cost_total': 0,
}

# Scenario assumptions: bull / base / bear
c = config_sim({
    'N': 50,           # 50 Monte Carlo runs per scenario
    'T': range(30),    # 30 hari simulasi
    'M': {
        'apy_drift':    [0.02, 0.0, -0.02],   # bull / base / bear
        'tvl_growth':   [0.05, 0.01, -0.03],
        'gas_price_gwei': [20, 35, 60],
    }
})

def policy_yield(_params, substep, sH, s, **kwargs):
    daily_yield = s['position_value'] * (s['apy'] / 365)
    return {'daily_yield': daily_yield}

def suf_position(_params, substep, sH, s, _input, **kwargs):
    return 'cumulative_yield', s['cumulative_yield'] + _input['daily_yield']

def suf_apy(_params, substep, sH, s, _input, **kwargs):
    import random
    noise = random.gauss(0, 0.001)
    new_apy = max(0, s['apy'] + _params['apy_drift'] / 365 + noise)
    return 'apy', new_apy

PSUBs = [
    {
        'policies': {'yield_policy': policy_yield},
        'variables': {
            'cumulative_yield': suf_position,
            'apy': suf_apy,
        }
    }
]

exp = Experiment()
exp.append_model(
    initial_state=genesis_states,
    partial_state_update_blocks=PSUBs,
    sim_configs=c
)

exec_mode = ExecutionMode()
ctx = ExecutionContext(context=exec_mode.local_mode)
sim = Executor(exec_context=ctx, configs=exp.configs)

raw, _, _ = sim.execute()
df = pd.DataFrame(raw)

# Expected value per scenario
summary = df[df['substep'] == 1].groupby('subset')['cumulative_yield'].agg(['mean', 'std', 'min', 'max'])
print(summary)
```

---

## 10. Resources

- **Repo utama**: https://github.com/cadCAD-org/cadCAD
- **Dokumentasi resmi**: https://github.com/cadCAD-org/cadCAD/tree/master/documentation
- **Demos & tutorials**: https://github.com/cadCAD-org/demos
- **Snippets (minimal examples)**: https://github.com/cadCAD-org/snippets
- **radCAD** (alternatif lebih modern, compatible): https://github.com/CADLabs/radCAD
- **Ethereum Economic Model** (contoh produksi): https://github.com/CADLabs/ethereum-economic-model