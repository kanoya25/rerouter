# rerouter (JS)

Lightweight JS router, 9router-style tapi minimal. Zero deps, Node 22+.

## Run

```bash
node server.js   # baca config.json, listen :20129
```

## Endpoints

- `GET /` → dashboard (instant, models manual via tombol)
- `GET /health` → `{ok, pools, strategy, runtime}`
- `GET /v1/models` + `/api/v1/models` → `oc/*` + `<custom-id>/*` (cache 10 menit)
- `POST /v1/chat/completions` → stream + non-stream, failover relay (opencode) / langsung (custom)
- `GET /admin/stats` → butuh `Authorization: Bearer <api_key>`
## Connect (endpoint + key ala 9router, buat Hermes/dll)

Dashboard tab **Overview** → kartu **Connect** menampilkan base URL + API key
(tombol copy + contoh kode Python). Setara 9router:

```
Endpoint: http://localhost:20129/v1
API Key:  [copy dari dashboard]   → Authorization: Bearer <key>
```

Contoh pakai (Python, gaya Hermes):

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:20129/v1", api_key="rr-...")
r = client.chat.completions.create(
    model="oc/mimo-v2.6-flash-free",
    messages=[{"role": "user", "content": "hi"}])
print(r.choices[0].message.content)
# model custom provider: "<id>/<model>", mis. "myprov/deepseek-chat"
```

- `POST /admin/regen-session` → refresh `x-opencode-session`
- `POST /admin/rotate-key` → generate API key baru (key lama langsung mati),
  tersimpan ke `config.json`. Ada tombol **rotate** di dashboard.
- **Password dashboard** (ala 9router): buka dashboard web wajib login, default `123456`
  (hash SHA-256 di `config.json`), sesi cookie HttpOnly 24 jam. Ganti lewat kartu
  🔐 Keamanan di tab Overview, atau `POST /admin/change-password`
  `{old_password, new_password}` (min. 4 karakter). API (`/v1`, `/admin`) tetap pakai API key.
- `POST /admin/benchmark` → `{providers?, models_per_provider? (1-10), runs? (1-3), prompt?}` speed test latency per model per provider, hasil ranking + success rate (kartu Speed Test di tab Providers).
- `GET/POST /admin/relay` → atur relay pool per provider: `default|random|round-robin|first|direct` + strategi global (kartu Relay Pool di tab Providers). Pool: 9795 relay Vercel di sqlite `pools`.
- `GET /admin/usage?period=today|24h|3d|7d|30d|all` → statistik + token input/output/cache per periode (tab Usage ada period selector). Token dari upstream bila tersedia, bila tidak estimasi ±4 char/token; kolom `prompt_tokens, completion_tokens, cached_tokens` di `usage_log`.
- `GET/POST /admin/relay` → atur relay pool per provider: `default|random|round-robin|first|direct` + strategi global (kartu Relay Pool di tab Providers). Pool: 9795 relay Vercel di sqlite `pools`.
- `GET /admin/usage?period=today|24h|3d|7d|30d|all` → statistik + token input/output/cache per periode (tab Usage ada period selector). Token dari upstream bila tersedia, bila tidak estimasi ±4 char/token; kolom `prompt_tokens, completion_tokens, cached_tokens` di `usage_log`.
- Tips: kalau client Python di VM ini error soal proxy env, bypass dengan
  `OpenAI(..., http_client=httpx.Client(trust_env=False))` atau unset proxy vars
  untuk localhost.
- `GET /admin/providers` → daftar custom provider (key disamarkan)
- `POST /admin/providers` → tambah/update `{id, name, base_url, api_key?, api_keys?[], models[]}`.
  **models boleh kosong** → otomatis detect dari `<base_url>/models` (tidak perlu isi manual).
  **Smart merge**: bila `base_url` sudah terdaftar, cukup kirim `api_key` baru (id boleh kosong)
  → key digabung ke provider existing, tidak bikin duplikat (rotasi otomatis per request)
- `PATCH /admin/providers/<id>` → rename / ganti base_url / enable-disable `{name?, base_url?, enabled?}`
- `POST /admin/providers/<id>/keys` → tambah API key `{key}` (multi-key, rotasi otomatis per request ala 9router)
- `DELETE /admin/providers/<id>/keys/<idx>` → hapus API key
- `POST /admin/providers/<id>/models` → tambah 1 model `{model}`
- `DELETE /admin/providers/<id>/models/<model>` → hapus 1 model
- `POST /admin/providers/<id>/refresh` → tarik ulang daftar model dari upstream `/models`
- `DELETE /admin/providers/<id>` → hapus
- `POST /admin/providers/<id>/test` → test konektivitas (GET `<base>/models`)

Dashboard tab **Providers**: tiap provider bisa di-expand (tombol **kelola**)
untuk rename, ganti base URL, toggle aktif, tambah/hapus API key
(disamarkan, rotasi per request), tambah/hapus model per model,
dan refresh model dari upstream.

## Fitur AI ala 9router (tab dashboard "Fitur AI")

- **RTK token saver** (`rtk_enabled`): deteksi format output tool
  (git diff/log/status, grep, find, ls, tree, build log, log duplikat…)
  lalu kompres per format — hemat 20-40% token input per request.
  Header respons: `X-RTK-Saved: <bytes>`.
- **Caveman** (`caveman_enabled`, level `lite|full|ultra`): injeksi instruksi
  terse ke system prompt — model menjawab ringkas, hemat output token.
  Header: `X-Caveman: <level>`.
- **Vision adaptor** (`vision_strip`, default ON): untuk model di
  `no_vision_models`, blok `image_url` di-strip jadi teks placeholder
  supaya request tidak gagal total. Header: `X-Vision-Stripped: <n>`.
- **Combo** (`combo/<nama>`): model virtual berisi urutan model asli —
  otomatis fallback ke berikutnya bila gagal (retryable: 429/5xx/network).
  Header `X-Model` menunjukkan model yang benar-benar dipakai.
- **Fallbacks**: map `{"oc/model-a": ["oc/model-b"]}` — model biasa juga
  dapat fallback otomatis bila gagal.
- **Round-robin** (`rr/<nama>`): tiap request giliran model berikutnya
  dari pool, mis. `{"free": ["oc/a", "oc/b"]}`.
- Admin API: `GET/PUT /admin/features`, `GET/POST /admin/combos`,
  `DELETE /admin/combos/<nama>`, `PUT /admin/fallbacks`,
  `PUT /admin/round-robin`. `/v1/models` ikut menampilkan
  `combo/*` dan `rr/*`.

## Custom Provider (OpenAI-compatible)

Tambah lewat dashboard tab **Providers** atau API. Contoh:

```bash
curl -X POST localhost:20129/admin/providers \
  -H "Authorization: Bearer <api_key>" -H 'Content-Type: application/json' \
  -d '{"id":"myprov","name":"My Provider","base_url":"https://api.contoh.com/v1",
       "api_key":"sk-...","models":["deepseek-chat","gpt-4o-mini"]}'
```

- Model dipakai sebagai `myprov/deepseek-chat` (prefix `<id>/`, ala 9router).
- Request langsung ke `<base_url>/chat/completions`, tanpa relay pool,
  payload OpenAI diteruskan apa adanya (cuma `model` yang di-override).
- Config tersimpan di `config.json` → `custom_providers` (persisten restart).
- Stream SSE di-pass through; non-stream terima SSE maupun JSON polos.

## Notes

- Pool diimport dari 9router db (`~/.9router/db/data.sqlite` → `rerouter.db`).
  Append-only, dedupe by URL.
- Chat upstream saat ini 403 `FreeTierError` (sama kayak versi Python):
  free tier zen cuma bisa dari dalam OpenCode. Router-nya sehat,
  upstream-nya yang nolak.
- Python lama diarsip ke `server.py.bak`, bukan yang jalan.
