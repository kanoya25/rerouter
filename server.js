// rerouter — lightweight JS router, 9router-style but minimal.
// Zero deps. Node 22+ (uses node:http, node:sqlite, global fetch).
// Mirrors server.py behavior: pool of vercel relays -> opencode zen,
// per-request rotation + failover, OpenAI-compatible.
//
// Endpoints:
//   GET  /                              dashboard v2 (tabbed, instant, no auto-fetch upstream)
//   GET  /health
//   GET  /v1/models  +  /api/v1/models
//   POST /v1/chat/completions           (stream + non-stream)
//   GET  /admin/stats                   (legacy: 24h summary)
//   GET  /admin/usage?days=7            (rich: lifetime, today, 24h, daily, by-model, recent)
//   POST /admin/regen-session
//
// Run: node server.js  (reads config.json next to it)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const HERE = __dirname;
const CONFIG_PATH = path.join(HERE, 'config.json');
const DB_PATH = path.join(HERE, 'rerouter.db');
const NINE_DB = '/home/ubuntu/.9router/db/data.sqlite';

// ---------------- config ----------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const ex = path.join(__dirname, 'config.example.json');
    if (fs.existsSync(ex)) {
      console.log('[config] config.json tidak ada, pakai config.example.json (isi api_key dulu!)');
      return JSON.parse(fs.readFileSync(ex, 'utf8'));
    }
    throw new Error('config.json tidak ditemukan');
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
let config = loadConfig();
let STRATEGY = config.rotate_strategy || 'random'; // random|round-robin|first

// ---------------- 9router-style features: defaults ----------------
function normStrArr(v) {
  return Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [];
}
function normModelMap(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, arr] of Object.entries(v)) {
      const key = String(k).trim();
      const list = normStrArr(arr);
      if (key && list.length) out[key] = list;
    }
  }
  return out;
}
function applyFeatureDefaults() {
  config.rtk_enabled = config.rtk_enabled === true;
  config.caveman_enabled = config.caveman_enabled === true;
  config.caveman_level = ['lite', 'full', 'ultra'].includes(config.caveman_level) ? config.caveman_level : 'full';
  config.vision_strip = config.vision_strip !== false; // default ON: aman untuk model text-only
  config.no_vision_models = normStrArr(config.no_vision_models);
  config.combos = normModelMap(config.combos);
  config.fallbacks = normModelMap(config.fallbacks);
  config.round_robin = normModelMap(config.round_robin);
  if (!config.provider_relay || typeof config.provider_relay !== 'object') config.provider_relay = {};
  if (!config.model_caps || typeof config.model_caps !== 'object') config.model_caps = {};
}
applyFeatureDefaults();
// ---------------- dashboard password (ala 9router, default 123456) ----------------
// Password khusus akses dashboard web (API tetap pakai API key).
// Disimpan sebagai SHA-256 hash + pepper di config.json, bisa diganti via dashboard.
const DASH_PASS_DEFAULT = '123456';
const DASH_SESSION_TTL = 24 * 3600 * 1000;
function dashPassHash(pw) {
  return crypto.createHash('sha256').update('rr-dash-v1:' + String(pw || '')).digest('hex');
}
if (!config.dashboard_password_hash) {
  config.dashboard_password_hash = dashPassHash(DASH_PASS_DEFAULT);
}
const dashSessions = new Map(); // token -> expiry ts (memory only)
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
    }
  });
  return out;
}
function dashAuthed(req) {
  const t = parseCookies(req)['rr_auth'];
  if (!t) return false;
  const exp = dashSessions.get(t);
  if (!exp || exp < Date.now()) { dashSessions.delete(t); return false; }
  return true;
}
function dashLoginCookie(tok) {
  return 'rr_auth=' + tok + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(DASH_SESSION_TTL / 1000);
}
// PR decolia/9router#4842: free tier pindah /zen/v1 -> /inference/v1 (OpenCode v2)
const ZEN_MODELS_URL = 'https://opencode.ai/inference/v1/models';
const ZEN_CHAT_URL = 'https://opencode.ai/inference/v1/chat/completions';
const TIMEOUT_MS = Math.floor((Number(config.upstream_timeout_s) || 90) * 1000);
const MAX_FAILOVER = Number(config.max_failover) || 3;
let API_KEY = config.api_key || '';
let HEADERS_FIX = config.headers_fix || {};
let KNOWN_MODELS = config.known_models || ['mimo-v2.6-flash-free'];

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function customProviderDefs() {
  return Array.isArray(config.custom_providers) ? config.custom_providers : [];
}

// normalisasi API keys: dukung api_keys[] (multi-key ala 9router, rotasi per request)
// sekaligus migrasi field lama api_key -> api_keys[0]
function normProviderKeys(c) {
  let keys = normStrArr(c.api_keys);
  if (!keys.length && c.api_key) keys = [String(c.api_key)];
  keys = [...new Set(keys)].slice(0, 20);
  c.api_keys = keys;
  c.api_key = keys[0] || '';
  return keys;
}
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••' + s.slice(-4);
}

// id dipakai sebagai prefix model (<id>/<model>), ala 9router "openai-compatible-*"
function validCustomId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(id) && id !== 'oc';
}

// provider custom: OpenAI-compatible — base_url + key sendiri, request langsung
// (tanpa relay pool), payload diteruskan apa adanya, cuma model yang di-override.
function buildProviders() {
  const base = {
    opencode: {
      prefix: 'oc/',
      chat_url: ZEN_CHAT_URL,
      headers_fn: opencodeHeaders,
      build_body_fn: opencodeBuildBody,
      strip_prefix: true,
    },
  };
  const seen = new Set();
  for (const c of customProviderDefs()) {
    if (!c || c.enabled === false) continue;
    const id = String(c.id || '').toLowerCase();
    if (!validCustomId(id) || seen.has(id)) continue;
    const burl = String(c.base_url || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(burl)) continue;
    const keys = normProviderKeys(c);
    const models = Array.isArray(c.models) ? c.models.map(m => String(m).trim()).filter(Boolean) : [];
    if (!models.length) continue;
    seen.add(id);
    base[id] = {
      prefix: id + '/',
      chat_url: burl + '/chat/completions',
      headers_fn: () => {
        const h = { 'Content-Type': 'application/json' };
        // rotasi key ala 9router: tiap request pakai key acak dari pool
        if (keys.length) h['Authorization'] = 'Bearer ' + keys[Math.floor(Math.random() * keys.length)];
        return h;
      },
      build_body_fn: (bareModel, payload) => ({ ...payload, model: bareModel }),
      strip_prefix: true,
      direct: true, // tanpa relay — fetch langsung ke base_url
      custom_id: id,
    };
  }
  return base;
}
let PROVIDERS = buildProviders();
function rebuildProviders() {
  PROVIDERS = buildProviders();
  modelsCache = { ts: 0, ids: null }; // refresh daftar model
}

// ---------------- providers (universal-ready registry) ----------------
function opencodeHeaders() {
  // PR decolia/9router#4842: v2 CLI shape.
  // - UA: opencode/1.18.x ditolak upstream 403 FreeTierError sejak 2026-10-14
  // - x-opencode-request (v1) dihapus: upstream balas 403 kalau ada
  // - upstream butuh x-opencode-session-id di samping x-opencode-session
  const session = HEADERS_FIX['x-opencode-session'] || '';
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer public',
    'User-Agent': 'opencode/latest/2.0.26/cli',
    'x-opencode-client': 'cli',
    'x-opencode-project': HEADERS_FIX['x-opencode-project'] || 'global',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
  };
}
// OpenCode v2 free-tier gate (PR #4860/#4842): request WAJIB declare tools
// `read` + `shell` dengan definisi persis CLI v2.0.26, dan stream harus true.
// Definisi jangan diubah — upstream membandingkan description + parameters.
const FP_READ_DESC = "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.";
const FP_READ_PARAMS = { type: 'object', properties: {
  path: { type: 'string', description: 'File or directory to read' },
  offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
  limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
}, required: ['path'], additionalProperties: false };
const FP_SHELL_DESC = "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.";
const FP_SHELL_PARAMS = { type: 'object', properties: {
  command: { type: 'string', description: 'Shell command string to execute' },
  workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
  timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
  background: { type: 'boolean', description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
}, required: ['command'], additionalProperties: false };

function fingerprintTools() {
  return [
    { type: 'function', function: { name: 'read', description: FP_READ_DESC, parameters: FP_READ_PARAMS } },
    { type: 'function', function: { name: 'shell', description: FP_SHELL_DESC, parameters: FP_SHELL_PARAMS } },
  ];
}


/**
 * Helpers for the OpenCode free-tier client fingerprint.
 * Live upstream probes (OpenCode v2, /inference/v1) show that free-tier
 * requests must declare OpenCode's own `read` and `shell` tools with their exact
 * descriptions and parameter schemas; stubbed descriptions, renamed schemas or
 * tool_choice "none" are answered with 403 FreeTierError. Caller tools are sent
 * untouched, except one that already uses an exact fingerprint name with a
 * different definition: it travels under an alias and the response side
 * restores the caller's original name.
 */
const OPENCODE_FINGERPRINT_TOOLS = ["read", "shell"];

// Verbatim from the OpenCode v2.0.26 CLI. Upstream compares description and
// parameters, so do not reword or reformat these.
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description: "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when it completes.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

/** Extract tool name from either flat or nested function format */
function toolNameOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === 'object' && !Array.isArray(fn) ? fn.name : tool?.name;
}

function fingerprintToolKey(name) {
  const trimmed = String(name ?? "").trim();
  return OPENCODE_FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : "";
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}

function isFingerprintDefinition(tool, key) {
  if (!key) return false;
  const def = tool && (chatFunctionOf(tool) || tool);
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  return !!def && !!want && def.description === want.description
    && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/** Move caller tools off the fingerprint names when their definition differs
 * from OpenCode's, so the exact definitions can be appended without a
 * duplicate name. Everything else, including case variants such as `Read`, is
 * preserved verbatim; upstream accepts them alongside `read`. */
function concealFingerprintNames(tools) {
  if (!Array.isArray(tools)) return { out: tools, map: new Map() };
  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const map = new Map();
  const out = [];
  for (const tool of tools) {
    const key = fingerprintToolKey(toolNameOf(tool));
    if (seen.has(key)) continue;
    seen.add(key);
    // Non-fingerprint tools pass through untouched.
    if (!key) {
      out.push(tool);
      continue;
    }
    if (isFingerprintDefinition(tool, key)) {
      continue;
    }
    let alias = `${key}_client`;
    let i = 2;
    while (taken.has(alias)) { alias = `${key}_client${i}`; i++; }
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { out, map };
}

/**
 * Append OpenCode's definition for each fingerprint tool not already declared.
 *
 * @returns {string[]} names that were appended
 */
function appendFingerprintTools(tools) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    tools.push(
      { type: "function", function: { name, description, parameters } }
    );
    appended.push(name);
  }
  return appended;
}

/** Invert a sent -> original rename map. */
function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

/** Point an explicit tool_choice at the alias of a concealed caller tool. */
function resolveToolChoice(body, map) {
  const aliases = aliasesByOriginal(map);
  if (Array.isArray(body.tool_choice)) {
    body.tool_choice = body.tool_choice.map((choice) => {
      if (typeof choice === "string") {
        const alias = aliases.get(choice.trim());
        return alias ? { type: "function", name: alias } : choice;
      }
      if (choice.type === "function") {
        const alias = aliases.get(choice.function?.name?.trim() || "");
        return alias ? { ...choice, function: { ...choice.function, name: alias } } : choice;
      }
      return choice;
    });
  } else if (body.tool_choice?.type === "function") {
    const alias = aliases.get(body.tool_choice.function?.name?.trim() || "");
    if (alias) body.tool_choice = { ...body.tool_choice, function: { ...body.tool_choice.function, name: alias } };
  }
}

/** Rename prior-turn calls to concealed caller tools as well; otherwise the model
 * reads its own earlier calls as calls to OpenCode's tool of the same name.
 */
function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const aliases = aliasesByOriginal(map);

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) => {
      if (item?.type === "tool_use") {
        const alias = aliases.get(item.name?.trim() || "");
        if (alias) return { ...item, name: alias };
      }
      return item;
    });
  }
  if (Array.isArray(body.tool_calls)) {
    body.tool_calls = body.tool_calls.map((tc) => {
      if (tc?.function) {
        const alias = aliases.get(tc.function.name?.trim() || "");
        if (alias) return { ...tc, function: { ...tc.function, name: alias } };
      }
      return tc;
    });
  }
}


function opencodeBuildBody(model, payload) {
  // stream:true WAJIB — upstream 403 FreeTierError kalau stream:false
  const body = { model, messages: payload.messages || [], stream: true };
  for (const k of ['max_tokens', 'temperature', 'top_p', 'stop']) {
    if (payload[k] !== undefined && payload[k] !== null) body[k] = payload[k];
  }
  // merge fingerprint tools dengan tools milik client (tanpa duplikat nama)
  const fpNames = new Set(['read', 'shell']);
  const clientTools = Array.isArray(payload.tools) ? payload.tools : [];
  const kept = clientTools.filter(t => {
    const n = t && (t.function?.name || t.name);
    return !fpNames.has(n);
  });
  // Use the full fingerprint logic: conceal duplicate names, append exact definitions
  const { out: concealedTools, map } = concealFingerprintNames(kept);
  // Add fingerprint tools with exact nested-format definitions if not already present
  const fpTools = [];
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (!concealedTools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) {
      const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
      fpTools.push({ type: "function", function: { name, description, parameters } });
    }
  }
  body.tools = [...concealedTools, ...fpTools];
  // Resolve any explicit tool_choice pointing at concealed names
  resolveToolChoice(body, map);
  return body;
}
function resolveProvider(modelId) {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (modelId.startsWith(p.prefix)) {
      const bare = p.strip_prefix ? modelId.slice(p.prefix.length) : modelId;
      return [name, bare];
    }
  }
  return ['opencode', modelId]; // default provider
}

// ---------------- db ----------------
const db = new DatabaseSync(DB_PATH);
function initDb() {
  db.exec(`CREATE TABLE IF NOT EXISTS pools(
    id TEXT PRIMARY KEY, name TEXT, url TEXT UNIQUE, isActive INTEGER DEFAULT 1)`);
  db.exec(`CREATE TABLE IF NOT EXISTS usage_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, provider TEXT,
    model TEXT, relay TEXT, status INTEGER, ms INTEGER)`);
  // karantina relay kena 429 (limit 24 jam opencode): url -> sampai kapan di-skip
  db.exec(`CREATE TABLE IF NOT EXISTS relay_cooldowns(
    url TEXT PRIMARY KEY, limited_until INTEGER DEFAULT 0,
    strikes INTEGER DEFAULT 0, last_429_ts INTEGER DEFAULT 0)`);
  // migrasi: kolom token (abaikan bila sudah ada)
  for (const col of ['prompt_tokens INTEGER DEFAULT 0', 'completion_tokens INTEGER DEFAULT 0', 'cached_tokens INTEGER DEFAULT 0']) {
    try { db.exec(`ALTER TABLE usage_log ADD COLUMN ${col}`); } catch {}
  }
  const row = db.prepare('SELECT COUNT(*) c FROM pools').get();
  return row ? row.c : 0;
}
function importFrom9router() {
  if (!fs.existsSync(NINE_DB)) return [0, '9router db not found'];
  let src;
  try {
    src = new DatabaseSync(NINE_DB, { readOnly: true });
  } catch (e) {
    return [0, 'open failed: ' + e.message];
  }
  let rows = [];
  try {
    rows = src.prepare('SELECT data FROM proxyPools WHERE isActive=1').all();
  } catch (e) {
    try { src.close(); } catch {}
    return [0, 'query failed: ' + e.message];
  }
  try { src.close(); } catch {}
  const have = new Set(db.prepare('SELECT url FROM pools').all().map(r => r.url));
  const ins = db.prepare('INSERT OR IGNORE INTO pools(id,name,url,isActive) VALUES(?,?,?,1)');
  let added = 0;
  for (const r of rows) {
    try {
      const j = JSON.parse(r.data);
      const url = (j.proxyUrl || '').replace(/\/+$/, '');
      if (!url || have.has(url)) continue;
      const name = j.name || ('relay-' + Math.floor(100000 + Math.random() * 900000));
      ins.run(crypto.randomBytes(8).toString('hex'), name, url);
      have.add(url);
      added++;
    } catch { continue; }
  }
  const total = db.prepare('SELECT COUNT(*) c FROM pools').get().c;
  return [added, 'total=' + total];
}
function activePools() {
  return db.prepare('SELECT url FROM pools WHERE isActive=1').all()
    .map(r => r.url).filter(Boolean);
}
let rrCounter = 0;
function pickPool(pools, strategy) {
  const s = strategy || STRATEGY;
  if (!pools.length) return null;
  if (s === 'first') return pools[0];
  if (s === 'round-robin') return pools[(rrCounter++) % pools.length];
  return pools[Math.floor(Math.random() * pools.length)]; // random default
}
// ---- karantina 429: relay yang kena rate limit di-skip 24 jam, auto-pulih ----
const QUARANTINE_SECS = 24 * 3600; // 24 jam (limit harian opencode)
const QUARANTINE_403_SECS = 3600;  // 1 jam (403 FreeTierError: blokir IP egress relay, intermittent)
// error yang bisa di-failover ke relay lain (ala 9router #5046): 403/429/5xx + network error.
// 4xx lain (400/401/404/422) itu request-scoped -> langsung balikin, jangan bakar relay.
const FALLBACKABLE = new Set([403, 429, 500, 502, 503, 504]);
function quarantineRelay(relay, secs, status) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const s = Math.min(Math.max(parseInt(secs) || QUARANTINE_SECS, 60), QUARANTINE_SECS);
    db.prepare(`INSERT INTO relay_cooldowns(url, limited_until, strikes, last_429_ts)
      VALUES(?,?,1,?)
      ON CONFLICT(url) DO UPDATE SET limited_until=excluded.limited_until,
        strikes=relay_cooldowns.strikes+1, last_429_ts=excluded.last_429_ts`)
      .run(relay, now + s, now);
    console.log(`[quarantine] ${relay} dikarantina ${Math.round(s / 3600)} jam (HTTP ${status || '?'})`);
  } catch {}
}
function clearRelayQuarantine(relay) {
  try { db.prepare('DELETE FROM relay_cooldowns WHERE url=?').run(relay); } catch {}
}
function isRelayQuarantined(relay) {
  try {
    const r = db.prepare('SELECT limited_until FROM relay_cooldowns WHERE url=?').get(relay);
    return !!(r && r.limited_until > Math.floor(Date.now() / 1000));
  } catch { return false; }
}
function availablePools() {
  return activePools().filter(u => !isRelayQuarantined(u));
}
function quarantineList() {
  try {
    const now = Math.floor(Date.now() / 1000);
    return db.prepare('SELECT url, limited_until, strikes, last_429_ts FROM relay_cooldowns WHERE limited_until > ? ORDER BY limited_until DESC')
      .all(now).map(r => ({ url: r.url, strikes: r.strikes, last_429: r.last_429_ts, remaining_secs: r.limited_until - now }));
  } catch { return []; }
}
function logUse(provider, model, relay, status, ms) {
  try {
    const r = db.prepare('INSERT INTO usage_log(ts,provider,model,relay,status,ms) VALUES(?,?,?,?,?,?)')
      .run(Math.floor(Date.now() / 1000), provider, model, relay, status, ms);
    return Number(r.lastInsertRowid) || null;
  } catch { return null; }
}
// update token usage setelah response diproses (id dari logUse)
function logUseTokens(id, promptT, completionT, cachedT) {
  if (!id) return;
  try {
    db.prepare('UPDATE usage_log SET prompt_tokens=?, completion_tokens=?, cached_tokens=? WHERE id=?')
      .run(promptT | 0, completionT | 0, cachedT | 0, id);
  } catch {}
}
// ekstrak token usage dari body JSON / SSE upstream (tahan nested braces)
function extractUsage(sseText) {
  let pt = 0, ct = 0, cached = 0;
  const parseU = (u) => {
    if (!u || typeof u !== 'object') return false;
    pt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
    ct = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
    cached = Number((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ?? u.cached_tokens ?? 0) || 0;
    return pt || ct;
  };
  try {
    const j = JSON.parse(sseText);
    if (j.usage && parseU(j.usage)) return { pt, ct, cached };
  } catch {}
  // scan mundur cari "usage": lalu parse balanced braces
  try {
    let idx = sseText.lastIndexOf('"usage"');
    while (idx > 0) {
      const colon = sseText.indexOf(':', idx + 7);
      const start = sseText.indexOf('{', colon);
      if (start < 0) break;
      let depth = 0, end = -1;
      for (let i = start; i < sseText.length && i < start + 2000; i++) {
        if (sseText[i] === '{') depth++;
        else if (sseText[i] === '}') { depth--; if (!depth) { end = i; break; } }
      }
      if (end > 0) {
        try {
          const u = JSON.parse(sseText.slice(start, end + 1));
          if (parseU(u)) return { pt, ct, cached };
        } catch {}
      }
      idx = sseText.lastIndexOf('"usage"', idx - 1);
    }
  } catch {}
  return { pt, ct, cached };
}

// ---------------- helpers ----------------
function relayTarget(relay, chatUrl) {
  return relay.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(chatUrl);
}
function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    ...(extraHeaders || {}),
  });
  res.end(body);
}
function sendText(res, code, text, contentType) {
  res.writeHead(code, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function needAuth(req, res) {
  if (!API_KEY) return true;
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${API_KEY}`) {
    sendJson(res, 401, { error: 'Missing or invalid API key' });
    return false;
  }
  return true;
}
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------- model capabilities (ala 9router) ----------------
// Layered detection (first match wins), ala 9router capabilities.js:
//   1. config.model_caps[id]            — manual override (prioritas tertinggi)
//   2. models.dev catalog               — 9000+ model, modalities akurat
//   3. regex fallback                   — tebakan dari nama model
// Bisa dioverride manual via config.model_caps = { "id/model": {vision:true,...} }
const MODELS_DEV_PATH = path.join(__dirname, 'models.dev.json');
const MODELS_DEV_TTL_MS = 7 * 24 * 3600 * 1000; // refresh mingguan
let modelsDevIndex = null; // Map: lowercased model id -> {vision, reasoning, tools}
function buildModelsDevIndex(data) {
  const idx = new Map();
  try {
    for (const prov of Object.values(data || {})) {
      const models = (prov && prov.models) || {};
      for (const [mid, m] of Object.entries(models)) {
        if (!m || typeof m !== 'object') continue;
        const key = String(mid).toLowerCase();
        if (idx.has(key)) continue;
        const input = ((m.modalities || {}).input || []).map(String);
        idx.set(key, {
          vision: input.some(x => /image|video/i.test(x)),
          reasoning: !!m.reasoning,
          tools: m.tool_call !== false,
        });
      }
    }
  } catch {}
  return idx;
}
function refreshModelsDevCatalog() {
  // background refresh, jangan blokir startup
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  fetch('https://models.dev/api.json', { signal: ctrl.signal })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(data => {
      modelsDevIndex = buildModelsDevIndex(data);
      try { fs.writeFileSync(MODELS_DEV_PATH, JSON.stringify(data)); } catch {}
      console.log('[caps] models.dev catalog refreshed:', modelsDevIndex.size, 'models');
    })
    .catch(e => console.log('[caps] models.dev refresh gagal:', e.message))
    .finally(() => clearTimeout(timer));
}
(function initModelsDevCatalog() {
  try {
    const st = fs.statSync(MODELS_DEV_PATH);
    if (Date.now() - st.mtimeMs < MODELS_DEV_TTL_MS) {
      modelsDevIndex = buildModelsDevIndex(JSON.parse(fs.readFileSync(MODELS_DEV_PATH, 'utf8')));
      console.log('[caps] models.dev catalog loaded:', modelsDevIndex.size, 'models');
      return;
    }
  } catch {}
  refreshModelsDevCatalog();
  setInterval(refreshModelsDevCatalog, MODELS_DEV_TTL_MS).unref?.();
})();
function getModelCaps(fullId) {
  const id = String(fullId || '');
  const bare = id.includes('/') ? id.split('/').pop() : id;
  const manual = config.model_caps && config.model_caps[id];
  if (manual && typeof manual === 'object') {
    return {
      vision: !!manual.vision,
      reasoning: !!(manual.reasoning || manual.thinking),
      tools: manual.tools !== false,
    };
  }
  // layer 2: models.dev catalog (exact id match, bare atau full)
  if (modelsDevIndex) {
    const hit = modelsDevIndex.get(bare.toLowerCase()) || modelsDevIndex.get(id.toLowerCase());
    if (hit) return { vision: hit.vision, reasoning: hit.reasoning, tools: hit.tools };
  }
  // layer 3: regex fallback
  const n = (bare + ' ' + id).toLowerCase();
  const vision = /vision|vl\b|multimodal|omnimodal|image|gpt-4o|claude-3|claude-4|gemini.*(pro|flash)|qwen.*vl|internvl|llava|minicpm-v|mimo/.test(n)
    && !/text-only|no-vision/.test(n);
  const reasoning = /thinking|reasoning|\br1\b|deepseek-r1|o1|o3|qwen3|qwq|glm-.*-thinking|kimi.*thinking|reasoner|mimo/.test(n);
  // tool calling: mayoritas model chat modern support; yang jelas tidak: embedding/tts/image gen
  const tools = !/embed|tts|whisper|dall-e|imagen|flux|stable-diffusion/.test(n);
  return { vision, reasoning, tools };
}

// models cache: avoid hammering upstream zen on every dashboard load
let modelsCache = { ts: 0, ids: null };
const MODELS_TTL_MS = 10 * 60 * 1000;
async function getModelIds() {
  const now = Date.now();
  if (modelsCache.ids && (now - modelsCache.ts) < MODELS_TTL_MS) return modelsCache.ids;
  let ids = [...KNOWN_MODELS].map(m => ({ id: `oc/${m}`, owned_by: 'opencode' }));
  try {
    const r = await fetch(ZEN_MODELS_URL, {
      headers: { 'Authorization': 'Bearer public', 'User-Agent': 'opencode/latest/2.0.26/cli' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const data = await r.json();
      const raw = Array.isArray(data) ? data : (data.data || data);
      const free = (Array.isArray(raw) ? raw : [])
        .map(m => (typeof m === 'object' && m !== null ? m.id : m))
        .filter(m => typeof m === 'string' && m.includes('free'));
      if (free.length) ids = [...new Set(free)].sort().map(m => ({ id: `oc/${m}`, owned_by: 'opencode' }));
    }
  } catch {}
  // custom provider: <id>/<model>
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (!p.direct || !p.custom_id) continue;
    const c = customProviderDefs().find(x => String(x.id || '').toLowerCase() === p.custom_id);
    const models = (c && Array.isArray(c.models)) ? c.models : [];
    for (const m of models) {
      const mm = String(m).trim();
      if (mm) ids.push({ id: `${p.custom_id}/${mm}`, owned_by: p.custom_id });
    }
  }
  // virtual models: combo/* (fallback chain) & rr/* (round-robin)
  for (const name of Object.keys(config.combos || {}))
    ids.push({ id: `combo/${name}`, owned_by: 'combo' });
  for (const name of Object.keys(config.round_robin || {}))
    ids.push({ id: `rr/${name}`, owned_by: 'round-robin' });
  modelsCache = { ts: now, ids };
  return ids;
}

// relay mode per provider (ala 9router): 'default' | 'random' | 'round-robin' | 'first' | 'direct'
// 'default' = opencode pakai pool (strategi global), custom provider direct (perilaku lama)
const RELAY_MODES = ['default', 'random', 'round-robin', 'first', 'direct'];
function providerRelayMode(pname) {
  const m = String((config.provider_relay && config.provider_relay[pname]) || 'default');
  if (m === 'direct' || m === 'random' || m === 'round-robin' || m === 'first') return m;
  const p = PROVIDERS[pname];
  if (p && p.direct) return 'direct';
  return STRATEGY; // 'random'|'round-robin'|'first'
}
async function upstreamTry(providerName, bareModel, payload) {
  const p = PROVIDERS[providerName];
  const mode = providerRelayMode(providerName);
  if (mode === 'direct') return upstreamDirect(providerName, bareModel, payload);
  let pools = availablePools(); // skip relay yang lagi dikarantina 429
  if (!pools.length) {
    const q = quarantineList().length;
    const err = new Error(q
      ? `semua ${q} relay lagi dikarantina 429 (limit 24 jam), coba lagi nanti`
      : 'no active relays in pool');
    err.status = q ? 429 : 502;
    throw err;
  }
  const body = p.build_body_fn(bareModel, payload);
  const headers = p.headers_fn();
  let lastErr = 'unknown';
  let lastStatus = 502;
  // jalanin relay sehat satu-satu (ala 9router #5046), dibatasi biar nggak gantung:
  // tiap relay yang 429/403 langsung dikarantina, jadi request berikutnya skip otomatis
  const tries = Math.min(pools.length, Math.max(MAX_FAILOVER, 10));
  for (let i = 0; i < tries; i++) {
    const relay = pickPool(pools, mode);
    pools = pools.filter(u => u !== relay);
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch(relayTarget(relay, p.chat_url), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (resp.status !== 200) {
        const errBody = (await resp.text().catch(() => '')).slice(0, 300);
        try { await resp.arrayBuffer(); } catch {}
        logUse(providerName, bareModel, relay, resp.status, Date.now() - t0);
        if (resp.status === 429) quarantineRelay(relay, QUARANTINE_SECS, 429);
        else if (resp.status === 403) quarantineRelay(relay, QUARANTINE_403_SECS, 403);
        if (!FALLBACKABLE.has(resp.status)) {
          // request-scoped (400/401/404/422): salah di request-nya, jangan bakar relay lain
          const err = new Error(`${relay} -> HTTP ${resp.status} ${errBody}`);
          err.status = resp.status;
          throw err;
        }
        lastErr = `${relay} -> HTTP ${resp.status} ${errBody}`;
        lastStatus = resp.status;
        continue;
      }
      clearRelayQuarantine(relay); // relay sehat lagi -> hapus karantina
      const logId = logUse(providerName, bareModel, relay, 200, Date.now() - t0);
      return [relay, resp, logId];
    } catch (e) {
      if (e.status && !FALLBACKABLE.has(e.status)) throw e; // request-scoped, teruskan apa adanya
      logUse(providerName, bareModel, relay, 0, Date.now() - t0);
      lastErr = `${relay} -> ${e.name}: ${String(e.message || e).slice(0, 150)}`;
      continue;
    }
  }
  const err = new Error('all relays failed: ' + lastErr);
  err.status = lastStatus;
  throw err;
}

// custom provider: request langsung ke base_url, tanpa relay pool
async function upstreamDirect(providerName, bareModel, payload) {
  const p = PROVIDERS[providerName];
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(p.chat_url, {
        method: 'POST',
        headers: p.headers_fn(),
        body: JSON.stringify(p.build_body_fn(bareModel, payload)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (resp.status !== 200) {
      const errBody = (await resp.text().catch(() => '')).slice(0, 300);
      try { await resp.arrayBuffer(); } catch {}
      logUse(providerName, bareModel, 'direct', resp.status, Date.now() - t0);
      const err = new Error(`${p.chat_url} -> HTTP ${resp.status} ${errBody}`);
      err.status = resp.status;
      throw err;
    }
    const logIdD = logUse(providerName, bareModel, 'direct', 200, Date.now() - t0);
    return ['direct', resp, logIdD];
  } catch (e) {
    if (e.status) throw e;
    logUse(providerName, bareModel, 'direct', 0, Date.now() - t0);
    const err = new Error(`${p.chat_url} -> ${e.name}: ${String(e.message || e).slice(0, 150)}`);
    err.status = 502;
    throw err;
  }
}

// ---------------- 9router-style features: RTK token saver ----------------
// RTK = Reasoning/Tool-result Kompressor: deteksi format output tool
// (git diff, grep, ls, build log, dll) lalu kompres per format.
// Hemat 20-40% token input per request ala 9router.
const RTK_MIN_BYTES = 500;
const RTK_DETECT_WINDOW = 1024;

function rtkGitDiff(t) {
  // potong tiap hunk: simpan 40 baris pertama + 10 terakhir
  return t.split(/^@@ /m).map((hunk, i) => {
    if (i === 0) return hunk.split('\n').slice(0, 8).join('\n');
    const lines = hunk.split('\n');
    if (lines.length <= 60) return '@@ ' + hunk;
    return '@@ ' + lines.slice(0, 40).join('\n') + '\n...[' + (lines.length - 50) + ' lines trimmed]...\n' + lines.slice(-10).join('\n');
  }).join('');
}
function rtkCapLines(t, max, label) {
  const lines = t.split('\n');
  if (lines.length <= max) return t;
  return lines.slice(0, max).join('\n') + '\n...[' + (lines.length - max) + ' ' + (label || 'lines') + ' trimmed by RTK]...';
}
function rtkGrep(t) {
  // batasi 10 match per file
  const perFile = {};
  const out = [];
  for (const line of t.split('\n')) {
    const m = line.match(/^([^:]+):\d+:/);
    if (m) {
      const f = m[1];
      perFile[f] = (perFile[f] || 0) + 1;
      if (perFile[f] > 10) continue;
      if (perFile[f] === 10) { out.push(line + '  [...more matches in ' + f + ' trimmed]'); continue; }
    }
    out.push(line);
  }
  return out.join('\n');
}
function rtkFind(t) {
  // batasi 10 file per direktori, 20 direktori
  const perDir = {};
  const out = [];
  let dirs = 0;
  const seenDir = new Set();
  for (const line of t.split('\n')) {
    const d = line.includes('/') ? line.slice(0, line.lastIndexOf('/')) : '.';
    if (!seenDir.has(d)) { seenDir.add(d); dirs++; if (dirs > 20) continue; }
    perDir[d] = (perDir[d] || 0) + 1;
    if (perDir[d] > 10) continue;
    out.push(line);
  }
  return out.join('\n');
}
const RTK_NOISE_DIRS = ['node_modules', '.git', 'target', '__pycache__', '.next', 'dist', 'build', '.cache', '.venv', 'venv', 'coverage', '.idea', '.vscode'];
function rtkLs(t) {
  const lines = t.split('\n').filter(l => !RTK_NOISE_DIRS.some(n => l.includes(n)));
  const kept = rtkCapLines(lines.join('\n'), 120, 'entries');
  return kept;
}
function rtkTree(t) {
  return rtkCapLines(t, 200, 'tree lines');
}
function rtkBuildOutput(t) {
  // dedup baris berulang (progress bar, download) + cap
  const seen = new Set();
  const out = [];
  for (const line of t.split('\n')) {
    const k = line.replace(/\d+(\.\d+)?\s*(%|MB|KB|kB|s\b)/g, '#').trim();
    if (k && seen.has(k)) continue;
    seen.add(k);
    out.push(line);
    if (out.length > 4000 && seen.size > 3000) break;
  }
  return rtkCapLines(out.join('\n'), 150, 'build lines');
}
function rtkDedupLog(t) {
  const counts = {};
  const out = [];
  for (const line of t.split('\n')) {
    const k = line.trim();
    if (!k) continue;
    counts[k] = (counts[k] || 0) + 1;
    if (counts[k] === 1) out.push(line);
    else if (counts[k] === 2) out.push(line + '  [repeats...]');
  }
  return rtkCapLines(out.join('\n'), 2000, 'log lines');
}
function rtkSmartTruncate(t) {
  const lines = t.split('\n');
  if (lines.length < 250) return t;
  return lines.slice(0, 120).join('\n') + '\n...[' + (lines.length - 180) + ' lines trimmed by RTK]...\n' + lines.slice(-60).join('\n');
}
function rtkReadNumbered(t) {
  // "  12|content" -> "content" (hemat prefix nomor)
  return t.split('\n').map(l => l.replace(/^\s*\d+\s*[|:]\s?/, '')).join('\n');
}
function rtkDetect(text) {
  const head = text.length > RTK_DETECT_WINDOW ? text.slice(0, RTK_DETECT_WINDOW) : text;
  if (/^[*|/\\ ]*commit [0-9a-f]{7,40}$/m.test(head)) return ['git-log', t => rtkCapLines(t, 200, 'commits')];
  if (/^diff --git /m.test(head) || /^@@ /m.test(head)) return ['git-diff', rtkGitDiff];
  if (/^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m.test(head)) return ['git-status', t => rtkCapLines(t, 60, 'status lines')];
  if (/^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|ERROR:)/im.test(head)) return ['build-output', rtkBuildOutput];
  const lines = head.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  const first5 = nonEmpty.slice(0, 5);
  if (first5.some(l => /^[^:]+:\d+:/.test(l))) return ['grep', rtkGrep];
  if (nonEmpty.length >= 3 && nonEmpty.every(l => { const x = l.trim(); return x && !x.includes(':') && (x.startsWith('.') || x.startsWith('/') || x.includes('/')); })) return ['find', rtkFind];
  if (/[├└]──|│  /.test(head)) return ['tree', rtkTree];
  if (/^total \d+$/m.test(head) || (head.match(/^[-dlbcps][rwx-]{9}/gm) || []).length >= 3) return ['ls', rtkLs];
  if (lines.length >= 250) {
    const sample = lines.slice(0, 100).filter(l => l.trim());
    const numbered = sample.filter(l => /^\s*\d+\s*[|:]\s?/.test(l)).length;
    if (sample.length >= 5 && numbered / sample.length >= 0.7) return ['read-numbered', rtkReadNumbered];
  }
  if (nonEmpty.length >= 5) return ['dedup-log', rtkDedupLog];
  if (text.split('\n').length >= 250) return ['smart-truncate', rtkSmartTruncate];
  return null;
}
function rtkCompressText(text, stats) {
  stats.before += text.length;
  if (text.length < RTK_MIN_BYTES) { stats.after += text.length; return text; }
  const det = rtkDetect(text);
  if (!det) { stats.after += text.length; return text; }
  const [name, fn] = det;
  let out;
  try { out = fn(text); } catch { out = text; }
  if (!out || !out.length || out.length >= text.length) { stats.after += text.length; return text; }
  stats.after += out.length;
  stats.hits.push({ filter: name, saved: text.length - out.length });
  return out;
}
// Kompres konten tool_result di messages (format OpenAI). Return stats.
function rtkCompressMessages(messages) {
  const stats = { before: 0, after: 0, hits: [] };
  try {
    for (const msg of messages) {
      if (!msg) continue;
      if (msg.role === 'tool' && typeof msg.content === 'string') {
        msg.content = rtkCompressText(msg.content, stats);
        continue;
      }
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && part.type === 'text' && typeof part.text === 'string')
            part.text = rtkCompressText(part.text, stats);
        }
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!block || block.type !== 'tool_result') continue;
        if (block.is_error === true) continue; // jangan kompres error trace
        if (typeof block.content === 'string') block.content = rtkCompressText(block.content, stats);
        else if (Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part && part.type === 'text' && typeof part.text === 'string')
              part.text = rtkCompressText(part.text, stats);
          }
        }
      }
    }
  } catch (e) { console.warn('[rtk] error:', e.message); }
  return stats;
}
let lastRtkStats = null; // untuk dashboard

// ---------------- caveman: output token saver ----------------
// Instruksi gaya terse ke system prompt — model menjawab ringkas,
// menghemat output token. Level: lite < full < ultra.
const CAVEMAN_PROMPTS = {
  lite: 'Be terse. Use full sentences but drop all filler, hedging and pleasantries. State the thing, the action, the reason. Then the next step.',
  full: 'Be extremely terse. Drop articles (a/an/the) and filler words. Fragments are fine. Keep code, file paths, commands, URLs and error messages verbatim. Pattern: [thing] [action] [reason]. [next step]. No pleasantries, no narration of what you are doing.',
  ultra: 'Maximum terseness. Telegraphic style. One word when one word suffices. Code, paths, commands and errors stay verbatim. No filler, no pleasantries, no narration.',
};
function injectCaveman(messages, level) {
  const prompt = CAVEMAN_PROMPTS[level] || CAVEMAN_PROMPTS.full;
  const tag = '[rerouter/caveman:' + level + '] ';
  for (const m of messages) {
    if (m && m.role === 'system' && typeof m.content === 'string') {
      if (!m.content.startsWith(tag)) m.content = tag + prompt + '\n\n' + m.content;
      return true;
    }
  }
  messages.unshift({ role: 'system', content: tag + prompt });
  return true;
}

// ---------------- vision adaptor ----------------
// Model text-only tidak bisa baca gambar: strip blok image_url
// jadi teks placeholder daripada request gagal total.
function isNoVisionModel(modelId, bare) {
  return config.no_vision_models.some(m => {
    const x = String(m);
    return x === modelId || x === bare || modelId === x || ('oc/' + x) === modelId;
  });
}
function stripVisionImages(messages) {
  let n = 0;
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const part = msg.content[i];
      if (part && (part.type === 'image_url' || part.type === 'image')) {
        msg.content[i] = { type: 'text', text: '[image omitted: this model has no vision capability]' };
        n++;
      }
    }
  }
  return n;
}

// ---------------- version / update ----------------
// Bandingkan commit git lokal vs kanoya25/rerouter@main (cache 1 jam).
// Kalau bukan git install, gitRepo=false dan hasUpdate=false.
let versionCache = { ts: 0, latest: null };
async function getVersionInfo() {
  let current = null, gitRepo = false;
  try {
    const out = execSync('git rev-parse HEAD', { cwd: __dirname, timeout: 5000 }).toString().trim();
    if (/^[0-9a-f]{40}$/.test(out)) { current = out.slice(0, 7); gitRepo = true; }
  } catch {}
  let latest = null;
  const now = Date.now();
  if (versionCache.latest && now - versionCache.ts < 3600e3) {
    latest = versionCache.latest;
  } else {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch('https://api.github.com/repos/kanoya25/rerouter/commits/main',
        { signal: ctrl.signal, headers: { 'User-Agent': 'rerouter' } });
      clearTimeout(t);
      if (r.ok) { const j = await r.json(); latest = String(j.sha || '').slice(0, 7) || null; }
      if (latest) versionCache = { ts: now, latest };
    } catch {}
  }
  return { current, latest, gitRepo, hasUpdate: !!(gitRepo && current && latest && current !== latest) };
}

// ---------------- combo / fallback / round-robin ----------------
// combo/<name>  -> coba models berurutan, fallback otomatis (ala 9router combos)
// rr/<name>     -> round-robin: tiap request giliran model berikutnya
// <model>       -> model + config.fallbacks[model] bila gagal
const rrCursor = {};
function dedupeModels(list) {
  const seen = new Set(), out = [];
  for (const m of list) {
    const k = String(m);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}
function resolveCandidates(modelId) {
  if (modelId.startsWith('combo/')) {
    const name = modelId.slice(6).trim();
    const list = config.combos[name];
    if (!list || !list.length) { const e = new Error('combo not found: ' + name); e.status = 404; throw e; }
    return dedupeModels(list.filter(m => !m.startsWith('combo/') && !m.startsWith('rr/'))).slice(0, 6);
  }
  if (modelId.startsWith('rr/')) {
    const name = modelId.slice(3).trim();
    const list = config.round_robin[name];
    if (!list || !list.length) { const e = new Error('round-robin pool not found: ' + name); e.status = 404; throw e; }
    const clean = dedupeModels(list.filter(m => !m.startsWith('combo/') && !m.startsWith('rr/')));
    const i = (rrCursor[name] || 0) % clean.length;
    rrCursor[name] = (rrCursor[name] || 0) + 1;
    return [clean[i]];
  }
  const fb = config.fallbacks[modelId] || [];
  return dedupeModels([modelId, ...fb]).slice(0, 6);
}
function isRetryableUpstream(err) {
  const s = err && err.status;
  if (s === 429 || s === 500 || s === 502 || s === 503 || s === 504) return true;
  if (!s) return true; // network error / abort
  const m = String((err && err.message) || '').toLowerCase();
  return /rate.?limit|quota|overloaded|capacity|too many|timeout|timed out|temporar|unavailable|socket|econn|fetch failed/i.test(m);
}

function collectSseText(sseText) {
  let text = '', chunks = 0, finish = null;
  for (const raw of sseText.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (d === '[DONE]') break;
    chunks++;
    try {
      const j = JSON.parse(d);
      const ch = (j.choices || [{}])[0];
      const c = (ch.delta || {}).content;
      if (typeof c === 'string') text += c;
      if (ch.finish_reason) finish = ch.finish_reason;
    } catch { continue; }
  }
  return [text, chunks, finish];
}

function freshSession() {
  const ts = BigInt(Date.now());
  const mask = (1n << 48n) - 1n;
  const tp = ((~(ts * 4096n + 1n)) & mask).toString(16).padStart(12, '0');
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let tail = '';
  const rnd = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) tail += alphabet[rnd[i] % alphabet.length];
  return 'ses_' + tp + tail;
}

// ---------------- usage aggregation (9router-style) ----------------
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function buildUsage(days, period) {
  const nowS = Math.floor(Date.now() / 1000);
  const dayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  // period: today | 24h | 3d | 7d | 30d | all (ala 9router)
  const periods = { today: dayStart, '24h': nowS - 86400, '3d': nowS - 3 * 86400, '7d': nowS - 7 * 86400, '30d': nowS - 30 * 86400, all: 0 };
  const pKey = periods[period] !== undefined ? period : '7d';
  const pSince = periods[pKey];
  const total = db.prepare('SELECT COUNT(*) c FROM usage_log').get().c;
  const okL = db.prepare('SELECT COUNT(*) c FROM usage_log WHERE status=200').get().c;
  const tRow = db.prepare('SELECT COUNT(*) t, SUM(status=200) ok FROM usage_log WHERE ts>=?').get(dayStart);
  const hRow = db.prepare('SELECT COUNT(*) t, SUM(status=200) ok FROM usage_log WHERE ts>?').get(nowS - 86400);
  const today = { total: tRow.t || 0, ok: tRow.ok || 0, err: (tRow.t || 0) - (tRow.ok || 0) };
  const last24 = { total: hRow.t || 0, ok: hRow.ok || 0, err: (hRow.t || 0) - (hRow.ok || 0) };
  const msAll = db.prepare('SELECT AVG(ms) a, COUNT(*) c FROM usage_log WHERE ms>0').get();
  const ms24 = db.prepare('SELECT AVG(ms) a, COUNT(*) c FROM usage_log WHERE ms>0 AND ts>?').get(nowS - 86400);
  const avg_ms = msAll && msAll.c ? Math.round(msAll.a) : 0;
  const avg_ms_24h = ms24 && ms24.c ? Math.round(ms24.a) : 0;
  // token per period
  const tok = db.prepare('SELECT COALESCE(SUM(prompt_tokens),0) pt, COALESCE(SUM(completion_tokens),0) ct, COALESCE(SUM(cached_tokens),0) ch, COUNT(*) t, SUM(status=200) ok FROM usage_log WHERE ts>=?').get(pSince);
  const tokens = {
    period: pKey,
    requests: tok.t || 0, ok: tok.ok || 0, err: (tok.t || 0) - (tok.ok || 0),
    prompt: tok.pt || 0, completion: tok.ct || 0, cached: tok.ch || 0,
    total: (tok.pt || 0) + (tok.ct || 0),
  };
  const since = dayStart - (days - 1) * 86400;
  const rows = db.prepare("SELECT date(ts,'unixepoch','localtime') d, COUNT(*) t, SUM(status=200) ok FROM usage_log WHERE ts>=? GROUP BY d ORDER BY d").all(since);
  const map = {};
  for (const r of rows) map[r.d] = r;
  const WD = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const key = ymd(dt);
    const r = map[key];
    const tot = r ? r.t : 0, ok = r ? (r.ok || 0) : 0;
    daily.push({
      date: key,
      label: WD[dt.getDay()] + ' ' + dt.getDate() + '/' + (dt.getMonth() + 1),
      total: tot, ok, err: tot - ok,
    });
  }
  const byModel = db.prepare('SELECT model, COUNT(*) t, SUM(status=200) ok FROM usage_log GROUP BY model ORDER BY t DESC LIMIT 20').all()
    .map(r => ({ model: r.model, total: r.t, ok: r.ok || 0, err: r.t - (r.ok || 0) }));
  const recent = db.prepare('SELECT ts,provider,model,relay,status,ms FROM usage_log ORDER BY ts DESC LIMIT 25').all()
    .map(r => ({ ts: r.ts, provider: r.provider, model: r.model, relay: r.relay, status: r.status, ms: r.ms }));
  return {
    total_requests_lifetime: total,
    ok_lifetime: okL,
    success_rate: total ? Math.round((okL / total) * 1000) / 10 : 0,
    avg_ms, avg_ms_24h,
    today, last_24h: last24,
    tokens,
    days, daily, by_model: byModel, recent,
    pools_active: activePools().length,
    strategy: STRATEGY,
    runtime: 'node',
  };
}

// ---------------- dashboard v2 (tabbed, instant, no auto-fetch upstream) ----------------
// halaman login dashboard (self-contained, tanpa asset eksternal)
const LOGIN_HTML = `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>rerouter · login</title>
<style>
:root{--bg:#09090b;--card:#0f0f12;--line:#1e1e22;--txt:#e4e4e7;--dim:#5b5b64;--acc:#e5484d;--r:6px;--mono:ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font-family:ui-sans-serif,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:28px 24px;width:100%;max-width:340px}
h1{font-size:15px;font-family:var(--mono);font-weight:700;margin-bottom:4px}
h1 b{color:var(--txt);font-weight:700}
.sub{color:var(--dim);font-size:12px;font-family:var(--mono);margin-bottom:20px}
input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:var(--r);color:var(--txt);padding:10px 12px;font-size:14px;margin-bottom:10px;outline:none;font-family:inherit}
input:focus{border-color:var(--dim)}
button{width:100%;background:transparent;border:1px solid var(--line);border-radius:var(--r);color:var(--txt);padding:10px;font-size:12px;font-family:var(--mono);cursor:pointer}
button:hover{border-color:var(--dim)}
.err{border:1px solid var(--acc);color:var(--acc);border-radius:var(--r);padding:9px 12px;font-size:12px;font-family:var(--mono);margin-bottom:12px}
.hint{color:var(--dim);font-size:11px;font-family:var(--mono);margin-top:14px}
</style></head><body>
<div class="card">
<h1>rerouter</h1>
<div class="sub">masukkan password dashboard</div>
__ERR__
<form method="POST" action="/login">
<input type="password" name="password" placeholder="password" autofocus autocomplete="current-password">
<button type="submit">masuk</button>
</form>
<div class="hint">default: 123456 · ganti di dashboard setelah masuk</div>
</div></body></html>`;

const DASHBOARD = `<!doctype html>
<html lang="id" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>rerouter</title>
<link rel="icon" type="image/jpeg" href="/ref/logo.jpg">
<style>
*{box-sizing:border-box}
:root{
  --bg:#09090b; --card:#0f0f12; --card2:#141417; --line:#1e1e22;
  --txt:#e4e4e7; --mut:#8e8e96; --dim:#5b5b64;
  --acc:#e5484d; --acc-dim:rgba(229,72,77,.10);
  --green:#4ade80; --amber:#fbbf24; --blue:#60a5fa;
  --r:6px;
  --mono:ui-monospace,'JetBrains Mono','SFMono-Regular',Menlo,Consolas,monospace;
}
[data-theme="light"]{
  --bg:#fafafa; --card:#ffffff; --card2:#f4f4f5; --line:#e4e4e7;
  --txt:#18181b; --mut:#5b5b64; --dim:#a1a1aa;
  --acc-dim:rgba(229,72,77,.07);
}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--txt);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
/* ---------- top bar ---------- */
.hero{background:var(--bg);border-bottom:1px solid var(--line);min-height:0}
.hero::before,.hero::after{display:none}
.hero-in{max-width:960px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:12px}
.avatar{display:none}
.hero-meta{min-width:0}
.hero-meta h1{font-size:15px;margin:0;font-weight:700;letter-spacing:0;font-family:var(--mono);color:var(--txt);text-shadow:none}
.hero-meta h1 span{color:var(--txt)}
#upd-badge{display:inline-block;font-family:var(--mono);font-size:10px;color:var(--acc);border:1px solid var(--acc);border-radius:4px;padding:2px 8px;margin-left:8px;vertical-align:middle;cursor:pointer;background:transparent;letter-spacing:.04em}
#upd-badge.hidden{display:none}
.hero-meta p{margin:3px 0 0;font-size:11px;color:var(--dim);font-family:var(--mono);white-space:normal;opacity:1}
.hero-meta p b{color:var(--dim);font-weight:400}
.hero-side{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none}
.pill{font-size:11px;color:var(--mut);background:transparent;border:1px solid var(--line);border-radius:var(--r);padding:5px 10px;display:flex;align-items:center;gap:7px;white-space:nowrap;font-family:var(--mono)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--dim);display:inline-block;flex:none}
.dot.on{background:var(--green);box-shadow:none;animation:none}
.themebtn{appearance:none;border:1px solid var(--line);background:transparent;color:var(--mut);border-radius:var(--r);padding:5px 10px;font-size:11px;font-family:var(--mono);cursor:pointer}
.themebtn:hover{color:var(--txt);border-color:var(--dim)}
/* ---------- tabs ---------- */
.tabs{position:sticky;top:0;z-index:30;background:var(--bg);border-bottom:1px solid var(--line)}
.tabs-in{max-width:960px;margin:0 auto;padding:0 20px;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
.tabs-in::-webkit-scrollbar{display:none}
.tab{appearance:none;border:none;border-bottom:2px solid transparent;background:transparent;font-size:13px;color:var(--mut);padding:12px 13px 10px;cursor:pointer;white-space:nowrap;font-family:inherit;border-radius:0}
.tab:hover{color:var(--txt);background:transparent}
.tab.active{color:var(--txt);background:transparent;box-shadow:none}
/* ---------- layout ---------- */
.wrap{max-width:960px;margin:0 auto;padding:20px 20px 64px}
.panel{display:none}
.panel.active{display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px;margin-bottom:12px;box-shadow:none}
.card.hl{border-color:var(--line)}
.card h2{font-size:13px;font-weight:600;margin:0 0 12px;letter-spacing:.01em;color:var(--txt)}
.card h2 .tag{font-size:11px;color:var(--dim);font-weight:400;font-family:var(--mono);margin-left:8px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:640px){.grid2{grid-template-columns:1fr}}
/* ---------- stats ---------- */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
@media(max-width:640px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;position:relative}
.stat{min-width:0;overflow:hidden}
.stat .v{overflow-wrap:anywhere}
.stat::after{display:none}
.stat .k{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;font-family:var(--mono)}
.stat .v{font-size:22px;font-weight:600;font-family:var(--mono);margin-top:4px;color:var(--txt)}
.stat .s{font-size:11px;color:var(--dim);font-family:var(--mono);margin-top:2px}
.stat .v.g{color:var(--green)}
/* ---------- chart ---------- */
.chart{display:flex;align-items:flex-end;gap:3px;height:96px;margin-top:8px}
.day{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.bar{width:100%;max-width:22px;display:flex;flex-direction:column;justify-content:flex-end;min-height:4px}
.bar .ok{background:var(--dim);border-radius:2px;min-height:2px}
.bar .err{background:var(--acc);border-radius:2px;min-height:2px}
.day .lbl{font-size:10px;color:var(--dim);font-family:var(--mono)}
.day .tot{font-size:10px;color:var(--mut);font-family:var(--mono)}
.legend{display:flex;gap:14px;font-size:11px;color:var(--mut);font-family:var(--mono);margin-top:8px}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;font-style:normal}
/* ---------- table ---------- */
.tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:var(--r)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;font-weight:500;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-family:var(--mono);padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid var(--line);color:var(--txt);vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--card2)}
td.mono,th.mono{font-family:var(--mono);font-size:12px}
.st-ok{color:var(--green);font-family:var(--mono);font-size:11px}
.st-err{color:var(--acc);font-family:var(--mono);font-size:11px}
/* ---------- forms ---------- */
.muted{color:var(--mut);font-size:12.5px}
input,select,textarea{background:var(--bg);border:1px solid var(--line);border-radius:var(--r);color:var(--txt);padding:8px 10px;font-size:13px;font-family:inherit;outline:none;width:100%}
input:focus,select:focus,textarea:focus{border-color:var(--dim)}
input[readonly]{color:var(--mut);font-family:var(--mono);font-size:12px}
textarea{min-height:80px;resize:vertical;font-family:var(--mono);font-size:12px}
button{appearance:none;background:transparent;border:1px solid var(--line);border-radius:var(--r);color:var(--mut);padding:7px 13px;font-size:12px;cursor:pointer;font-family:var(--mono)}
button:hover{border-color:var(--dim);color:var(--txt)}
button:active{transform:none}
button.ghost{background:transparent}
button.ghost:hover{border-color:var(--dim);color:var(--txt)}
button.red{background:transparent;border-color:var(--line);color:var(--acc);font-weight:400}
button.red:hover{border-color:var(--acc);color:var(--acc)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.rrow{display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.rrow .rlab{font-size:12px;color:var(--dim);font-family:var(--mono);min-width:110px}
.rrow select{width:auto}
.fld{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
.fld label{font-size:11px;color:var(--dim);font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em}
.fld input,.fld select{width:100%}
/* ---------- relay pool ---------- */
.prelay{display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line);font-size:12.5px}
.prelay:last-child{border-bottom:none}
.prelay select{width:auto;flex:none}
.prelay .pnm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:12px}
.prelay .peff{color:var(--dim);font-size:11px;font-family:var(--mono);flex:none}
/* ---------- playground ---------- */
.thread{display:flex;flex-direction:column;gap:10px;max-height:420px;overflow-y:auto;margin-bottom:12px}
.msg{max-width:85%;padding:9px 12px;border-radius:var(--r);font-size:13px;line-height:1.55;border:1px solid var(--line)}
.msg.u{align-self:flex-end;background:var(--card2);border-color:var(--line)}
.msg.a{align-self:flex-start;background:transparent}
.msg.typing{color:var(--dim);font-family:var(--mono);font-size:12px}
.playbar{display:flex;gap:8px;align-items:stretch}
.playbar select{width:220px;flex:none}
.playbar textarea{flex:1;min-height:40px}
.playbar button{flex:none}
/* ---------- misc ---------- */
.ill{display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px 0;color:var(--dim)}
.ill img{width:72px;height:72px;object-fit:cover;border-radius:var(--r);opacity:.5;filter:grayscale(1)}
.ill .cap{font-size:12px;font-family:var(--mono)}
.kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 12px;align-items:center;margin:0}
.kv dd{min-width:0}
.kv dt{font-size:11px;color:var(--dim);font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em}
.kv dd{margin:0;display:flex;gap:8px}
.kv dd input{flex:1}
.codeblock{background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:12px;font-family:var(--mono);font-size:12px;color:var(--mut);white-space:pre;word-break:normal;overflow-x:auto;margin-top:10px}
@media(max-width:640px){
  .kv{grid-template-columns:1fr;gap:4px}
  .kv dd{flex-wrap:wrap}
  .codeblock{white-space:pre;word-break:normal;overflow-x:auto}
  .playbar{flex-direction:column;align-items:stretch}
  .playbar select{width:100%}
  .playbar button{padding:10px}
  .rrow .rlab{min-width:0}
  .hero-in{padding:12px 16px}
  .tabs-in,.wrap{padding-left:16px;padding-right:16px}
}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--card2);border:1px solid var(--line);color:var(--txt);border-radius:var(--r);padding:9px 16px;font-size:13px;opacity:0;transition:all .2s;z-index:99;pointer-events:none;font-family:var(--mono);font-size:12px}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.ok{border-color:var(--green)}
#toast.err{border-color:var(--acc)}
footer{max-width:960px;margin:0 auto;padding:0 20px 32px;color:var(--dim);font-size:11px;font-family:var(--mono);display:flex;justify-content:space-between}
footer b{color:var(--mut);font-weight:400}
a{color:var(--txt);text-decoration:underline;text-decoration-color:var(--dim);text-underline-offset:3px}
a:hover{text-decoration-color:var(--txt)}
.hidden{display:none}
.searchbar{margin-bottom:12px}
.segrow{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.seg{appearance:none;border:1px solid var(--line);background:transparent;color:var(--mut);border-radius:var(--r);padding:6px 12px;font-size:12px;font-family:var(--mono);cursor:pointer}
.seg.on{color:var(--txt);border-color:var(--dim);background:var(--card2)}
.seg:hover{color:var(--txt)}
.cbadge{display:inline-block;font-size:10px;font-family:var(--mono);color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:2px 7px;margin:2px 4px 2px 0;letter-spacing:.04em;text-transform:uppercase}
/* switch toggle ala 9router */
.sw{display:flex;align-items:center;gap:11px;margin-bottom:12px;font-size:13px;cursor:pointer;user-select:none}
.sw input{position:absolute;opacity:0;pointer-events:none}
.sw-track{width:36px;height:20px;border-radius:999px;background:var(--card2);border:1px solid var(--line);position:relative;flex:none;transition:background .18s,border-color .18s}
.sw-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dim);transition:transform .18s,background .18s}
.sw input:checked + .sw-track{background:var(--acc-dim);border-color:var(--acc)}
.sw input:checked + .sw-track .sw-thumb{transform:translateX(16px);background:var(--acc)}
.sw input:focus-visible + .sw-track{outline:1px solid var(--acc);outline-offset:2px}
.sw-txt b{font-weight:600;color:var(--txt)}
.tag{display:inline-block;font-size:10.5px;font-family:var(--mono);color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:2px 8px;margin-left:6px;vertical-align:middle}
.chip{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:var(--r);padding:8px 12px;margin:0 8px 8px 0;font-size:12.5px;cursor:pointer;background:transparent}
.chip:hover{border-color:var(--dim)}
.chip .pb{font-family:var(--mono);font-size:11px;color:var(--dim)}
.bar-row{display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:12px}
.err{color:var(--acc);font-size:12.5px}
.ok{color:var(--green);font-size:12.5px}
.s{color:var(--dim);font-size:11px;font-family:var(--mono)}
.k{color:var(--dim);font-size:11px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em}
.tot{font-family:var(--mono);font-size:12px;color:var(--txt)}
.day{font-family:var(--mono);font-size:11px;color:var(--dim)}
.cap{font-size:11px;color:var(--dim);font-family:var(--mono)}
.lbl{font-size:11px;color:var(--dim);font-family:var(--mono)}

</style></head><body>

<div class="hero">
  <div class="hero-in">
    <div class="hero-meta">
      <h1>rerouter <button id="upd-badge" class="hidden" onclick="showUpdateInfo()" title="update tersedia"></button></h1>
      <p>v0.1</p>
    </div>
    <div class="hero-side">
      <button class="themebtn" id="themebtn" onclick="toggleTheme()">☾ light</button>
      <div class="pill"><span id="dot" class="dot"></span><span id="pilltxt">connecting…</span></div>
    </div>
  </div>
</div>

<div class="tabs"><div class="tabs-in">
  <button class="tab active" data-tab="overview">Overview</button>
  <button class="tab" data-tab="models">Models</button>
  <button class="tab" data-tab="usage">Usage</button>
  <button class="tab" data-tab="play">Playground</button>
  <button class="tab" data-tab="providers">Providers</button>
  <button class="tab" data-tab="fitur">Fitur AI</button>
</div></div>

<div class="wrap">

<div id="upd-banner" class="hidden" style="margin-bottom:12px"><div class="card" style="border-color:var(--acc);margin-bottom:0">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="color:var(--acc);font-family:var(--mono);font-size:12px" id="upd-bannertxt">update tersedia</span>
    <code class="mono" id="upd-cmd" style="flex:1;font-size:12px;color:var(--mut)">./update.sh</code>
    <button onclick="copyUpdCmd()">copy perintah</button>
  </div></div></div>
<section class="panel active" id="p-overview">
  <div class="stats" id="quick-stats"></div>
  <div class="card hl"><h2>Connect <span class="tag">openai-compatible · buat hermes</span></h2>
    <dl class="kv">
      <dt>base url</dt><dd><input id="conn-base" readonly><button class="ghost" onclick="copyConn('base')">copy</button></dd>
      <dt>api key</dt><dd><input id="conn-key" type="password" readonly><button class="ghost" onclick="toggleConnKey(this)">show</button><button class="ghost" onclick="copyConn('key')">copy</button><button class="ghost" onclick="rotateKey()">rotate</button></dd>
    </dl>
    <div class="codeblock" id="conn-example"></div>
  </div>
  <div class="card"><h2>Keamanan <span class="tag">password dashboard</span></h2>
    <div class="muted" style="margin-bottom:10px">Password untuk membuka dashboard ini. API tetap pakai API key seperti biasa.</div>
    <div class="grid2">
      <input type="password" id="pw-old" placeholder="password lama" autocomplete="current-password">
      <input type="password" id="pw-new" placeholder="password baru (min. 4 karakter)" autocomplete="new-password">
    </div>
    <div class="row">
      <button class="red" onclick="changeDashPass()">ganti password </button>
      <button class="ghost" onclick="dashLogout()">logout</button>
    </div>
  </div>
  <div class="grid2">
    <div class="card"><h2>Status <span class="tag">/health</span></h2><pre id="health">loading…</pre>
      <div style="margin-top:12px"><dl class="kv" id="quick"></dl></div>
    </div>
    <div class="card"><h2>Endpoints</h2>
      <dl class="kv">
        <dt>chat</dt><dd>POST /v1/chat/completions</dd>
        <dt>models</dt><dd>GET /v1/models</dd>
        <dt>usage</dt><dd>GET /admin/usage?days=7</dd>
        <dt>session</dt><dd>POST /admin/regen-session</dd>
        <dt>key</dt><dd>POST /admin/rotate-key</dd>
      </dl>
    </div>
  </div>
</section>

<section class="panel" id="p-models">
  <div class="card"><h2>Models <span class="tag" id="models-note"></span></h2>
    <div class="searchbar"><input id="modelq" placeholder="cari model…" oninput="filterModels()"></div>
    <div class="segrow" id="capfilter" style="margin-bottom:12px">
      <button class="seg on" data-cap="">semua</button>
      <button class="seg" data-cap="vision">vision</button>
      <button class="seg" data-cap="reasoning">thinking</button>
      <button class="seg" data-cap="tools">tools</button>
    </div>
    <div id="models-body">
      <div class="ill"><img src="/ref/loading.jpg" alt="loading"><div class="cap">loading…</div></div>
    </div>
  </div>
</section>

<section class="panel" id="p-usage">
  <div class="card"><h2>Usage <span class="tag">/admin/usage</span></h2>
    <div class="row">
      <input id="key" type="password" placeholder="API key (Bearer)" value="__PREFILL__" style="margin:0;flex:1;min-width:220px">
      <button class="ghost" onclick="loadUsage()">refresh</button>
    </div>
  </div>
  <div id="usage-body">
    <div class="card"><div class="ill"><img src="/ref/empty-state.jpg" alt=""><div class="cap">refresh buat lihat statistik pemakaian</div></div></div>
  </div>
</section>

<section class="panel" id="p-play">
  <div class="card"><h2>Playground <span class="tag">/v1/chat/completions</span></h2>
    <div class="thread" id="thread">
      <div class="ill" id="play-ill"><img src="/ref/empty-state.jpg" alt=""><div class="cap">pilih model, ketik pesan, kirim </div></div>
    </div>
    <div class="playbar">
      <select id="model"></select>
      <textarea id="msg" rows="2" placeholder="ketik pesan… (enter kirim, shift+enter baris baru)"></textarea>
      <button class="red" onclick="sendChat()">kirim </button>
    </div>
  </div>
</section>

<section class="panel" id="p-providers">
  <div class="card"><h2>Relay Pool <span class="tag" id="relay-count"></span></h2>
    <div class="muted" style="margin-bottom:12px">Relay dipakai untuk menyamarkan IP egress. Atur strategi per provider ala 9router.</div>
    <div class="rrow">
      <span class="rlab">strategi global</span>
      <select id="relay-global">
        <option value="random">random</option>
        <option value="round-robin">round-robin</option>
        <option value="first">first</option>
      </select>
      <button class="ghost" onclick="saveRelayGlobal()">simpan</button>
    </div>
    <div id="relay-provs" style="margin-top:6px"></div>
    <div id="relay-quar" style="margin-top:10px"></div>
  </div>
  <div class="card"><h2>Speed Test <span class="tag">latency per provider</span></h2>
    <div class="muted" style="margin-bottom:10px">Test model tercepat/stabil tiap provider sebelum ganti model. Prompt kecil, diulang beberapa kali.</div>
    <div class="grid2">
      <input id="bm-prov" placeholder="provider: oc, jerouter — kosongkan = semua">
      <input id="bm-prompt" placeholder="prompt test (default: Balas dengan satu kata: ok)">
    </div>
    <div class="grid2">
      <div class="fld"><label>model per provider</label><input id="bm-perprov" type="number" min="1" max="10" value="1"></div>
      <div class="fld"><label>pengulangan</label><input id="bm-runs" type="number" min="1" max="3" value="2"></div>
    </div>
    <div class="row">
      <button class="red" id="bm-btn" onclick="runBenchmark()">jalankan test</button>
      <span class="muted" id="bm-status"></span>
    </div>
    <div id="bm-result" style="margin-top:12px"></div>
  </div>
  <div class="card"><h2>Custom Providers <span class="tag">openai-compatible</span></h2>
    <div class="muted" style="margin-bottom:10px">API key diisi di tab Usage (tersimpan otomatis). Model dipakai sebagai <b>id/model</b>, mis. <b>myprov/deepseek-chat</b>.</div>
    <div id="prov-body">
      <div class="ill"><img src="/ref/empty-state.jpg" alt=""><div class="cap">buka tab ini buat load daftar provider </div></div>
    </div>
    <div class="row"><button class="ghost" onclick="loadProviders()">reload</button></div>
  </div>
  <div class="card"><h2>Tambah Provider</h2>
    <input id="pv-id" placeholder="id unik, mis. myprov — kosongkan bila base URL sudah terdaftar">
    <input id="pv-name" placeholder="nama tampilan (opsional)">
    <input id="pv-base" placeholder="base URL, mis. https://api.contoh.com/v1">
    <input id="pv-key" type="password" placeholder="API key — bila base URL sudah ada, key digabung ke provider itu ">
    <input id="pv-models" placeholder="models, pisahkan koma — kosongkan untuk auto-detect dari upstream ">
    <div class="row"><button class="red" onclick="addProvider()">tambah </button></div>
    <div class="muted">Base URL tanpa <b>/chat/completions</b> — ditambah otomatis. Provider custom request-nya langsung, tanpa relay pool.</div>
  </div>
</section>

<section class="panel" id="p-fitur">
  <div class="card"><h2>Token Saver <span class="tag">ala 9router RTK</span></h2>
    <label class="sw"><input type="checkbox" id="ft-rtk"><span class="sw-track"><span class="sw-thumb"></span></span><span class="sw-txt"><b>RTK</b> — kompres output tool (git diff, grep, ls, build log…) <span class="muted">hemat 20-40% token input</span></span></label>
    <label class="sw"><input type="checkbox" id="ft-cave"><span class="sw-track"><span class="sw-thumb"></span></span><span class="sw-txt"><b>Caveman</b> — model menjawab super ringkas <span class="muted">hemat output token</span></span></label>
    <div class="row"><select id="ft-cavelvl" style="width:170px;margin:0;flex:none"><option value="lite">caveman: lite</option><option value="full">caveman: full</option><option value="ultra">caveman: ultra</option></select></div>
    <label class="sw"><input type="checkbox" id="ft-vision"><span class="sw-track"><span class="sw-thumb"></span></span><span class="sw-txt"><b>Vision adaptor</b> — strip gambar untuk model text-only <span class="muted">biar request tidak gagal</span></span></label>
    <input id="ft-novision" placeholder="model tanpa vision, pisahkan koma (mis. oc/tiny-model)">
    <div class="row"><button class="red" onclick="saveFeatures()">simpan </button></div>
    <div class="muted" id="ft-rtkstat"></div>
  </div>
  <div class="card"><h2>Combos <span class="tag">combo/nama</span></h2>
    <div class="muted" style="margin-bottom:10px">Model virtual berisi urutan model asli — otomatis fallback ke berikutnya bila gagal. Dipakai sebagai <b>combo/nama</b>.</div>
    <div id="ft-combos"></div>
    <div class="row"><button class="ghost" onclick="loadFeatures()">reload</button></div>
  </div>
  <div class="card"><h2>Tambah Combo</h2>
    <input id="ft-cname" placeholder="nama combo, mis. coding">
    <input id="ft-cmodels" placeholder="models, pisahkan koma: oc/model-a, oc/model-b">
    <div class="row"><button class="red" onclick="addComboF()">tambah </button></div>
  </div>
  <div class="grid2">
    <div class="card"><h2>Fallbacks <span class="tag">JSON</span></h2>
      <div class="muted" style="margin-bottom:8px">Contoh: {"oc/model-a": ["oc/model-b"]}</div>
      <textarea id="ft-fb" rows="5" spellcheck="false" style="font-family:ui-monospace,Menlo,monospace;font-size:12px"></textarea>
      <div class="row"><button class="ghost" onclick="saveMapF('fb')">simpan</button></div>
    </div>
    <div class="card"><h2>Round-robin <span class="tag">rr/nama</span></h2>
      <div class="muted" style="margin-bottom:8px">Contoh: {"free": ["oc/a", "oc/b"]} — tiap request giliran berikutnya</div>
      <textarea id="ft-rr" rows="5" spellcheck="false" style="font-family:ui-monospace,Menlo,monospace;font-size:12px"></textarea>
      <div class="row"><button class="ghost" onclick="saveMapF('rr')">simpan</button></div>
    </div>
  </div>
</section>

<footer>rerouter v0.1</footer>
</div>
<div id="toast"></div>

<script>
var KEY = '';
try { KEY = localStorage.getItem('rr_key') || ''; } catch (e) {}
function saveKey() { try { localStorage.setItem('rr_key', document.getElementById('key').value); } catch (e) {} }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function p2(n) { return (n < 10 ? '0' : '') + n; }
function fmtTime(ts) {
  var d = new Date(ts * 1000);
  return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}
function hostOf(u) { try { return new URL(u).host; } catch (e) { return String(u || '').slice(0, 40); } }
function ill(src, cap) {
  return '<div class="ill"><img src="/ref/' + src + '.jpg" alt=""><div class="cap">' + cap + '</div></div>';
}
// ---- toast ----
var toastT = null;
function toast(msg, cls) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (cls ? ' ' + cls : '');
  clearTimeout(toastT);
  toastT = setTimeout(function () { t.className = ''; }, 2600);
}
// ---- theme ----
function applyTheme(th) {
  document.documentElement.setAttribute('data-theme', th);
  document.getElementById('themebtn').textContent = th === 'dark' ? '☾ light' : '☀ dark';
  try { localStorage.setItem('rr_theme', th); } catch (e) {}
}
function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}
try { applyTheme(localStorage.getItem('rr_theme') || 'dark'); } catch (e) { applyTheme('dark'); }
// ---- tabs ----
var tabs = document.querySelectorAll('.tab');
var loaded = { models: false, usage: false, providers: false, fitur: false };
document.querySelectorAll('#capfilter .seg').forEach(function (b) {
  b.addEventListener('click', function () { setCapFilter(b.getAttribute('data-cap')); });
});
tabs.forEach(function (t) {
  t.addEventListener('click', function () {
    tabs.forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function (x) { x.classList.remove('active'); });
    t.classList.add('active');
    document.getElementById('p-' + t.getAttribute('data-tab')).classList.add('active');
    try { t.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'}); } catch (e) {}
    var name = t.getAttribute('data-tab');
    if (name === 'models' && !loaded.models) loadModels();
    if (name === 'usage' && !loaded.usage) loadUsage();
    if (name === 'play' && !loaded.models) loadModels();
    if (name === 'providers' && !loaded.providers) { loadProviders(); loadRelay(); }
    if (name === 'fitur' && !loaded.fitur) loadFeatures();
  });
});
// ---- health (local, instant, auto) ----
async function init() {
  try {
    var r = await fetch('/health');
    var h = await r.json();
    document.getElementById('health').textContent = JSON.stringify(h, null, 2);
    var ok = h && h.ok;
    document.getElementById('dot').className = 'dot' + (ok ? ' on' : '');
    document.getElementById('pilltxt').textContent = ok ? ('online · ' + h.pools + ' pools') : 'offline';
    document.getElementById('quick').innerHTML =
      '<dt>pools</dt><dd>' + esc(h.pools) + '</dd>' +
      '<dt>strategy</dt><dd>' + esc(h.strategy) + '</dd>' +
      '<dt>runtime</dt><dd>' + esc(h.runtime) + '</dd>';
    var k0 = document.getElementById('key').value;
    if (k0) loadQuick();
  } catch (e) {
    document.getElementById('health').textContent = 'ERR ' + e;
    document.getElementById('pilltxt').textContent = 'offline';
  }
}
init();
try { syncConn(); } catch (e) {}
try { checkVersion(); } catch (e) {}
document.getElementById('key').addEventListener('input', function () { try { syncConn(); } catch (e) {} try { checkVersion(); } catch (e) {} });
// ---- quick stats on overview ----
function stat(k, v, s, cls) {
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + esc(v) + '</div><div class="s">' + esc(s || '') + '</div></div>';
}
async function loadQuick() {
  var k = document.getElementById('key').value;
  if (!k) return;
  try {
    var r = await fetch('/admin/usage?days=1', { headers: { Authorization: 'Bearer ' + k } });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    var u = await r.json();
    document.getElementById('quick-stats').innerHTML =
      stat('Total Requests', u.total_requests_lifetime, 'lifetime')
      + stat('Today', u.today.total, u.today.ok + ' ok · ' + u.today.err + ' err')
      + stat('Success Rate', u.success_rate + '%', 'lifetime', u.success_rate >= 80 ? 'g' : 'r')
      + stat('Avg Latency', (u.avg_ms || 0) + ' ms', 'lifetime');
  } catch (e) {
    document.getElementById('quick-stats').innerHTML = '';
  }
}
// ---- models ----
var allModels = [];
var provNames = {};
async function loadModels() {
  var body = document.getElementById('models-body');
  var note = document.getElementById('models-note');
  note.textContent = '';
  body.innerHTML = ill('loading', 'loading…');
  try {
    var m = await (await fetch('/v1/models')).json();
    var items = (m.data || []).map(function (x) { return { id: x.id, caps: x.caps || {} }; });
    var ids = items.map(function (x) { return x.id; });
    if (!ids.length) throw new Error('no models');
    allModels = items;
    // nama custom provider untuk header seksi
    try {
      var kk = document.getElementById('key').value;
      if (kk) {
        var pr = await (await fetch('/admin/providers', { headers: { Authorization: 'Bearer ' + kk } })).json();
        (pr.providers || []).forEach(function (c) { provNames[c.id] = c.name || c.id; });
      }
    } catch (e) {}
    renderModels('');
    document.getElementById('model').innerHTML = ids.map(function (id) { return '<option>' + esc(id) + '</option>'; }).join('');
    note.textContent = ids.length + ' model';
    loaded.models = true;
  } catch (e) {
    body.innerHTML = ill('error', 'gagal load models: ' + esc(e.message || e));
  }
}
function provColor(id) {
  var p = id.split('/')[0];
  if (p === 'oc') return '#e5484d';
  var h = 0;
  for (var i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) % 360;
  return 'hsl(' + h + ',60%,55%)';
}
function provLabel(prov) {
  if (prov === 'oc') return 'opencode';
  if (prov === 'combo') return 'combos';
  if (prov === 'rr') return 'round-robin';
  return provNames[prov] || prov;
}
var modelCapFilter = '';
function setCapFilter(cap) {
  modelCapFilter = cap;
  document.querySelectorAll('#capfilter .seg').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-cap') === cap);
  });
  renderModels(document.getElementById('modelq').value);
}
function renderModels(q) {
  var body = document.getElementById('models-body');
  q = (q || '').toLowerCase();
  var cap = modelCapFilter || '';
  var items = allModels.filter(function (x) {
    if (x.id.toLowerCase().indexOf(q) < 0) return false;
    if (cap && !(x.caps && x.caps[cap])) return false;
    return true;
  });
  var ids = items.map(function (x) { return x.id; });
  if (!ids.length) { body.innerHTML = ill('empty-state', 'tidak ketemu '); return; }
  // kelompokkan per provider, masing-masing seksi sendiri
  var groups = {};
  var order = [];
  items.forEach(function (x) {
    var parts = x.id.split('/');
    var prov = parts.length > 1 ? parts[0] : 'oc';
    if (!groups[prov]) { groups[prov] = []; order.push(prov); }
    groups[prov].push(x);
  });
  order.sort(function (a, b) {
    var rank = function (p) { return p === 'oc' ? 0 : p === 'combo' ? 90 : p === 'rr' ? 91 : 50; };
    var ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
  body.innerHTML = '';
  order.forEach(function (prov) {
    var list = groups[prov];
    var sec = document.createElement('div');
    sec.className = 'msec';
    var h = document.createElement('div');
    h.className = 'msec-h';
    var dot = document.createElement('span');
    dot.className = 'pdot';
    dot.style.background = provColor(prov + '/x');
    var t = document.createElement('b');
    t.textContent = provLabel(prov);
    var cnt = document.createElement('span');
    cnt.className = 'muted';
    cnt.textContent = '  ·  ' + list.length + ' model';
    h.appendChild(dot); h.appendChild(t); h.appendChild(cnt);
    sec.appendChild(h);
    var chips = document.createElement('div');
    chips.className = 'chips';
    list.forEach(function (x) {
      var id = x.id;
      var parts = id.split('/');
      var name = parts.length > 1 ? parts.slice(1).join('/') : id;
      var chip = document.createElement('span');
      chip.className = 'chip';
      var pb = document.createElement('span');
      pb.className = 'pb';
      pb.style.color = provColor(id);
      pb.textContent = prov;
      var tx = document.createElement('span');
      tx.textContent = name;
      // badge capability ala 9router
      var caps = x.caps || {};
      if (caps.vision) { var b1 = document.createElement('span'); b1.className = 'cbadge'; b1.textContent = 'vision'; chip.appendChild(b1); }
      if (caps.reasoning) { var b2 = document.createElement('span'); b2.className = 'cbadge'; b2.textContent = 'thinking'; chip.appendChild(b2); }
      var cp = document.createElement('i');
      cp.className = 'cp';
      cp.title = 'copy model id';
      cp.textContent = '⧉';
      cp.onclick = function (ev) { ev.stopPropagation(); copyText(id); toast('copied: ' + id, 'ok'); };
      chip.appendChild(pb); chip.appendChild(tx); chip.appendChild(cp);
      chip.onclick = (function (mid) { return function () { useModel(mid); }; })(id);
      chips.appendChild(chip);
    });
    sec.appendChild(chips);
    body.appendChild(sec);
  });
  var note = document.getElementById('models-note');
  if (note) note.textContent = ids.length + ' model · ' + order.length + ' provider';
}
function filterModels() { renderModels(document.getElementById('modelq').value); }
function useModel(id) {
  document.getElementById('model').value = id;
  tabs.forEach(function (x) { x.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function (x) { x.classList.remove('active'); });
  document.querySelector('[data-tab="play"]').classList.add('active');
  document.getElementById('p-play').classList.add('active');
  toast('model: ' + id, 'ok');
}
async function j(u, o) {
  var r = await fetch(u, o);
  var t = await r.text();
  try { return r.status + '\\\\n' + JSON.stringify(JSON.parse(t), null, 1); } catch (e) { return r.status + '\\\\n' + t; }
}

var usagePeriod = '7d';
async function loadUsage() {
  var k = document.getElementById('key').value;
  saveKey();
  var body = document.getElementById('usage-body');
  body.innerHTML = '<div class="card">' + ill('loading', 'loading…') + '</div>';
  try {
    var r = await fetch('/admin/usage?days=7&period=' + usagePeriod, { headers: { Authorization: 'Bearer ' + k } });
    if (r.status === 401) throw new Error('API key salah (401)');
    var u = await r.json();
    body.innerHTML = renderUsage(u);
    body.querySelectorAll('[data-period]').forEach(function (b) {
      b.addEventListener('click', function () { setUsagePeriod(b.getAttribute('data-period')); });
    });
    loaded.usage = true;
  } catch (e) {
    body.innerHTML = '<div class="card">' + ill('error', 'gagal load usage: ' + esc(e.message || e)) + '</div>';
  }
}

function setUsagePeriod(p) {
  usagePeriod = p;
  loaded.usage = false;
  loadUsage();
}

function fmtTok(n) {
  n = n || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function renderUsage(u) {
  var h = '';
  var periods = [['today', 'Today'], ['24h', '24h'], ['3d', '3d'], ['7d', '7d'], ['30d', '30d'], ['all', 'All']];
  h += '<div class="segrow" style="margin-bottom:12px">';
  periods.forEach(function (pp) {
    h += '<button class="seg' + (u.tokens && u.tokens.period === pp[0] ? ' on' : '') + '" data-period="' + pp[0] + '">' + pp[1] + '</button>';
  });
  h += '</div>';
  var tk = u.tokens || {};
  h += '<div class="stats">'
    + stat('Total Requests', u.total_requests_lifetime, 'lifetime')
    + stat('Today', u.today.total, u.today.ok + ' ok · ' + u.today.err + ' err')
    + stat('24 Jam', u.last_24h.total, u.last_24h.ok + ' ok · ' + u.last_24h.err + ' err')
    + stat('Success Rate', u.success_rate + '%', 'lifetime', u.success_rate >= 80 ? 'g' : 'r')
    + stat('Avg Latency', (u.avg_ms || 0) + ' ms', 'lifetime · 24h ' + (u.avg_ms_24h || 0) + ' ms')
    + '</div>';
  h += '<div class="card"><h2>Tokens <span class="tag">' + esc(tk.period || '') + '</span></h2><div class="stats" style="margin:0">'
    + stat('Input ↑', fmtTok(tk.prompt), (tk.requests || 0) + ' requests')
    + stat('Output ↓', fmtTok(tk.completion), 'completion')
    + stat('Cache', fmtTok(tk.cached), 'cached input')
    + stat('Total', fmtTok(tk.total), 'input + output')
    + '</div><div class="muted">token dari upstream bila tersedia; bila tidak, estimasi ±4 char/token</div></div>';
  var max = 1;
  u.daily.forEach(function (d) { if (d.total > max) max = d.total; });
  h += '<div class="card"><h2>Daily usage <span class="tag">' + u.days + ' hari</span></h2><div class="chart">';
  u.daily.forEach(function (d) {
    var inner = '';
    if (d.total > 0) {
      var okP = Math.round(d.ok / d.total * 100), errP = 100 - okP;
      inner = '<div class="err" style="height:' + errP + '%"></div><div class="ok" style="height:' + okP + '%"></div>';
    }
    h += '<div class="day" title="' + esc(d.date) + ' · total ' + d.total + ' (ok ' + d.ok + ' / err ' + d.err + ')">'
      + '<div class="tot">' + d.total + '</div>'
      + '<div class="bar" style="height:' + Math.max(2, Math.round(d.total / max * 100)) + '%">' + inner + '</div>'
      + '<div class="lbl">' + esc(d.label) + '</div></div>';
  });
  h += '</div><div class="legend"><span><i style="background:#22c55e"></i>ok (200)</span><span><i style="background:#e5484d"></i>error</span></div></div>';
  h += '<div class="card"><h2>By model</h2>';
  if (!u.by_model.length) {
    h += '<div class="muted">belum ada request.</div>';
  } else {
    h += '<div class="tblwrap"><table><tr><th>model</th><th>total</th><th>ok</th><th>err</th></tr>'
      + u.by_model.map(function (m) {
        return '<tr><td class="mono">' + esc(m.model) + '</td><td>' + m.total + '</td><td class="st-ok">' + m.ok + '</td><td class="st-err">' + m.err + '</td></tr>';
      }).join('') + '</table></div>';
  }
  h += '</div>';
  h += '<div class="card"><h2>Recent requests <span class="tag">25 terakhir</span></h2>';
  if (!u.recent.length) {
    h += '<div class="muted">belum ada request.</div>';
  } else {
    h += '<div class="tblwrap"><table><tr><th>waktu</th><th>model</th><th class="mono">relay</th><th>status</th><th>ms</th></tr>'
      + u.recent.map(function (q) {
        var st = q.status === 200 ? '<span class="st-ok">200</span>' : '<span class="st-err">' + esc(q.status) + '</span>';
        return '<tr><td class="mono">' + fmtTime(q.ts) + '</td><td class="mono">' + esc(q.model) + '</td><td class="mono">' + esc(hostOf(q.relay)) + '</td><td>' + st + '</td><td class="mono">' + esc(q.ms) + '</td></tr>';
      }).join('') + '</table></div>';
  }
  h += '</div>';
  return h;
}

// ---- playground (chat bubbles) ----
function bubble(who, text) {
  var t = document.getElementById('thread');
  var illBox = document.getElementById('play-ill');
  if (illBox) illBox.classList.add('hidden');
  var d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  t.appendChild(d);
  t.scrollTop = t.scrollHeight;
  return d;
}
async function sendChat() {
  var k = document.getElementById('key').value;
  if (!k) { toast('isi API key dulu di tab Usage ', 'err'); return; }
  var model = document.getElementById('model').value;
  var ta = document.getElementById('msg');
  var content = ta.value.trim();
  if (!content) return;
  bubble('u', content);
  ta.value = '';
  var typing = bubble('a', '…');
  typing.classList.add('typing');
  try {
    var r = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify({ model: model, messages: [{ role: 'user', content: content }], stream: false }),
    });
    var txt = await r.text();
    var out;
    try {
      var j = JSON.parse(txt);
      out = r.status === 200
        ? ((j.choices || [{}])[0].message || {}).content || '(kosong)'
        : ('HTTP ' + r.status + ' — ' + (j.error || txt).toString().slice(0, 300));
    } catch (e) { out = 'HTTP ' + r.status + ' — ' + txt.slice(0, 300); }
    typing.classList.remove('typing');
    typing.textContent = out;
    document.getElementById('thread').scrollTop = 1e9;
  } catch (e) {
    typing.classList.remove('typing');
    typing.textContent = 'ERR ' + e;
  }
}
document.getElementById('msg').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
// ---- custom providers ----
function admKey() {
  var k = document.getElementById('key').value;
  if (!k) { toast('isi API key dulu di tab Usage ', 'err'); return null; }
  return k;
}
// ---- relay pool per provider (ala 9router) ----
async function loadRelay() {
  var k = document.getElementById('key').value;
  if (!k) return;
  try {
    var r = await fetch('/admin/relay', { headers: { Authorization: 'Bearer ' + k } });
    var d = await r.json();
    if (!r.ok) return;
    document.getElementById('relay-count').textContent = d.pools_active + ' aktif';
    document.getElementById('relay-global').value = d.global_strategy || 'random';
    var box = document.getElementById('relay-provs');
    box.innerHTML = '';
    (d.providers || []).forEach(function (pv) {
      var row = document.createElement('div');
      row.className = 'prelay';
      var nm = document.createElement('div');
      nm.className = 'pnm';
      var b = document.createElement('span');
      b.textContent = pv.name;
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = pv.id;
      nm.appendChild(b); nm.appendChild(tag);
      var sel = document.createElement('select');
      ['default', 'random', 'round-robin', 'first', 'direct'].forEach(function (m) {
        var o = document.createElement('option');
        o.value = m; o.textContent = m;
        if (m === pv.mode) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = (function (pid, el) { return function () { saveRelayProv(pid, el.value); }; })(pv.id, sel);
      var eff = document.createElement('div');
      eff.className = 'peff';
      eff.textContent = '→ ' + pv.effective + (pv.effective === 'direct' ? ' (tanpa relay)' : ' (via pool)');
      row.appendChild(nm); row.appendChild(sel); row.appendChild(eff);
      box.appendChild(row);
    });
    // karantina 429: daftar relay yang lagi di-skip 24 jam
    var qb = document.getElementById('relay-quar');
    qb.innerHTML = '';
    var ql = d.quarantined || [];
    if (ql.length) {
      var qh = document.createElement('div');
      qh.className = 'muted';
      qh.style.marginBottom = '6px';
      qh.textContent = 'Dikarantina 429 (' + ql.length + ' relay, dipakai lagi otomatis setelah 24 jam):';
      qb.appendChild(qh);
      ql.forEach(function (q) {
        var qr = document.createElement('div');
        qr.className = 'prelay';
        var hrs = Math.floor(q.remaining_secs / 3600), mins = Math.floor((q.remaining_secs % 3600) / 60);
        var qs = document.createElement('div');
        qs.className = 'pnm';
        qs.style.fontSize = '12px';
        qs.textContent = q.url + ' — sisa ' + hrs + 'j ' + mins + 'm (' + q.strikes + 'x kena 429)';
        var cb = document.createElement('button');
        cb.className = 'ghost';
        cb.textContent = 'paksa pulih';
        cb.onclick = (function (u) { return function () { clearQuarantine(u); }; })(q.url);
        qr.appendChild(qs); qr.appendChild(cb);
        qb.appendChild(qr);
      });
      var ca = document.createElement('button');
      ca.className = 'ghost';
      ca.style.marginTop = '6px';
      ca.textContent = 'pulihkan semua';
      ca.onclick = function () { clearQuarantine('*'); };
      qb.appendChild(ca);
    }
  } catch (e) {}
}
async function clearQuarantine(u) {
  var k = admKey(); if (!k) return;
  var r = await fetch('/admin/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
    body: JSON.stringify({ clear_quarantine: u }),
  });
  toast(r.ok ? 'karantina dihapus' : 'gagal', r.ok ? 'ok' : 'err');
  if (r.ok) loadRelay();
}
async function saveRelayGlobal() {
  var k = admKey(); if (!k) return;
  var s = document.getElementById('relay-global').value;
  var r = await fetch('/admin/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
    body: JSON.stringify({ global_strategy: s }),
  });
  toast(r.ok ? 'strategi global disimpan' : 'gagal simpan', r.ok ? 'ok' : 'err');
  if (r.ok) loadRelay();
}
async function saveRelayProv(pid, mode) {
  var k = admKey(); if (!k) return;
  var r = await fetch('/admin/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
    body: JSON.stringify({ provider: pid, mode: mode }),
  });
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok) { toast('gagal: ' + (d.error || r.status), 'err'); loadRelay(); return; }
  toast(pid + ' → ' + mode, 'ok');
  loadRelay();
}
async function runBenchmark() {  var k = admKey(); if (!k) return;
  var btn = document.getElementById('bm-btn');
  var st = document.getElementById('bm-status');
  var out = document.getElementById('bm-result');
  var prov = document.getElementById('bm-prov').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var prompt = document.getElementById('bm-prompt').value.trim();
  var perprov = Math.min(Math.max(parseInt(document.getElementById('bm-perprov').value) || 1, 1), 10);
  var runs = Math.min(Math.max(parseInt(document.getElementById('bm-runs').value) || 2, 1), 3);
  btn.disabled = true;
  st.textContent = 'testing… bisa beberapa menit untuk banyak model';
  out.innerHTML = '';
  try {
    var r = await fetch('/admin/benchmark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify({ providers: prov, models_per_provider: perprov, runs: runs, prompt: prompt || undefined }),
    });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) { out.innerHTML = '<div class="err">gagal: ' + esc(d.error || r.status) + '</div>'; return; }
    var rows = (d.results || []).map(function (x, i) {
      var rate = Math.round(100 * x.ok / x.runs);
      var badge = i === 0 && x.ok ? ' <span class="cbadge">best</span>' : '';
      var lat = x.avg_ms == null ? '<span class="muted">fail</span>' :
        '<b>' + x.avg_ms + ' ms</b> <span class="muted">(' + x.min_ms + '–' + x.max_ms + ')</span>';
      return '<tr><td>' + (i + 1) + badge + '</td>' +
        '<td><span class="pb" style="color:' + provColor(x.model) + '">' + esc(x.provider) + '</span> ' + esc(x.model.split('/').slice(1).join('/')) + '</td>' +
        '<td>' + lat + '</td>' +
        '<td>' + x.ok + '/' + x.runs + ' (' + rate + '%)</td>' +
        '<td class="muted">' + esc(x.sample || x.last_error || '') + '</td>' +
        '<td><button class="ghost" data-bmcopy="' + esc(x.model) + '">copy</button></td></tr>';
    }).join('');
    out.innerHTML = '<div class="tblwrap"><table><thead><tr>' +
      '<th>#</th><th>model</th><th>avg latency</th><th>stabil</th><th>respon</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="muted" style="margin-top:8px">prompt: "' + esc(d.prompt || '') + '" · klik copy untuk pakai id di /model Telegram</div>';
    out.querySelectorAll('[data-bmcopy]').forEach(function (b) {
      b.addEventListener('click', function () {
        copyText(b.getAttribute('data-bmcopy'));
        toast('copied: ' + b.getAttribute('data-bmcopy'), 'ok');
      });
    });
    toast('benchmark selesai', 'ok');
  } catch (e) {
    out.innerHTML = '<div class="err">gagal: ' + esc(String(e)) + '</div>';
  } finally {
    btn.disabled = false;
    st.textContent = '';
  }
}
async function loadProviders() {
  var k = admKey(); if (!k) return;
  var body = document.getElementById('prov-body');
  body.innerHTML = ill('loading', 'loading…');
  try {
    var r = await fetch('/admin/providers', { headers: { Authorization: 'Bearer ' + k } });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    var list = d.providers || [];
    if (!list.length) { body.innerHTML = ill('empty-state', 'belum ada custom provider — tambah di bawah '); }
    else {
      body.innerHTML = '';
      list.forEach(function (c) { body.appendChild(provCard(c)); });
    }
    loaded.providers = true;
  } catch (e) { body.innerHTML = ill('error', 'gagal: ' + esc(e.message || e)); }
}
var expandedProv = {};
function provCard(c) {
  var card = document.createElement('div');
  card.className = 'pcard';
  var head = document.createElement('div');
  head.className = 'prow';
  head.style.cssText = 'cursor:pointer;margin:0;border:none;background:none';
  var info = document.createElement('div');
  var b = document.createElement('b'); b.textContent = c.id;
  var sp = document.createElement('span'); sp.className = 'muted'; sp.textContent = ' ' + (c.name || '');
  var br = document.createElement('br');
  var sm = document.createElement('span'); sm.className = 'muted';
  sm.textContent = (c.enabled === false ? 'nonaktif · ' : '') + (c.base_url || '') + ' · ' + (c.models || []).length + ' model · ' + (c.keys_count || 0) + ' key';
  info.appendChild(b); info.appendChild(sp); info.appendChild(br); info.appendChild(sm);
  var btns = document.createElement('div'); btns.className = 'row';
  var be = document.createElement('button'); be.className = 'ghost';
  be.textContent = expandedProv[c.id] ? 'tutup' : 'kelola';
  var bt = document.createElement('button'); bt.className = 'ghost'; bt.textContent = 'test';
  bt.onclick = function (ev) { ev.stopPropagation(); testProvider(c.id); };
  var bd = document.createElement('button'); bd.className = 'ghost'; bd.textContent = 'hapus';
  bd.onclick = function (ev) { ev.stopPropagation(); delProvider(c.id); };
  btns.appendChild(be); btns.appendChild(bt); btns.appendChild(bd);
  head.appendChild(info); head.appendChild(btns);
  var toggle = function () { expandedProv[c.id] = !expandedProv[c.id]; loadProviders(); };
  head.onclick = toggle;
  be.onclick = function (ev) { ev.stopPropagation(); toggle(); };
  card.appendChild(head);
  if (expandedProv[c.id]) card.appendChild(provDetail(c));
  return card;
}
function provFieldRow(label, val, inputId, onSave) {
  var row = document.createElement('div'); row.className = 'krow';
  var lb = document.createElement('span'); lb.className = 'muted';
  lb.style.minWidth = '64px'; lb.textContent = label;
  var inp = document.createElement('input'); inp.id = inputId; inp.value = val;
  inp.style.cssText = 'margin:0;flex:1';
  var sv = document.createElement('button'); sv.className = 'ghost'; sv.textContent = 'simpan';
  sv.onclick = function () {
    var v = document.getElementById(inputId).value.trim();
    if (!v) { toast('tidak boleh kosong', 'err'); return; }
    onSave(v);
  };
  row.appendChild(lb); row.appendChild(inp); row.appendChild(sv);
  return row;
}
function provDetail(c) {
  var det = document.createElement('div');
  det.className = 'pdet';
  det.appendChild(provFieldRow('nama', c.name || '', 'pfn-' + c.id, function (v) { patchProvider(c.id, { name: v }); }));
  det.appendChild(provFieldRow('base url', c.base_url || '', 'pfb-' + c.id, function (v) { patchProvider(c.id, { base_url: v }); }));
  var trow = document.createElement('div'); trow.className = 'krow';
  var lab = document.createElement('label');
  lab.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer';
  var cb = document.createElement('input'); cb.type = 'checkbox';
  cb.checked = c.enabled !== false; cb.style.cssText = 'width:auto;margin:0';
  cb.onchange = function () { patchProvider(c.id, { enabled: cb.checked }); };
  var sp = document.createElement('span'); sp.textContent = 'provider aktif';
  lab.appendChild(cb); lab.appendChild(sp); trow.appendChild(lab);
  det.appendChild(trow);
  var kh = document.createElement('div'); kh.className = 'ph';
  kh.textContent = 'api keys (' + (c.keys_count || 0) + ') · rotasi otomatis per request';
  det.appendChild(kh);
  var klist = document.createElement('div');
  (c.keys || []).forEach(function (mk, i) {
    var kr = document.createElement('div'); kr.className = 'krow';
    var code = document.createElement('code'); code.textContent = mk;
    var del = document.createElement('button'); del.className = 'ghost'; del.textContent = 'hapus';
    del.onclick = (function (idx) { return function () { delProvKey(c.id, idx); }; })(i);
    kr.appendChild(code); kr.appendChild(del);
    klist.appendChild(kr);
  });
  det.appendChild(klist);
  var kadd = document.createElement('div'); kadd.className = 'krow';
  var kin = document.createElement('input'); kin.placeholder = 'tambah API key baru…'; kin.id = 'pfk-' + c.id;
  kin.style.cssText = 'margin:0;flex:1';
  var kb = document.createElement('button'); kb.className = 'ghost'; kb.textContent = 'tambah';
  kb.onclick = function () { addProvKey(c.id); };
  kadd.appendChild(kin); kadd.appendChild(kb);
  det.appendChild(kadd);
  var mh = document.createElement('div'); mh.className = 'ph';
  mh.textContent = 'models (' + (c.models || []).length + ')';
  det.appendChild(mh);
  var mwrap = document.createElement('div');
  (c.models || []).forEach(function (m) {
    var chip = document.createElement('span'); chip.className = 'mchip';
    var t = document.createElement('span'); t.textContent = m;
    var x = document.createElement('button'); x.className = 'mx'; x.textContent = '×'; x.title = 'hapus model';
    x.onclick = (function (mm) { return function () { delProvModel(c.id, mm); }; })(m);
    chip.appendChild(t); chip.appendChild(x);
    mwrap.appendChild(chip);
  });
  det.appendChild(mwrap);
  var madd = document.createElement('div'); madd.className = 'krow'; madd.style.marginTop = '8px';
  var min = document.createElement('input'); min.placeholder = 'tambah model…'; min.id = 'pfm-' + c.id;
  min.style.cssText = 'margin:0;flex:1';
  var mb = document.createElement('button'); mb.className = 'ghost'; mb.textContent = 'tambah';
  mb.onclick = function () { addProvModel(c.id); };
  var rb = document.createElement('button'); rb.className = 'ghost'; rb.textContent = 'refresh dari upstream';
  rb.onclick = function () { refreshProvModels(c.id); };
  madd.appendChild(min); madd.appendChild(mb); madd.appendChild(rb);
  det.appendChild(madd);
  return det;
}
async function provApi(method, url, body) {
  var k = admKey(); if (!k) return null;
  try {
    var r = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: body ? JSON.stringify(body) : undefined,
    });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) { toast('gagal: ' + (d.error || r.status), 'err'); return null; }
    return d;
  } catch (e) { toast('gagal: ' + e, 'err'); return null; }
}
function provReloaded() {
  loaded.providers = false; loaded.models = false;
  loadProviders(); loadModels();
}
async function patchProvider(id, patch) {
  var d = await provApi('PATCH', '/admin/providers/' + encodeURIComponent(id), patch);
  if (d) { provReloaded(); toast('tersimpan ', 'ok'); }
}
async function addProvKey(id) {
  var inp = document.getElementById('pfk-' + id);
  var v = inp.value.trim();
  if (!v) { toast('isi key dulu', 'err'); return; }
  var d = await provApi('POST', '/admin/providers/' + encodeURIComponent(id) + '/keys', { key: v });
  if (d) { provReloaded(); toast('key ditambahkan ', 'ok'); }
}
async function delProvKey(id, idx) {
  if (!confirm('hapus key ini?')) return;
  var d = await provApi('DELETE', '/admin/providers/' + encodeURIComponent(id) + '/keys/' + idx);
  if (d) { provReloaded(); toast('key dihapus', 'ok'); }
}
async function addProvModel(id) {
  var inp = document.getElementById('pfm-' + id);
  var v = inp.value.trim();
  if (!v) { toast('isi model dulu', 'err'); return; }
  var d = await provApi('POST', '/admin/providers/' + encodeURIComponent(id) + '/models', { model: v });
  if (d) { provReloaded(); toast('model ditambahkan ', 'ok'); }
}
async function delProvModel(id, m) {
  if (!confirm('hapus model ' + m + '?')) return;
  var d = await provApi('DELETE', '/admin/providers/' + encodeURIComponent(id) + '/models/' + encodeURIComponent(m));
  if (d) { provReloaded(); toast('model dihapus', 'ok'); }
}
async function refreshProvModels(id) {
  toast('refresh models dari upstream…');
  var d = await provApi('POST', '/admin/providers/' + encodeURIComponent(id) + '/refresh');
  if (d) {
    if (d.ok) { provReloaded(); toast(d.count + ' model dari upstream ', 'ok'); }
    else toast('refresh gagal: ' + (d.error || ('HTTP ' + d.http)), 'err');
  }
}
async function addProvider() {
  var k = admKey(); if (!k) return;
  var id = document.getElementById('pv-id').value.trim().toLowerCase();
  var name = document.getElementById('pv-name').value.trim();
  var base = document.getElementById('pv-base').value.trim();
  var key = document.getElementById('pv-key').value.trim();
  var models = document.getElementById('pv-models').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!base) { toast('base URL wajib diisi', 'err'); return; }
  // id boleh kosong bila base URL sudah terdaftar -> key digabung ke provider itu (smart merge)
  try {
    var r = await fetch('/admin/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify({ id: id, name: name || id, base_url: base, api_key: key, models: models }),
    });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) { toast('gagal: ' + (d.error || r.status), 'err'); return; }
    document.getElementById('pv-id').value = '';
    document.getElementById('pv-base').value = '';
    document.getElementById('pv-key').value = '';
    document.getElementById('pv-models').value = '';
    loaded.providers = false; loaded.models = false;
    loadProviders(); loadModels();
    if (d.merged) toast(d.added_keys + ' key digabung ke provider ' + d.provider.id + '  (base URL sama)', 'ok');
    else toast('provider ' + id + ' ditambahkan ' + (d.detected ? ' (' + d.detected + ' model auto-detect)' : ''), 'ok');
  } catch (e) { toast('gagal: ' + e, 'err'); }
}
// ---- version / update check ----
var updInfo = null;
async function checkVersion() {
  var k = admKey(); if (!k) return;
  try {
    var d = await (await fetch('/admin/version', { headers: { Authorization: 'Bearer ' + k } })).json();
    updInfo = d;
    var b = document.getElementById('upd-badge');
    if (d.hasUpdate) {
      b.classList.remove('hidden');
      b.textContent = 'update: ' + d.latest;
      var bn = document.getElementById('upd-banner');
      bn.classList.remove('hidden');
      document.getElementById('upd-bannertxt').textContent = 'update tersedia: ' + d.current + ' → ' + d.latest;
    }
  } catch (e) {}
}
function showUpdateInfo() {
  if (updInfo && updInfo.hasUpdate) toast('jalankan ./update.sh di folder rerouter lalu restart', 'ok');
  else toast('sudah versi terbaru', 'ok');
}
function copyUpdCmd() {
  var t = './update.sh';
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(function(){ toast('perintah dicopy', 'ok'); });
  else toast(t, 'ok');
}
// ---- fitur AI (RTK / caveman / vision / combo / fallback / round-robin) ----
async function loadFeatures() {
  var k = admKey(); if (!k) return;
  try {
    var d = await (await fetch('/admin/features', { headers: { Authorization: 'Bearer ' + k } })).json();
    document.getElementById('ft-rtk').checked = !!d.rtk_enabled;
    document.getElementById('ft-cave').checked = !!d.caveman_enabled;
    document.getElementById('ft-cavelvl').value = d.caveman_level || 'full';
    document.getElementById('ft-vision').checked = !!d.vision_strip;
    document.getElementById('ft-novision').value = (d.no_vision_models || []).join(', ');
    var lr = d.last_rtk;
    document.getElementById('ft-rtkstat').textContent = lr
      ? ('RTK terakhir: hemat ' + (lr.before - lr.after) + 'B dari ' + lr.before + 'B via ' + lr.hits.join(', ') + ' @ ' + lr.model)
      : 'belum ada request yang terkompres RTK';
    document.getElementById('ft-fb').value = JSON.stringify(d.fallbacks || {}, null, 2);
    document.getElementById('ft-rr').value = JSON.stringify(d.round_robin || {}, null, 2);
    renderCombosF(d.combos || {});
    loaded.fitur = true;
  } catch (e) { toast('gagal load fitur: ' + e, 'err'); }
}
async function saveFeatures() {
  var k = admKey(); if (!k) return;
  var body = {
    rtk_enabled: document.getElementById('ft-rtk').checked,
    caveman_enabled: document.getElementById('ft-cave').checked,
    caveman_level: document.getElementById('ft-cavelvl').value,
    vision_strip: document.getElementById('ft-vision').checked,
    no_vision_models: document.getElementById('ft-novision').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
  };
  try {
    var r = await fetch('/admin/features', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k }, body: JSON.stringify(body) });
    toast(r.ok ? 'fitur disimpan ' : 'gagal simpan', r.ok ? 'ok' : 'err');
  } catch (e) { toast('gagal: ' + e, 'err'); }
}
function renderCombosF(combos) {
  var box = document.getElementById('ft-combos');
  var names = Object.keys(combos);
  if (!names.length) { box.innerHTML = '<div class="muted">belum ada combo — tambah di bawah </div>'; return; }
  box.innerHTML = '';
  names.forEach(function (n) {
    var row = document.createElement('div'); row.className = 'prow';
    var info = document.createElement('div');
    var b = document.createElement('b'); b.textContent = 'combo/' + n;
    var br = document.createElement('br');
    var sm = document.createElement('span'); sm.className = 'muted'; sm.textContent = (combos[n] || []).join(' → ');
    info.appendChild(b); info.appendChild(br); info.appendChild(sm);
    var del = document.createElement('button'); del.className = 'ghost'; del.textContent = 'hapus';
    del.onclick = (function (name) { return function () { delComboF(name); }; })(n);
    row.appendChild(info); row.appendChild(del);
    box.appendChild(row);
  });
}
async function addComboF() {
  var k = admKey(); if (!k) return;
  var name = document.getElementById('ft-cname').value.trim().toLowerCase();
  var models = document.getElementById('ft-cmodels').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!name || !models.length) { toast('nama + models wajib diisi', 'err'); return; }
  try {
    var r = await fetch('/admin/combos', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k }, body: JSON.stringify({ name: name, models: models }) });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) { toast('gagal: ' + (d.error || r.status), 'err'); return; }
    document.getElementById('ft-cname').value = '';
    document.getElementById('ft-cmodels').value = '';
    loaded.models = false;
    loadFeatures(); loadModels();
    toast('combo ' + name + ' disimpan ', 'ok');
  } catch (e) { toast('gagal: ' + e, 'err'); }
}
async function delComboF(n) {
  var k = admKey(); if (!k) return;
  if (!confirm('hapus combo ' + n + '?')) return;
  try {
    await fetch('/admin/combos/' + encodeURIComponent(n), { method: 'DELETE', headers: { Authorization: 'Bearer ' + k } });
    loaded.models = false;
    loadFeatures(); loadModels();
    toast('combo ' + n + ' dihapus', 'ok');
  } catch (e) { toast('gagal: ' + e, 'err'); }
}
async function saveMapF(kind) {
  var k = admKey(); if (!k) return;
  var ta = document.getElementById(kind === 'fb' ? 'ft-fb' : 'ft-rr');
  var obj;
  try { obj = JSON.parse(ta.value || '{}'); } catch (e) { toast('JSON tidak valid', 'err'); return; }
  try {
    var r = await fetch(kind === 'fb' ? '/admin/fallbacks' : '/admin/round-robin', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify(kind === 'fb' ? { fallbacks: obj } : { pools: obj })
    });
    var d = await r.json().catch(function () { return {}; });
    if (r.ok) { loaded.models = false; loadModels(); toast('tersimpan ', 'ok'); }
    else toast('gagal: ' + (d.error || r.status), 'err');
  } catch (e) { toast('gagal: ' + e, 'err'); }
}
async function delProvider(id) {
  var k = admKey(); if (!k) return;
  if (!confirm('hapus provider ' + id + '?')) return;
  await fetch('/admin/providers/' + encodeURIComponent(id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + k } });
  loaded.providers = false; loaded.models = false;
  loadProviders(); loadModels();
  toast('provider ' + id + ' dihapus', 'ok');
}
async function testProvider(id) {
  var k = admKey(); if (!k) return;
  toast('testing ' + id + '…');
  try {
    var r = await fetch('/admin/providers/' + encodeURIComponent(id) + '/test', { method: 'POST', headers: { Authorization: 'Bearer ' + k } });
    var d = await r.json().catch(function () { return {}; });
    toast('test ' + id + ': HTTP ' + (d.http != null ? d.http : '?') + (d.models_count != null ? ' · ' + d.models_count + ' model' : ''), d.ok ? 'ok' : 'err');
  } catch (e) { toast('gagal: ' + e, 'err'); }
}
// ---- connect (endpoint + key ala 9router) ----
function syncConn() {
  var k = document.getElementById('key').value || '';
  document.getElementById('conn-base').value = location.origin + '/v1';
  document.getElementById('conn-key').value = k;
  document.getElementById('conn-example').textContent =
    'from openai import OpenAI\\n' +
    'client = OpenAI(base_url="' + location.origin + '/v1", api_key="YOUR_API_KEY")\\n' +
    'r = client.chat.completions.create(model="oc/mimo-v2.6-flash-free",\\n' +
    '    messages=[{"role": "user", "content": "hi"}])\\n' +
    'print(r.choices[0].message.content)';
}
async function changeDashPass() {
  var k = admKey(); if (!k) return;
  var o = document.getElementById('pw-old').value;
  var n = document.getElementById('pw-new').value;
  if (!o || !n) { toast('isi password lama + baru', 'err'); return; }
  if (n.length < 4) { toast('password baru minimal 4 karakter', 'err'); return; }
  try {
    var r = await fetch('/admin/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify({ old_password: o, new_password: n }),
    });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) { toast('gagal: ' + (d.error || r.status), 'err'); return; }
    document.getElementById('pw-old').value = '';
    document.getElementById('pw-new').value = '';
    toast('password diganti  silakan login ulang', 'ok');
    setTimeout(function () { location.href = '/login'; }, 1200);
  } catch (e) { toast('gagal: ' + e, 'err'); }
}
function dashLogout() {
  fetch('/logout', { method: 'POST' }).finally(function () { location.href = '/login'; });
}
function copyText(t) {
  var done = function () {};
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, function () { fallbackCopy(t); });
  } else fallbackCopy(t);
}
function fallbackCopy(t) {
  var ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  ta.remove();
}
function toggleConnKey(btn) {
  var el = document.getElementById('conn-key');
  var show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  if (btn) btn.textContent = show ? 'hide' : 'show';
}
function copyConn(which) {
  var el = document.getElementById(which === 'base' ? 'conn-base' : 'conn-key');
  copyText(el.value);
  toast('copied ', 'ok');
}
async function rotateKey() {
  var k = admKey(); if (!k) return;
  if (!confirm('rotate API key? key lama langsung mati.')) return;
  try {
    var r = await fetch('/admin/rotate-key', { method: 'POST', headers: { Authorization: 'Bearer ' + k } });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    document.getElementById('key').value = d.api_key;
    saveKey(); syncConn();
    toast('key baru aktif  update client yang pakai key lama', 'ok');
  } catch (e) { toast('gagal: ' + e, 'err'); }
}
</script></body></html>
`;

// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const client = req.socket.remoteAddress || '?';
  res.on('finish', () => {
    console.log(`${client} ${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - t0}ms`);
  });
  try {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      });
      res.end();
      return;
    }
    // ---- dashboard password (ala 9router) ----
    if (req.method === 'GET' && p === '/login') {
      const bad = url.searchParams.get('err') ? '<div class="err">password salah, coba lagi </div>' : '';
      sendText(res, 200, LOGIN_HTML.replace('__ERR__', bad), 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'POST' && p === '/login') {
      const raw = await readBody(req);
      let pw = '';
      try {
        const j = JSON.parse(raw || '{}');
        pw = String(j.password || '');
      } catch {
        const m = /(?:^|&)password=([^&]*)/.exec(raw || '');
        if (m) try { pw = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch {}
      }
      if (pw && dashPassHash(pw) === config.dashboard_password_hash) {
        const tok = crypto.randomBytes(32).toString('hex');
        dashSessions.set(tok, Date.now() + DASH_SESSION_TTL);
        res.writeHead(302, { Location: '/', 'Set-Cookie': dashLoginCookie(tok) });
        res.end();
      } else {
        res.writeHead(302, { Location: '/login?err=1' });
        res.end();
      }
      return;
    }
    if (req.method === 'POST' && p === '/logout') {
      const t = parseCookies(req)['rr_auth'];
      if (t) dashSessions.delete(t);
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'rr_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      res.end();
      return;
    }
    // dashboard web + asset butuh login; API (/v1, /admin, /health) tetap pakai API key.
    // /ref/avatar.jpg publik supaya halaman login bisa memakainya
    if ((p === '/' || (p.startsWith('/ref/') && p !== '/ref/avatar.jpg')) && !dashAuthed(req)) {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
    if (req.method === 'GET' && p === '/') {
      const html = DASHBOARD.replace('__PREFILL__', escHtml(API_KEY));
      sendText(res, 200, html, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && p.startsWith('/ref/')) {
      const fp = path.normalize(path.join(HERE, 'public', p));
      if (!fp.startsWith(path.join(HERE, 'public') + path.sep)) { sendJson(res, 403, { error: 'forbidden' }); return; }
      fs.readFile(fp, (err, data) => {
        if (err) { sendJson(res, 404, { error: 'not found' }); return; }
        const ext = path.extname(fp).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
        res.end(data);
      });
      return;
    }
    if (req.method === 'GET' && p === '/health') {
      sendJson(res, 200, { ok: true, pools: activePools().length, strategy: STRATEGY, runtime: 'node' });
      return;
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/api/v1/models')) {
      const ids = await getModelIds();
      const now = Math.floor(Date.now() / 1000);
      sendJson(res, 200, {
        object: 'list',
        data: ids.map(m => ({ id: m.id, object: 'model', created: now, owned_by: m.owned_by || 'oc', caps: getModelCaps(m.id) })),
      });
      return;
    }
    if (req.method === 'POST' && p === '/v1/chat/completions') {
      if (!needAuth(req, res)) return;
      let payload;
      try {
        payload = JSON.parse(await readBody(req) || '{}');
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const modelId = payload.model || '';
      const stream = Boolean(payload.stream);
      let candidates;
      try {
        candidates = resolveCandidates(modelId);
      } catch (e) {
        sendJson(res, e.status || 400, { error: String((e && e.message) || e) });
        return;
      }
      let relay, resp, logId = null, usedModel = modelId, usedProvider = 'opencode', rtkStats = null, visionStripped = 0, cavemanOn = false;
      let lastErr = null;
      for (const cand of candidates) {
        const [providerName, bare] = resolveProvider(cand);
        // clone per kandidat: transform RTK/caveman/vision tidak bocor antar kandidat
        let p2;
        try { p2 = JSON.parse(JSON.stringify(payload)); } catch { p2 = { ...payload }; }
        p2.model = cand;
        if (Array.isArray(p2.messages)) {
          if (config.rtk_enabled) {
            const st = rtkCompressMessages(p2.messages);
            if (st && st.hits.length) {
              rtkStats = st;
              lastRtkStats = { ts: Date.now(), model: cand, before: st.before, after: st.after, hits: st.hits.map(h => h.filter + ':' + h.saved + 'B') };
            }
          }
          if (config.vision_strip && isNoVisionModel(cand, bare)) visionStripped += stripVisionImages(p2.messages);
          if (config.caveman_enabled) { injectCaveman(p2.messages, config.caveman_level); cavemanOn = true; }
        }
        try {
          [relay, resp, logId] = await upstreamTry(providerName, bare, p2);
          usedModel = cand;
          usedProvider = providerName;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (!isRetryableUpstream(e)) break; // error permanen: jangan buang kandidat
        }
      }
      if (lastErr) {
        sendJson(res, lastErr.status || 502, { error: String((lastErr && lastErr.message) || lastErr), tried: candidates });
        return;
      }
      const featHeaders = {
        'X-Model': usedModel,
        ...(rtkStats ? { 'X-RTK-Saved': String(rtkStats.before - rtkStats.after) } : {}),
        ...(visionStripped ? { 'X-Vision-Stripped': String(visionStripped) } : {}),
        ...(cavemanOn ? { 'X-Caveman': config.caveman_level } : {}),
      };
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Relay': relay,
          'X-Provider': usedProvider,
          ...featHeaders,
        });
        let sseBuf = '';
        try {
          for await (const chunk of resp.body) {
            sseBuf += Buffer.from(chunk).toString('utf8');
            if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
          }
        } catch {}
        res.end();
        try { await resp.arrayBuffer(); } catch {}
        // usage biasanya di chunk terakhir stream; pakai upstream bila masuk akal
        try {
          const uw2 = extractUsage(sseBuf.slice(-8000));
          let pt2 = Number(uw2.pt ?? 0) || 0, ct2 = Number(uw2.ct ?? 0) || 0;
          let inChars = 0;
          for (const m of (payload.messages || [])) {
            const c = m.content;
            inChars += typeof c === 'string' ? c.length : JSON.stringify(c || '').length;
          }
          const estPt2 = Math.round(inChars / 4), estCt2 = Math.round(sseBuf.length / 6);
          if (!pt2 || !ct2 || pt2 < estPt2 / 3 || pt2 > estPt2 * 3 || ct2 < estCt2 / 3 || ct2 > estCt2 * 3) { pt2 = estPt2; ct2 = estCt2; }
          if (pt2 || ct2) logUseTokens(logId, pt2, ct2, Number(uw2.cached ?? 0) || 0);
        } catch {}
        return;
      }
      const sseText = await resp.text().catch(() => '');
      let [text, chunks, finish] = collectSseText(sseText);
      let upUsage = null;
      if (!text.trim()) {
        // provider custom bisa balas JSON polos (bukan SSE) untuk non-stream
        try {
          const j = JSON.parse(sseText);
          const ch = (j.choices || [{}])[0];
          text = (ch.message && ch.message.content) || '';
          finish = ch.finish_reason || 'stop';
          chunks = 1;
          upUsage = j.usage || null;
        } catch {}
      }
      if (!text.trim()) {
        sendJson(res, 502, { error: `upstream empty stream via ${relay} (chunks=${chunks} finish=${finish})` });
        return;
      }
      const uw = upUsage || extractUsage(sseText.slice(-8000));
      const uwc = (uw.prompt_tokens_details && uw.prompt_tokens_details.cached_tokens) ?? uw.cached_tokens ?? uw.cached;
      let u = {
        pt: Number(uw.pt ?? uw.prompt_tokens ?? uw.input_tokens ?? 0) || 0,
        ct: Number(uw.ct ?? uw.completion_tokens ?? uw.output_tokens ?? 0) || 0,
        cached: Number(uwc ?? 0) || 0,
      };
      // estimasi kasar dari panjang teks (±4 char/token) untuk sanity check
      let estPt = 0, estCt = 0;
      try {
        let inChars = 0;
        for (const m of (payload.messages || [])) {
          const c = m.content;
          inChars += typeof c === 'string' ? c.length : JSON.stringify(c || '').length;
        }
        estPt = Math.round(inChars / 4);
        estCt = Math.round(text.length / 4);
      } catch {}
      // pakai upstream bila masuk akal; bila tidak ada / ngaco, pakai estimasi
      // (toleransi 3x: upstream yang meleset >3x dari estimasi dianggap ngaco)
      if (!u.pt || !u.ct || u.pt < estPt / 3 || u.pt > estPt * 3 || u.ct < estCt / 3 || u.ct > estCt * 3) {
        u = { pt: estPt, ct: estCt, cached: 0, est: true };
      }
      if (u.pt || u.ct) logUseTokens(logId, u.pt, u.ct, u.cached);
      sendJson(res, 200, {
        id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish || 'stop' }],
        usage: { prompt_tokens: u.pt, completion_tokens: u.ct, total_tokens: u.pt + u.ct },
      }, { 'X-Relay': relay, ...featHeaders });
      return;
    }
    if (req.method === 'GET' && p === '/admin/usage') {
      if (!needAuth(req, res)) return;
      const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
      const period = String(url.searchParams.get('period') || '7d');
      sendJson(res, 200, buildUsage(days, period));
      return;
    }
    if (req.method === 'GET' && p === '/admin/stats') {
      if (!needAuth(req, res)) return;
      const pools = db.prepare('SELECT COUNT(*) c FROM pools WHERE isActive=1').get().c;
      const rows = db.prepare('SELECT status, COUNT(*) c FROM usage_log WHERE ts > ? GROUP BY status')
        .all(Math.floor(Date.now() / 1000) - 86400);
      const usage = {};
      for (const r of rows) usage[String(r.status)] = r.c;
      sendJson(res, 200, { pools_active: pools, strategy: STRATEGY, usage_24h: usage, runtime: 'node' });
      return;
    }
    // ---- custom providers ----
    function publicProvider(c) {
      return {
        id: String(c.id), name: String(c.name || c.id),
        base_url: String(c.base_url || ''),
        models: Array.isArray(c.models) ? c.models : [],
        enabled: c.enabled !== false,
        api_key_set: Boolean(c.api_key),
        keys: normStrArr(c.api_keys).map(maskKey),
        keys_count: normStrArr(c.api_keys).length,
      };
    }
    function findCustomProvider(id) {
      const low = String(id || '').toLowerCase();
      return customProviderDefs().find(x => String(x.id || '').toLowerCase() === low) || null;
    }
    if (req.method === 'GET' && p === '/admin/providers') {
      if (!needAuth(req, res)) return;
      sendJson(res, 200, { providers: customProviderDefs().map(publicProvider) });
      return;
    }
    if (req.method === 'POST' && p === '/admin/providers') {
      if (!needAuth(req, res)) return;
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const id = String(body.id || '').toLowerCase().trim();
      const name = String(body.name || id).trim();
      const base_url = String(body.base_url || '').trim().replace(/\/+$/, '');
      let models = Array.isArray(body.models) ? body.models.map(m => String(m).trim()).filter(Boolean) : [];
      if (!/^https?:\/\//.test(base_url)) { sendJson(res, 400, { error: 'base_url harus http(s)://...' }); return; }
      if (!Array.isArray(config.custom_providers)) config.custom_providers = [];
      const keys = normStrArr(body.api_keys && body.api_keys.length ? body.api_keys : (body.api_key ? [body.api_key] : []));
      // smart merge ala 9router: base_url sudah terdaftar -> cukup tambah key ke provider itu,
      // tidak perlu bikin provider baru. Satu base_url bisa pegang banyak key (rotasi otomatis).
      const sameUrl = config.custom_providers.find(x => String(x.base_url || '').replace(/\/+$/, '') === base_url);
      if (sameUrl && String(sameUrl.id || '').toLowerCase() !== id && keys.length) {
        const cur = normProviderKeys(sameUrl);
        let added = 0;
        for (const kk of keys) if (!cur.includes(kk)) { cur.push(kk); added++; }
        if (models.length) {
          const ms = new Set(Array.isArray(sameUrl.models) ? sameUrl.models : []);
          for (const m of models) ms.add(m);
          sameUrl.models = [...ms];
        }
        normProviderKeys(sameUrl);
        saveConfig(); rebuildProviders();
        sendJson(res, 200, { ok: true, merged: true, added_keys: added, provider: publicProvider(sameUrl) });
        return;
      }
      if (!validCustomId(id)) { sendJson(res, 400, { error: 'invalid id (a-z, 0-9, -, maks 31, bukan "oc")' }); return; }
      // auto-detect: models kosong -> tarik dari upstream /models (ala 9router)
      let detected = 0;
      if (!models.length) {
        try {
          const r = await fetch(base_url + '/models', {
            headers: { ...(keys[0] ? { Authorization: 'Bearer ' + keys[0] } : {}) },
            signal: AbortSignal.timeout(15000),
          });
          if (r.ok) {
            const j = await r.json().catch(() => null);
            const d = j && (Array.isArray(j) ? j : (j.data || []));
            models = [...new Set((Array.isArray(d) ? d : []).map(x => String((x && (x.id || x.name)) || '').trim()).filter(Boolean))];
            detected = models.length;
          }
        } catch {}
        if (!models.length) { sendJson(res, 400, { error: 'gagal auto-detect models dari upstream — isi manual atau cek base_url/key' }); return; }
      }
      const rec = { id, name, base_url, api_key: keys[0] || '', api_keys: keys, models, enabled: body.enabled !== false };
      const i = config.custom_providers.findIndex(x => String(x.id || '').toLowerCase() === id);
      if (i >= 0) {
        // update: pertahankan keys lama bila tidak dikirim
        if (!body.api_keys && !body.api_key) { rec.api_keys = normProviderKeys(config.custom_providers[i]); rec.api_key = rec.api_keys[0] || ''; }
        config.custom_providers[i] = { ...config.custom_providers[i], ...rec };
      } else config.custom_providers.push(rec);
      saveConfig(); rebuildProviders();
      sendJson(res, 200, { ok: true, detected, provider: publicProvider(config.custom_providers.find(x => String(x.id || '').toLowerCase() === id)) });
      return;
    }
    // PATCH: rename / ganti base_url / enable-disable
    if (req.method === 'PATCH' && /^\/admin\/providers\/[^/]+$/.test(p)) {
      if (!needAuth(req, res)) return;
      const c = findCustomProvider(decodeURIComponent(p.split('/')[3]));
      if (!c) { sendJson(res, 404, { error: 'provider tidak ditemukan' }); return; }
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      if (typeof body.name === 'string' && body.name.trim()) c.name = body.name.trim().slice(0, 80);
      if (typeof body.base_url === 'string' && body.base_url.trim()) {
        const b = body.base_url.trim().replace(/\/+$/, '');
        if (!/^https?:\/\//.test(b)) { sendJson(res, 400, { error: 'base_url harus http(s)://...' }); return; }
        c.base_url = b;
      }
      if (typeof body.enabled === 'boolean') c.enabled = body.enabled;
      saveConfig(); rebuildProviders();
      sendJson(res, 200, { ok: true, provider: publicProvider(c) });
      return;
    }
    // POST /admin/providers/:id/keys — tambah API key
    if (req.method === 'POST' && /^\/admin\/providers\/[^/]+\/keys$/.test(p)) {
      if (!needAuth(req, res)) return;
      const c = findCustomProvider(decodeURIComponent(p.split('/')[3]));
      if (!c) { sendJson(res, 404, { error: 'provider tidak ditemukan' }); return; }
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      const key = String(body.key || '').trim();
      if (key.length < 4) { sendJson(res, 400, { error: 'key terlalu pendek' }); return; }
      const keys = normProviderKeys(c);
      if (keys.includes(key)) { sendJson(res, 400, { error: 'key sudah ada' }); return; }
      keys.push(key);
      normProviderKeys(c);
      saveConfig(); rebuildProviders();
      sendJson(res, 200, { ok: true, provider: publicProvider(c) });
      return;
    }
    // DELETE /admin/providers/:id/keys/:idx — hapus API key by index
    if (req.method === 'DELETE' && /^\/admin\/providers\/[^/]+\/keys\/\d+$/.test(p)) {
      if (!needAuth(req, res)) return;
      const c = findCustomProvider(decodeURIComponent(p.split('/')[3]));
      if (!c) { sendJson(res, 404, { error: 'provider tidak ditemukan' }); return; }
      const idx = parseInt(p.split('/')[5], 10);
      const keys = normProviderKeys(c);
      if (idx < 0 || idx >= keys.length) { sendJson(res, 404, { error: 'key tidak ditemukan' }); return; }
      keys.splice(idx, 1);
      normProviderKeys(c);
      saveConfig(); rebuildProviders();
      sendJson(res, 200, { ok: true, provider: publicProvider(c) });
      return;
    }
    // POST /admin/providers/:id/models — tambah 1 model
    if (req.method === 'POST' && /^\/admin\/providers\/[^/]+\/models$/.test(p)) {
      if (!needAuth(req, res)) return;
      const c = findCustomProvider(decodeURIComponent(p.split('/')[3]));
      if (!c) { sendJson(res, 404, { error: 'provider tidak ditemukan' }); return; }
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      const m = String(body.model || '').trim();
      if (!m) { sendJson(res, 400, { error: 'model wajib diisi' }); return; }
      c.models = Array.isArray(c.models) ? c.models : [];
      if (c.models.includes(m)) { sendJson(res, 400, { error: 'model sudah ada' }); return; }
      c.models.push(m);
      saveConfig(); rebuildProviders();
      sendJson(res, 200, { ok: true, provider: publicProvider(c) });
      return;
    }
    // DELETE /admin/providers/:id/models/:model — hapus 1 model
    if (req.method === 'DELETE' && /^\/admin\/providers\/[^/]+\/models\/.+$/.test(p)) {
      if (!needAuth(req, res)) return;
      const parts = p.split('/');
      const c = findCustomProvider(decodeURIComponent(parts[3]));
      if (!c) { sendJson(res, 404, { error: 'provider tidak ditemukan' }); return; }
      const m = decodeURIComponent(parts.slice(5).join('/'));
      c.models = (Array.isArray(c.models) ? c.models : []).filter(x => x !== m);
      if (!c.models.length) { sendJson(res, 400, { error: 'provider harus punya minimal 1 model' }); return; }
      saveConfig(); rebuildProviders();
      sendJson(res, 200, { ok: true, provider: publicProvider(c) });
      return;
    }
    // POST /admin/providers/:id/refresh — tarik ulang daftar model dari upstream /models
    if (req.method === 'POST' && /^\/admin\/providers\/[^/]+\/refresh$/.test(p)) {
      if (!needAuth(req, res)) return;
      const c = findCustomProvider(decodeURIComponent(p.split('/')[3]));
      if (!c) { sendJson(res, 404, { error: 'provider tidak ditemukan' }); return; }
      const burl = String(c.base_url || '').replace(/\/+$/, '');
      const keys = normProviderKeys(c);
      try {
        const r = await fetch(burl + '/models', {
          headers: { ...(keys[0] ? { Authorization: 'Bearer ' + keys[0] } : {}) },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) { sendJson(res, 200, { ok: false, http: r.status }); return; }
        const j = await r.json().catch(() => null);
        const d = j && (Array.isArray(j) ? j : (j.data || []));
        const ids = (Array.isArray(d) ? d : []).map(x => String((x && (x.id || x.name)) || '').trim()).filter(Boolean);
        if (!ids.length) { sendJson(res, 200, { ok: false, error: 'tidak ada model di upstream' }); return; }
        c.models = [...new Set(ids)];
        saveConfig(); rebuildProviders();
        sendJson(res, 200, { ok: true, count: c.models.length, provider: publicProvider(c) });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String((e && e.message) || e).slice(0, 200) });
      }
      return;
    }
    if (req.method === 'DELETE' && p.startsWith('/admin/providers/') && !p.endsWith('/test')) {
      if (!needAuth(req, res)) return;
      const id = decodeURIComponent(p.slice('/admin/providers/'.length)).toLowerCase();
      const arr = customProviderDefs();
      const i = arr.findIndex(x => String(x.id || '').toLowerCase() === id);
      if (i < 0) { sendJson(res, 404, { error: 'provider tidak ditemukan' }); return; }
      arr.splice(i, 1);
      saveConfig(); rebuildProviders();
      sendJson(res, 200, { ok: true, deleted: id });
      return;
    }
    if (req.method === 'POST' && /^\/admin\/providers\/[^/]+\/test$/.test(p)) {
      if (!needAuth(req, res)) return;
      const id = decodeURIComponent(p.split('/')[3]).toLowerCase();
      const c = customProviderDefs().find(x => String(x.id || '').toLowerCase() === id);
      if (!c) { sendJson(res, 404, { error: 'provider tidak ditemukan' }); return; }
      const burl = String(c.base_url || '').replace(/\/+$/, '');
      const tkeys = normProviderKeys(c);
      try {
        const r = await fetch(burl + '/models', {
          headers: { ...(tkeys[0] ? { Authorization: 'Bearer ' + tkeys[0] } : {}) },
          signal: AbortSignal.timeout(12000),
        });
        const t = await r.text().catch(() => '');
        let count = null;
        try {
          const j = JSON.parse(t);
          const d = Array.isArray(j) ? j : (j.data || []);
          if (Array.isArray(d)) count = d.length;
        } catch {}
        sendJson(res, 200, { ok: r.ok, http: r.status, models_count: count, sample: t.slice(0, 200) });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String((e && e.message) || e).slice(0, 200) });
      }
      return;
    }
    // relay pool per provider (ala 9router)
    if (req.method === 'GET' && p === '/admin/relay') {
      if (!needAuth(req, res)) return;
      const provs = [{ id: 'oc', name: 'opencode' }];
      for (const c of customProviderDefs()) provs.push({ id: String(c.id).toLowerCase(), name: c.name || c.id });
      sendJson(res, 200, {
        ok: true,
        pools_active: activePools().length,
        pools_available: availablePools().length,
        quarantined: quarantineList(),
        global_strategy: STRATEGY,
        providers: provs.map(x => ({
          id: x.id, name: x.name,
          mode: String((config.provider_relay && config.provider_relay[x.id]) || 'default'),
          effective: providerRelayMode(x.id),
        })),
      });
      return;
    }
    if (req.method === 'POST' && p === '/admin/relay') {
      if (!needAuth(req, res)) return;
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      if (body.global_strategy) {
        const s = String(body.global_strategy);
        if (!['random', 'round-robin', 'first'].includes(s)) { sendJson(res, 400, { error: 'strategi: random|round-robin|first' }); return; }
        STRATEGY = s;
        config.rotate_strategy = s;
      }
      if (body.provider) {
        const pid = String(body.provider).toLowerCase();
        const mode = String(body.mode || 'default');
        if (!RELAY_MODES.includes(mode)) { sendJson(res, 400, { error: 'mode: ' + RELAY_MODES.join('|') }); return; }
        if (!config.provider_relay) config.provider_relay = {};
        if (mode === 'default') delete config.provider_relay[pid];
        else config.provider_relay[pid] = mode;
      }
      if (body.clear_quarantine) { // url relay spesifik, atau '*' = semua
        const u = String(body.clear_quarantine);
        if (u === '*') { try { db.exec('DELETE FROM relay_cooldowns'); } catch {} }
        else clearRelayQuarantine(u);
      }
      saveConfig();
      sendJson(res, 200, { ok: true, global_strategy: STRATEGY, provider_relay: config.provider_relay });
      return;
    }
    // speed test: ukur latency per model per provider (bantu pilih model tercepat/stabil)
    if (req.method === 'POST' && p === '/admin/benchmark') {
      if (!needAuth(req, res)) return;
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      const provFilter = normStrArr(body.providers).map(s => s.toLowerCase());
      const perProv = Math.min(Math.max(parseInt(body.models_per_provider) || 1, 1), 10);
      const runs = Math.min(Math.max(parseInt(body.runs) || 2, 1), 3);
      const prompt = String(body.prompt || 'Balas dengan satu kata: ok').slice(0, 500);
      const all = await getModelIds();
      const groups = {};
      for (const m of all) {
        const ob = String(m.owned_by || 'oc');
        if (ob === 'combo' || ob === 'round-robin') continue;
        const prov = ob === 'opencode' ? 'oc' : ob;
        if (provFilter.length && !provFilter.includes(prov)) continue;
        (groups[prov] = groups[prov] || []).push(m.id);
      }
      const targets = [];
      for (const ids of Object.values(groups)) targets.push(...ids.slice(0, perProv));
      if (!targets.length) { sendJson(res, 400, { error: 'tidak ada model untuk di-test' }); return; }
      const results = [];
      for (const mid of targets) {
        const lat = [];
        let okN = 0, failN = 0, sample = '', lastErr = '';
        for (let i = 0; i < runs; i++) {
          const t0 = Date.now();
          try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
              body: JSON.stringify({ model: mid, messages: [{ role: 'user', content: prompt }], max_tokens: 16, temperature: 0, stream: false }),
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const ms = Date.now() - t0;
            const j = await r.json().catch(() => null);
            const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            if (r.ok && content) {
              okN++; lat.push(ms);
              sample = String(content).slice(0, 80);
            } else { failN++; lastErr = String((j && j.error) || ('HTTP ' + r.status)).slice(0, 120); }
          } catch (e) { failN++; lastErr = String((e && e.message) || e).slice(0, 120); }
        }
        lat.sort((a, b) => a - b);
        results.push({
          model: mid,
          provider: mid.split('/')[0],
          runs: runs, ok: okN, fail: failN,
          avg_ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
          min_ms: lat.length ? lat[0] : null,
          max_ms: lat.length ? lat[lat.length - 1] : null,
          sample: sample,
          last_error: (failN && !okN) ? lastErr : undefined,
        });
      }
      results.sort((a, b) => ((b.ok / b.runs) - (a.ok / a.runs)) || ((a.avg_ms == null ? 1e12 : a.avg_ms) - (b.avg_ms == null ? 1e12 : b.avg_ms)));
      sendJson(res, 200, { ok: true, prompt: prompt, results: results });
      return;
    }
    if (req.method === 'POST' && p === '/admin/change-password') {      if (!needAuth(req, res)) return;
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      if (dashPassHash(body.old_password || '') !== config.dashboard_password_hash) {
        sendJson(res, 401, { error: 'password lama salah' });
        return;
      }
      const np = String(body.new_password || '');
      if (np.length < 4) { sendJson(res, 400, { error: 'password baru minimal 4 karakter' }); return; }
      config.dashboard_password_hash = dashPassHash(np);
      dashSessions.clear(); // paksa login ulang di semua sesi
      saveConfig();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && p === '/admin/rotate-key') {
      if (!needAuth(req, res)) return;
      const fresh = 'rr-' + crypto.randomBytes(16).toString('hex');
      config.api_key = fresh;
      API_KEY = fresh;
      saveConfig();
      sendJson(res, 200, { api_key: fresh });
      return;
    }
    // ---- 9router-style features ----
    function publicFeatures() {
      return {
        rtk_enabled: config.rtk_enabled === true,
        caveman_enabled: config.caveman_enabled === true,
        caveman_level: config.caveman_level || 'full',
        vision_strip: config.vision_strip !== false,
        no_vision_models: normStrArr(config.no_vision_models),
        combos: normModelMap(config.combos),
        fallbacks: normModelMap(config.fallbacks),
        round_robin: normModelMap(config.round_robin),
        last_rtk: lastRtkStats,
      };
    }
    if (req.method === 'GET' && p === '/admin/features') {
      if (!needAuth(req, res)) return;
      sendJson(res, 200, publicFeatures());
      return;
    }
    if (req.method === 'PUT' && p === '/admin/features') {
      if (!needAuth(req, res)) return;
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      if (typeof body.rtk_enabled === 'boolean') config.rtk_enabled = body.rtk_enabled;
      if (typeof body.caveman_enabled === 'boolean') config.caveman_enabled = body.caveman_enabled;
      if (['lite', 'full', 'ultra'].includes(body.caveman_level)) config.caveman_level = body.caveman_level;
      if (typeof body.vision_strip === 'boolean') config.vision_strip = body.vision_strip;
      if (body.no_vision_models !== undefined) config.no_vision_models = normStrArr(body.no_vision_models);
      applyFeatureDefaults(); saveConfig();
      sendJson(res, 200, publicFeatures());
      return;
    }
    function validVirtualName(n) {
      return typeof n === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(n);
    }
    function validModelList(arr) {
      const list = normStrArr(arr).filter(m => !m.startsWith('combo/') && !m.startsWith('rr/'));
      return list.length ? list : null;
    }
    // ---- version / update check (ala 9router /api/version) ----
    if (req.method === 'GET' && p === '/admin/version') {
      if (!needAuth(req, res)) return;
      sendJson(res, 200, await getVersionInfo());
    }
    if (req.method === 'GET' && p === '/admin/combos') {
      if (!needAuth(req, res)) return;
      sendJson(res, 200, { combos: normModelMap(config.combos) });
      return;
    }
    if (req.method === 'POST' && p === '/admin/combos') {
      if (!needAuth(req, res)) return;
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      const name = String(body.name || '').toLowerCase().trim();
      const models = validModelList(body.models);
      if (!validVirtualName(name)) { sendJson(res, 400, { error: 'nama combo invalid (a-z, 0-9, -, maks 31)' }); return; }
      if (!models) { sendJson(res, 400, { error: 'models tidak boleh kosong' }); return; }
      config.combos[name] = models;
      applyFeatureDefaults(); saveConfig(); modelsCache.ts = 0;
      sendJson(res, 200, { ok: true, combo: name, models });
      return;
    }
    if (req.method === 'DELETE' && p.startsWith('/admin/combos/')) {
      if (!needAuth(req, res)) return;
      const name = decodeURIComponent(p.slice('/admin/combos/'.length)).toLowerCase();
      if (!config.combos[name]) { sendJson(res, 404, { error: 'combo tidak ditemukan' }); return; }
      delete config.combos[name];
      applyFeatureDefaults(); saveConfig(); modelsCache.ts = 0;
      sendJson(res, 200, { ok: true, deleted: name });
      return;
    }
    if (req.method === 'PUT' && p === '/admin/fallbacks') {
      if (!needAuth(req, res)) return;
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      const map = {};
      for (const [k, v] of Object.entries(body.fallbacks || body || {})) {
        const list = validModelList(v);
        if (String(k).trim() && list) map[String(k).trim()] = list;
      }
      config.fallbacks = map;
      applyFeatureDefaults(); saveConfig();
      sendJson(res, 200, { ok: true, fallbacks: config.fallbacks });
      return;
    }
    if (req.method === 'PUT' && p === '/admin/round-robin') {
      if (!needAuth(req, res)) return;
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      const map = {};
      for (const [k, v] of Object.entries(body.pools || body || {})) {
        const name = String(k).toLowerCase().trim();
        const list = validModelList(v);
        if (validVirtualName(name) && list) map[name] = list;
      }
      config.round_robin = map;
      applyFeatureDefaults(); saveConfig(); modelsCache.ts = 0;
      sendJson(res, 200, { ok: true, round_robin: config.round_robin });
      return;
    }
    if (req.method === 'POST' && p === '/admin/regen-session') {
      if (!needAuth(req, res)) return;
      const fresh = freshSession();
      config.headers_fix = config.headers_fix || {};
      config.headers_fix['x-opencode-session'] = fresh;
      HEADERS_FIX = config.headers_fix;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      sendJson(res, 200, { 'x-opencode-session': fresh });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    try { sendJson(res, 500, { error: String((e && e.message) || e) }); } catch {}
  }
});

const n = initDb();
if (n === 0) {
  const [added, msg] = importFrom9router();
  console.log(`imported ${added} pools from 9router (${msg})`);
}
const PORT = config.port || 20129;
server.on('connection', (sock) => {
  try {
    console.log(`[tcp] conn ${sock.remoteAddress}:${sock.remotePort} -> ${sock.localAddress}:${sock.localPort}`);
  } catch {}
});
server.on('clientError', (err, sock) => {
  try { console.log(`[tcp] clientError ${err && err.message}`); } catch {}
  try { sock.destroy(); } catch {}
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`rerouter-js on :${PORT} pools=${activePools().length} strategy=${STRATEGY}`);
});
