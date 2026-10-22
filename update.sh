#!/bin/bash
# rerouter updater — tarik versi terbaru dari GitHub lalu restart server.
# Aman: config.json, *.db, models.dev.json di-ignore git jadi tidak ketimpa.
set -e
cd "$(dirname "$0")"

if [ ! -d .git ]; then
  echo "bukan git clone — clone ulang dari https://github.com/kanoya25/rerouter"
  exit 1
fi

echo "== git pull =="
git pull --ff-only origin main || {
  echo "pull gagal (mungkin ada perubahan lokal). reset paksa? jalankan:"
  echo "  git reset --hard origin/main"
  exit 1
}

echo "== restart server =="
PIDS=$(ps -eo pid,args | grep "[n]ode serv" | awk '{print $1}' || true)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null || true
  sleep 2
fi
nohup node server.js > rerouter.log 2>&1 &
sleep 3
if curl -s -m 5 -o /dev/null http://localhost:20129/v1/models; then
  echo "rerouter terupdate dan jalan."
else
  echo "server tidak merespon — cek rerouter.log"
  exit 1
fi
