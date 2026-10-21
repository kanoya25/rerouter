# rerouter (JS)

Lightweight OpenAI-compatible AI gateway, 9router-style but minimal. Zero dependencies, Node 22+.

Routes chat requests through a pool of relay proxies (for OpenCode free tier) or directly to custom OpenAI-compatible providers, with automatic failover, per-relay 429 quarantine, and token-saving features.

## Run

```bash
cp config.example.json config.json   # then fill in your api_key
node server.js                        # reads config.json, listens on :20129
```

If `config.json` is missing, the server falls back to `config.example.json` (remember to set your `api_key`).

## Endpoints

- `GET /` → tabbed dashboard (login required, default password `123456`)
- `GET /health` → `{ok, pools, strategy, runtime}`
- `GET /v1/models` → `oc/*` + `<custom-id>/*` + `combo/*` + `rr/*` (cached 10 min)
- `POST /v1/chat/completions` → stream + non-stream, relay failover (opencode) / direct (custom providers)
- `GET /admin/stats` → requires `Authorization: Bearer <api_key>`

## Connect (for Hermes / CLI tools)

Dashboard tab **Overview** → **Connect** card shows the base URL + API key (copy button + Python example):

```
Endpoint: http://localhost:20129/v1
API Key:  [copy from dashboard]   → Authorization: Bearer <key>
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:20129/v1", api_key="rr-...")
r = client.chat.completions.create(
    model="oc/mimo-v2.6-flash-free",
    messages=[{"role": "user", "content": "hi"}])
print(r.choices[0].message.content)
# custom provider model: "<id>/<model>", e.g. "myprov/deepseek-chat"
```

Tip: if your Python client errors on proxy env vars in this VM, bypass with
`OpenAI(..., http_client=httpx.Client(trust_env=False))` or unset proxy vars for localhost.

## Relay pool (opencode free tier)

- Relay pool stored in sqlite `pools` table (append-only, deduped by URL); bring your own relays
- Rotation strategies: `random` | `round-robin` | `first` — global default + per-provider override (`default|random|round-robin|first|direct`)
- Failover: each request walks healthy relays one by one (up to 10 attempts)
- **Automatic 429 quarantine**: a relay returning HTTP 429 is skipped for 24h (persisted in sqlite, survives restarts, auto-recovers, cleared on success). HTTP 403 quarantines for 1h (intermittent egress-IP blocks)
- Request-scoped errors (400/401/404/422) are returned immediately without burning relays; only fallbackable errors (403/429/5xx/timeout) trigger failover
- Dashboard tab **Providers** → Relay Pool card lists quarantined relays with remaining time + manual recover buttons
- Admin: `GET/POST /admin/relay` (`global_strategy`, per-provider `mode`, `quarantined` list, `clear_quarantine`)

## Admin API

- `POST /admin/regen-session` → refresh `x-opencode-session`
- `POST /admin/rotate-key` → generate a new API key (old one dies immediately), saved to `config.json`
- `POST /admin/change-password` → `{old_password, new_password}` (min 4 chars), or via the lock card in Overview tab. API (`/v1`, `/admin`) still uses the API key
- `POST /admin/benchmark` → `{providers?, models_per_provider? (1-10), runs? (1-3), prompt?}` latency speed test per model per provider with ranking + success rate
- `GET /admin/usage?period=today|24h|3d|7d|30d|all` → stats + input/output/cached tokens per period (Usage tab has a period selector). Tokens from upstream when available, otherwise estimated at ~4 chars/token; stored in `usage_log(prompt_tokens, completion_tokens, cached_tokens)`
- `GET /admin/providers` → list custom providers (keys masked)
- `POST /admin/providers` → add/update `{id, name, base_url, api_key?, api_keys?[], models[]}`. `models` may be empty → auto-detected from `<base_url>/models`. **Smart merge**: if `base_url` is already registered, just send a new `api_key` (id may be empty) → key is merged into the existing provider, no duplicates (automatic per-request rotation)
- `PATCH /admin/providers/<id>` → rename / change base_url / enable-disable `{name?, base_url?, enabled?}`
- `POST /admin/providers/<id>/keys` → add API key `{key}` (multi-key, automatic per-request rotation)
- `DELETE /admin/providers/<id>/keys/<idx>` → delete API key
- `POST /admin/providers/<id>/models` → add one model `{model}`
- `DELETE /admin/providers/<id>/models/<model>` → delete one model
- `POST /admin/providers/<id>/refresh` → re-fetch model list from upstream `/models`
- `DELETE /admin/providers/<id>` → delete provider
- `POST /admin/providers/<id>/test` → connectivity test (GET `<base>/models`)

Dashboard tab **Providers**: each provider expands (via **manage**) for rename, base URL change, active toggle, add/remove API keys (masked, rotated per request), per-model add/remove, and upstream model refresh.

## AI features (dashboard "Fitur AI" tab)

- **RTK token saver** (`rtk_enabled`): detects tool output formats (git diff/log/status, grep, find, ls, tree, build logs, duplicate logs...) and compresses per format — saves 20-40% input tokens per request. Response header: `X-RTK-Saved: <bytes>`
- **Caveman** (`caveman_enabled`, level `lite|full|ultra`): injects terse instructions into the system prompt — model answers concisely, saving output tokens. Header: `X-Caveman: <level>`
- **Vision adaptor** (`vision_strip`, default ON): for models in `no_vision_models`, `image_url` blocks are stripped to a text placeholder so requests don't fail entirely. Header: `X-Vision-Stripped: <n>`
- **Combo** (`combo/<name>`): virtual model containing an ordered list of real models — automatically falls back to the next on failure (retryable: 429/5xx/network). Header `X-Model` shows which model actually served
- **Fallbacks**: map `{"oc/model-a": ["oc/model-b"]}` — plain models also get automatic fallback on failure
- **Round-robin** (`rr/<name>`): each request rotates to the next model from the pool, e.g. `{"free": ["oc/a", "oc/b"]}`
- Admin API: `GET/PUT /admin/features`, `GET/POST /admin/combos`, `DELETE /admin/combos/<name>`, `PUT /admin/fallbacks`, `PUT /admin/round-robin`

## Custom providers (OpenAI-compatible)

Add via dashboard tab **Providers** or the API:

```bash
curl -X POST localhost:20129/admin/providers \
  -H "Authorization: Bearer <api_key>" -H 'Content-Type: application/json' \
  -d '{"id":"myprov","name":"My Provider","base_url":"https://api.example.com/v1",
       "api_key":"sk-...","models":["deepseek-chat","gpt-4o-mini"]}'
```

- Models are used as `myprov/deepseek-chat` (prefix `<id>/`, 9router-style)
- Requests go directly to `<base_url>/chat/completions`, no relay pool; the OpenAI payload is passed through as-is (only `model` is overridden)
- Config persists in `config.json` → `custom_providers` (survives restarts)
- SSE streaming is passed through; non-stream accepts both SSE and plain JSON

## Notes

- Never commit `config.json`, `*.db`, `*.log`, or `shots/` — see `.gitignore`. Copy `config.example.json` to `config.json` and fill in your keys
- The legacy Python server is archived as `server.py.bak`; `server.js` is the active one
