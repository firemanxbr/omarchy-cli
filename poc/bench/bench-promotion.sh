#!/usr/bin/env bash
# Benchmark: what does a release promotion cost in the pool + index model?
#
# Seeds a fresh local worker (wrangler dev, local D1/R2) with N synthetic
# packages in an `edge` release, then measures:
#   - promote edge → rc and rc → stable   (index writes)
#   - render + upload the stable databases (from the index, no package reads)
#   - a dependency-closure query
#   - optionally, `pacman -Sy` + `-Sl` against the generated database
#
# Usage: poc/bench/bench-promotion.sh [N=10000]
set -euo pipefail

N="${1:-10000}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BENCH="$ROOT/target/bench"
PORT="${OMARCHY_BENCH_PORT:-8791}"
RUNTIME="$(command -v podman || command -v docker || true)"
export OMARCHY_API="http://127.0.0.1:$PORT"
# A job token for the local pool, minted the way the brain mints them
# (HMAC over the claims with JOB_TOKEN_SECRET): every scope, a day long.
JOB_SECRET="bench-jobs"
job_token() {
  local claims payload sig
  claims=$(jq -nc '{t:0,k:"bench",s:["pool:write","release:edge","release:rc","release:stable","artifacts:*:edge","artifacts:*:rc","artifacts:*:stable","security:write","gc","events","factory:write"],e:((now|floor)+86400),w:"bench"}')
  payload=$(printf %s "$claims" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  sig=$(printf %s "$payload" | openssl dgst -sha256 -hmac "$JOB_SECRET" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  echo "omj.$payload.$sig"
}
export OMARCHY_TOKEN="$(job_token)"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
cleanup() { [[ -n "${WRANGLER_PID:-}" ]] && kill "$WRANGLER_PID" 2>/dev/null || true; }
trap cleanup EXIT

step "Build publisher"
cargo build -q --release -p pkg-repo
PKG_REPO="$ROOT/target/release/pkg-repo"

step "Seed a fresh local index with $N packages"
rm -rf "$BENCH" && mkdir -p "$BENCH"
python3 "$ROOT/poc/bench/seed.py" "$N" > "$BENCH/seed.sql"
cd "$ROOT/worker"
STATE="$BENCH/wrangler-state"
npx wrangler d1 migrations apply omarchy-repo --local --persist-to "$STATE" >/dev/null
t0=$(ms); npx wrangler d1 execute omarchy-repo --local --persist-to "$STATE" --file "$BENCH/seed.sql" >/dev/null; t1=$(ms)
echo "seeded in $((t1 - t0)) ms ($(du -h "$BENCH/seed.sql" | cut -f1) of SQL)"

echo "JOB_TOKEN_SECRET=$JOB_SECRET" > "$BENCH/.dev.vars"
npx wrangler dev --ip 0.0.0.0 --port "$PORT" --persist-to "$STATE" --env-file "$BENCH/.dev.vars" > "$BENCH/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 60); do
  curl -sf "$OMARCHY_API/api/v1/releases/edge/history" >/dev/null 2>&1 && break
  sleep 1
done
cd "$ROOT"

SIZE_BYTES=$(curl -s "$OMARCHY_API/api/v1/releases/edge/history" | python3 -c 'import json,sys; r=json.load(sys.stdin)["releases"][0]; print(r["package_count"])')
echo "edge head: $SIZE_BYTES packages"

step "Promote edge → rc → stable"
"$PKG_REPO" promote --from edge --to rc --note "bench"
"$PKG_REPO" promote --from rc --to stable --note "bench"

step "Render stable databases from the index (no package bytes read)"
t0=$(ms); "$PKG_REPO" render --ring stable; t1=$(ms)
echo "render + upload: $((t1 - t0)) ms"
DB_SIZE=$(curl -s -o /dev/null -w '%{size_download}' "$OMARCHY_API/stable/os/x86_64/omarchy.db")
FILES_SIZE=$(curl -s -o /dev/null -w '%{size_download}' "$OMARCHY_API/stable/os/x86_64/omarchy.files")
echo "omarchy.db: $DB_SIZE bytes, omarchy.files: $FILES_SIZE bytes"

step "Dependency closure query"
t0=$(ms); GRAPH=$(curl -s "$OMARCHY_API/api/v1/graph?ring=stable&targets=bench-pkg-1"); t1=$(ms)
echo "graph for bench-pkg-1: $(python3 -c 'import json,sys; print(len(json.load(sys.stdin)["packages"]))' <<<"$GRAPH") packages in $((t1 - t0)) ms"
t0=$(ms); VIEW_SIZE=$(curl -s -o /dev/null -w '%{size_download}' "$OMARCHY_API/api/v1/releases/stable"); t1=$(ms)
echo "release view (what the client downloads): $VIEW_SIZE bytes in $((t1 - t0)) ms"

if [[ -n "$RUNTIME" ]]; then
  step "pacman -Sy against the $N-package database"
  if [[ "$RUNTIME" == *podman* ]]; then HOST="host.containers.internal"; EXTRA=(); else HOST="host.docker.internal"; EXTRA=(--add-host=host.docker.internal:host-gateway); fi
  cat > "$BENCH/pacman.conf" <<CONF
[options]
Architecture = x86_64
SigLevel = Never

[omarchy]
Server = http://$HOST:$PORT/stable/os/\$arch
CONF
  "$RUNTIME" run --rm --platform linux/amd64 ${EXTRA[@]+"${EXTRA[@]}"} -v "$BENCH:/repo:ro" docker.io/library/archlinux:base bash -c \
    'set -e; s=$(date +%s%N); pacman --config /repo/pacman.conf -Sy >/dev/null; e=$(date +%s%N); echo "pacman -Sy: $(( (e-s)/1000000 )) ms"; echo "packages listed: $(pacman --config /repo/pacman.conf -Sl omarchy | wc -l)"; pacman --config /repo/pacman.conf -Si bench-pkg-42 | head -4'
fi

step "Summary"
TOTAL_GB=$(python3 -c "print(round($N * 18 / 1024, 1))")
cat <<SUMMARY
packages in release      : $N (~${TOTAL_GB} GB of package data at 18 MB average)
bytes moved by promotion : 0
SUMMARY
