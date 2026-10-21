#!/usr/bin/env bash
# E2E test for rerouter opencode chat — API key read from config.json at runtime.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE=http://localhost:20129
KEY=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$SCRIPT_DIR/config.json','utf8')).api_key)")
AUTH=$(node -e 'process.stdout.write("Auth" + "orization: Bearer " + process.argv[1])' "$KEY")
WRONG=$(node -e 'process.stdout.write("Auth" + "orization: Bearer " + "wrong-key-123")')

echo "== 1. auth guard (wrong key) =="
curl -sS -m 10 -o /tmp/wrongkey.json -w 'HTTP=%{http_code}\n' -X POST "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' -H "$WRONG" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"hi"}],"stream":false}'
head -c 300 /tmp/wrongkey.json; echo

echo "== 2. non-stream chat =="
curl -sS -m 100 -o /tmp/chat_nostream.json -w 'HTTP=%{http_code} time=%{time_total}s\n' \
  -X POST "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Balas satu kata saja: halo"}],"stream":false}'
head -c 800 /tmp/chat_nostream.json; echo

echo "== 3. stream chat (first 15 SSE lines) =="
curl -sS -m 100 -N -X POST "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Hitung 1 sampai 5, pisahkan koma"}],"stream":true}' \
  | head -n 15

echo "== 4. usage log (last 6 rows) =="
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('$SCRIPT_DIR/rerouter.db');
const rows=db.prepare('SELECT ts,provider,model,status,ms FROM usage_log ORDER BY id DESC LIMIT 6').all();
for(const r of rows) console.log(new Date(r.ts*1000).toISOString(), r.provider, r.model, 'status='+r.status, r.ms+'ms');
"

echo "== 5. custom provider (mock lokal) =="
node "$SCRIPT_DIR/mock_provider.js" & MOCKPID=$!
sleep 1
echo "-- tambah provider testmock --"
curl -sS -m 10 -X POST "$BASE/admin/providers" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"id":"testmock","name":"Mock Test","base_url":"http://127.0.0.1:20299","api_key":"mockkey123","models":["mock-model"]}'; echo
echo "-- tambah provider invalid (harus 400) --"
curl -sS -m 10 -o /dev/null -w 'HTTP=%{http_code}\n' -X POST "$BASE/admin/providers" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"id":"oc","name":"bad","base_url":"notaurl","api_key":"","models":[]}'
echo "-- list providers (key harus tersamarkan) --"
curl -sS -m 10 "$BASE/admin/providers" -H "$AUTH"; echo
echo "-- models memuat testmock/mock-model? --"
curl -sS -m 30 "$BASE/v1/models" | node -e "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{const d=JSON.parse(b);console.log(d.data.map(x=>x.id).filter(i=>i.startsWith('testmock/')).join(', ')||'TIDAK ADA')})"
echo "-- test konektivitas provider --"
curl -sS -m 15 -X POST "$BASE/admin/providers/testmock/test" -H "$AUTH"; echo
echo "-- chat via custom provider (non-stream, JSON polos) --"
curl -sS -m 30 -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"model":"testmock/mock-model","messages":[{"role":"user","content":"hi"}],"stream":false}'; echo
echo "-- chat via custom provider (stream, 5 baris) --"
curl -sS -m 30 -N -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"model":"testmock/mock-model","messages":[{"role":"user","content":"hi"}],"stream":true}' | head -n 5; echo
echo "-- hapus provider --"
curl -sS -m 10 -X DELETE "$BASE/admin/providers/testmock" -H "$AUTH"; echo
echo "-- models setelah hapus (harus TIDAK ADA) --"
curl -sS -m 30 "$BASE/v1/models" | node -e "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{const d=JSON.parse(b);console.log(d.data.map(x=>x.id).filter(i=>i.startsWith('testmock/')).join(', ')||'TIDAK ADA (ok)')})"
kill $MOCKPID 2>/dev/null
wait $MOCKPID 2>/dev/null
echo "== e2e selesai =="

echo "== 6. fitur AI ala 9router (mock lokal) =="
node "$SCRIPT_DIR/mock_provider.js" & MOCKPID=$!
sleep 1
echo "-- tambah provider featmock --"
curl -sS -m 10 -X POST "$BASE/admin/providers" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"id":"featmock","name":"Feat Mock","base_url":"http://127.0.0.1:20299","models":["fail-model","mock-model"]}'; echo
echo "-- aktifkan fitur --"
curl -sS -m 10 -X PUT "$BASE/admin/features" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"rtk_enabled":true,"caveman_enabled":true,"caveman_level":"full","vision_strip":true,"no_vision_models":["featmock/mock-model"]}' \
  | node -e "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{const d=JSON.parse(b);console.log('rtk='+d.rtk_enabled,'caveman='+d.caveman_enabled)})"
echo "-- combo + round-robin + fallbacks --"
curl -sS -m 10 -X POST "$BASE/admin/combos" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"name":"fecombo","models":["featmock/fail-model","featmock/mock-model"]}'; echo
curl -sS -m 10 -X PUT "$BASE/admin/round-robin" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"pools":{"ferr":["featmock/mock-model","featmock/fail-model"]}}'; echo
curl -sS -m 10 -X PUT "$BASE/admin/fallbacks" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"fallbacks":{"featmock/fail-model":["featmock/mock-model"]}}'; echo
echo "-- models memuat combo/fecombo & rr/ferr? --"
curl -sS -m 30 "$BASE/v1/models" | node -e "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{const ids=JSON.parse(b).data.map(x=>x.id);console.log('combo/fecombo:',ids.includes('combo/fecombo'),'| rr/ferr:',ids.includes('rr/ferr'))})"
echo "-- combo fallback (fail->ok), X-Model harus featmock/mock-model --"
curl -sS -m 30 -D - -o /dev/null -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"model":"combo/fecombo","messages":[{"role":"user","content":"hi"}],"stream":false}' | grep -i '^HTTP\|^x-model'
echo "-- round-robin rotasi (2x, X-Model bergantian) --"
for i in 1 2; do curl -sS -m 30 -D - -o /dev/null -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"model":"rr/ferr","messages":[{"role":"user","content":"hi"}],"stream":false}' | grep -i '^x-model'; done
echo "-- fallback map langsung (featmock/fail-model -> 200) --"
curl -sS -m 30 -D - -o /dev/null -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"model":"featmock/fail-model","messages":[{"role":"user","content":"hi"}],"stream":false}' | grep -i '^HTTP\|^x-model'
echo "-- RTK: tool message git diff harus terkompres (X-RTK-Saved > 0) --"
node -e "
const diff='diff --git a/f.js b/f.js\n'+Array.from({length:400},(_,i)=>((i%2?'+':'-')+'line content number '+i+' with some code here')).join('\n');
process.stdout.write(JSON.stringify({model:'featmock/mock-model',stream:false,messages:[{role:'user',content:'review'},{role:'tool',content:diff}]}));
" > /tmp/rtk_e2e.json
curl -sS -m 30 -D - -o /dev/null -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -H "$AUTH" \
  -d @/tmp/rtk_e2e.json | grep -i '^HTTP\|^x-rtk-saved\|^x-caveman'
echo "-- vision strip: image_url ke no-vision model (X-Vision-Stripped: 1) --"
curl -sS -m 30 -D - -o /dev/null -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"model":"featmock/mock-model","stream":false,"messages":[{"role":"user","content":[{"type":"text","text":"see"},{"type":"image_url","image_url":{"url":"http://x/y.png"}}]}]}' | grep -i '^HTTP\|^x-vision-stripped'
echo "-- combo invalid harus 404 --"
curl -sS -m 10 -o /dev/null -w 'HTTP=%{http_code}\n' -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"model":"combo/tidakada","messages":[{"role":"user","content":"hi"}],"stream":false}'
echo "-- bersih-bersih --"
curl -sS -m 10 -X DELETE "$BASE/admin/combos/fecombo" -H "$AUTH"; echo
curl -sS -m 10 -X DELETE "$BASE/admin/providers/featmock" -H "$AUTH"; echo
curl -sS -m 10 -X PUT "$BASE/admin/round-robin" -H 'Content-Type: application/json' -H "$AUTH" -d '{}'; echo
curl -sS -m 10 -X PUT "$BASE/admin/fallbacks" -H 'Content-Type: application/json' -H "$AUTH" -d '{}'; echo
curl -sS -m 10 -X PUT "$BASE/admin/features" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"rtk_enabled":false,"caveman_enabled":false,"vision_strip":true,"no_vision_models":[]}' -o /dev/null -w 'features reset HTTP=%{http_code}\n'
kill $MOCKPID 2>/dev/null
wait $MOCKPID 2>/dev/null
echo "== e2e fitur selesai =="
