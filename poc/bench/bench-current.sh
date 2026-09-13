#!/usr/bin/env bash
# Benchmark of the *current* promotion mechanics versus the pool + index model,
# at the same package count, with the same tools the production scripts use.
#
# Current model (omacom/omarchy-mirror, omacom/omarchy-pkgs):
#   promotion = rsync -a --delete <rc tree> <stable tree>   (bytes)
#             + rclone copy/sync to a second R2 bucket        (bytes, network)
#   database  = repo-add over every archive                  (reads each package)
# Pool + index model (this repository):
#   promotion = one index write (pkg-repo promote)
#   database  = rendered from the index (pkg-repo render)
#
# Builds N synthetic packages of SIZE_MB each (valid .pkg.tar.zst with a
# .PKGINFO and a random payload), then measures locally:
#   rsync copy, repo-add (real, in an Arch container), and for the same N
#   index promotion + render against a local worker.
#
# Usage: poc/bench/bench-current.sh [N=1000] [SIZE_MB=5]
set -euo pipefail

N="${1:-1000}"
SIZE_MB="${2:-5}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BENCH="$ROOT/target/bench-current"
PORT="${OMARCHY_BENCH_PORT:-8793}"
RUNTIME="$(command -v podman || command -v docker)"
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

step "Build $N synthetic packages of ${SIZE_MB} MB (valid .pkg.tar.zst)"
rm -rf "$BENCH" && mkdir -p "$BENCH/rc" "$BENCH/stable"
python3 - "$BENCH/rc" "$N" "$SIZE_MB" <<'PY'
import io, os, random, subprocess, sys, tarfile
out, n, size_mb = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
payload = os.urandom(size_mb * 1024 * 1024)  # incompressible, like real packages
for i in range(n):
    name, ver = f"bench-pkg-{i}", f"1.{i}-1"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        info = f"pkgname = {name}\npkgbase = {name}\npkgver = {ver}\npkgdesc = bench\nsize = {len(payload)}\narch = x86_64\nbuilddate = 1700000000\npackager = bench\ndepend = glibc\nprovides = lib{name}.so=1-64\n".encode()
        ti = tarfile.TarInfo(".PKGINFO"); ti.size = len(info); tar.addfile(ti, io.BytesIO(info))
        for d in ("usr/", "usr/lib/"):
            ti = tarfile.TarInfo(d); ti.type = tarfile.DIRTYPE; ti.mode = 0o755; tar.addfile(ti)
        ti = tarfile.TarInfo(f"usr/lib/lib{name}.so.1"); ti.size = len(payload); ti.mode = 0o755
        tar.addfile(ti, io.BytesIO(payload))
    with open(os.path.join(out, f"{name}-{ver}-x86_64.pkg.tar.zst"), "wb") as f:
        subprocess.run(["zstd", "-q", "-1", "-c"], input=buf.getvalue(), stdout=f, check=True)
    with open(os.path.join(out, f"{name}-{ver}-x86_64.pkg.tar.zst.sig"), "wb") as f:
        f.write(b"\x88\x33" + os.urandom(140))  # placeholder detached signature
PY
TREE_BYTES=$(du -sk "$BENCH/rc" | cut -f1); TREE_BYTES=$((TREE_BYTES * 1024))
echo "rc tree: $N packages, $((TREE_BYTES / 1048576)) MB"

step "Current model: promotion = rsync -a --delete rc/ stable/ (local copy of the tree)"
sync; t0=$(ms); rsync -a --delete "$BENCH/rc/" "$BENCH/stable/"; t1=$(ms)
RSYNC_MS=$((t1 - t0))
echo "rsync: $RSYNC_MS ms for $((TREE_BYTES / 1048576)) MB"

step "Current model: database = repo-add over every archive (pacman 7.1, in a container)"
REPO_ADD_MS=$("$RUNTIME" run --rm --platform linux/amd64 -v "$BENCH/stable:/repo" docker.io/library/archlinux:base bash -c \
  'cd /repo && s=$(date +%s%N); repo-add -q --include-sigs omarchy.db.tar.gz *.pkg.tar.zst >/dev/null 2>&1; e=$(date +%s%N); echo $(( (e-s)/1000000 ))')
echo "repo-add: $REPO_ADD_MS ms (db + files; reads every archive)"

step "Pool + index model: same $N packages"
cargo build -q --release -p pkg-repo
PKG_REPO="$ROOT/target/release/pkg-repo"
python3 "$ROOT/poc/bench/seed.py" "$N" > "$BENCH/seed.sql"
cd "$ROOT/worker"
STATE="$BENCH/wrangler-state"
npx wrangler d1 migrations apply omarchy-repo --local --persist-to "$STATE" >/dev/null
npx wrangler d1 execute omarchy-repo --local --persist-to "$STATE" --file "$BENCH/seed.sql" >/dev/null
echo "JOB_TOKEN_SECRET=$JOB_SECRET" > "$BENCH/.dev.vars"
npx wrangler dev --ip 127.0.0.1 --port "$PORT" --persist-to "$STATE" --env-file "$BENCH/.dev.vars" > "$BENCH/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 60); do curl -sf "$OMARCHY_API/api/v1/releases/edge/history" >/dev/null 2>&1 && break; sleep 1; done
cd "$ROOT"
curl -s "$OMARCHY_API/api/v1/releases/edge/history" >/dev/null   # warm the worker
PROMOTE_OUT=$("$PKG_REPO" promote --from edge --to stable --note bench)
PROMOTE_MS=$(python3 -c "import re,sys; m=re.search(r'([\d.]+)(ms|s), zero bytes', sys.argv[1]); v=float(m.group(1)); print(int(v if m.group(2)=='ms' else v*1000))" "$PROMOTE_OUT")
t0=$(ms); "$PKG_REPO" render --ring stable >/dev/null 2>&1; t1=$(ms)
RENDER_MS=$((t1 - t0))
echo "promote: $PROMOTE_MS ms (0 bytes moved); render: $RENDER_MS ms (0 archives read)"

step "Summary"
python3 - "$N" "$TREE_BYTES" "$RSYNC_MS" "$REPO_ADD_MS" "$PROMOTE_MS" "$RENDER_MS" <<'PY'
import json, sys
n, tree, rsync_ms, repoadd_ms, promote_ms, render_ms = map(int, sys.argv[1:])
gb = tree / 2**30
ring_gb = 275
scale = ring_gb / gb
rows = [
    ("promotion (copy tree)",        rsync_ms,   rsync_ms * scale,  promote_ms),
    ("database (repo-add vs render)", repoadd_ms, repoadd_ms * scale, render_ms),
]
print(f"{'':32} {'current, measured':>18} {'current @275 GB':>18} {'pool+index':>12}")
for label, cur, ext, new in rows:
    print(f"{label:32} {cur/1000:>15.1f} s  {ext/60000:>13.1f} min  {new/1000:>9.2f} s")
print(f"\nmeasured tree: {gb:.2f} GB ({n} packages); extrapolation is linear in bytes (x{scale:.0f}) and covers only the local copy —")
print("the production scripts additionally upload the changed bytes to a second R2 bucket and prune it (rclone), which the team reports at 30–60 min.")
json.dump({"n": n, "tree_bytes": tree, "rsync_ms": rsync_ms, "repo_add_ms": repoadd_ms,
           "promote_ms": promote_ms, "render_ms": render_ms, "extrapolated_ring_gb": ring_gb,
           "rsync_at_ring_ms": rsync_ms * scale, "repo_add_at_ring_ms": repoadd_ms * scale},
          open("target/bench-current/results.json", "w"), indent=2)
print("wrote target/bench-current/results.json")
PY
