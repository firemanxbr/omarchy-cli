#!/usr/bin/env bash
# End-to-end through the edge worker, entirely local:
#   wrangler dev (local D1 + R2) → publish fixtures to edge → promote edge→rc→stable
#   → render databases (signed by the pool's own key) → pacman in a container
#   syncs from the worker mirror.
#
# Requires: cargo, gpg, node (worker deps installed), podman or docker.
# Usage: tests/e2e-worker.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E="$ROOT/target/e2e-worker"
GNUPGHOME="${OMARCHY_POC_GNUPGHOME:-$HOME/.cache/omarchy-cli-poc/gnupg}"
export GNUPGHOME
PORT="${OMARCHY_E2E_PORT:-8790}"
IMAGE="docker.io/library/archlinux:base"
RUNTIME="$(command -v podman || command -v docker)"
# How the container reaches the worker on the host.
if [[ "$RUNTIME" == *podman* ]]; then
  HOST_FROM_CONTAINER="host.containers.internal"; RUN_EXTRA=()
else
  HOST_FROM_CONTAINER="host.docker.internal"; RUN_EXTRA=(--add-host=host.docker.internal:host-gateway)
fi
export OMARCHY_API="http://127.0.0.1:$PORT"
# A job token for the local pool, minted the way the brain mints them
# (HMAC over the claims with JOB_TOKEN_SECRET): what a worker gets at claim
# time. Every scope, a day long — the e2e is the whole pipeline at once.
JOB_SECRET="e2e-jobs"
job_token() {
  local claims payload sig
  claims=$(jq -nc '{t:0,k:"e2e",s:["pool:write","release:edge","release:rc","release:stable","artifacts:*:edge","artifacts:*:rc","artifacts:*:stable","security:write","gc","events","factory:write"],e:((now|floor)+86400),w:"e2e"}')
  payload=$(printf %s "$claims" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  sig=$(printf %s "$payload" | openssl dgst -sha256 -hmac "$JOB_SECRET" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  echo "omj.$payload.$sig"
}
export OMARCHY_TOKEN="$(job_token)"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
cleanup() {
  if [[ -n "${WRANGLER_PID:-}" ]]; then kill "$WRANGLER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

step "Throwaway signing key"
if ! gpg --list-secret-keys poc@omarchy.invalid >/dev/null 2>&1; then
  mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"
  gpg --batch --quiet --passphrase '' --quick-generate-key \
    "Omarchy POC Signing (throwaway, do not use) <poc@omarchy.invalid>" ed25519 sign 30d
fi
KEYID="$(gpg --list-keys --with-colons poc@omarchy.invalid | awk -F: '/^fpr/{print $10; exit}')"

step "Build publisher"
cargo build -q -p pkg-repo
PKG_REPO="$ROOT/target/debug/pkg-repo"

step "Fresh local worker on :$PORT"
rm -rf "$E2E" && mkdir -p "$E2E"
cd "$ROOT/worker"
WRANGLER_STATE="$E2E/wrangler-state"
# The pool holds the signing key (SECURITY.md): the throwaway key goes in as
# the Worker secret, armored on one dotenv line.
SIGNING_KEY="$(gpg --batch --armor --export-secret-keys "$KEYID" | awk '{printf "%s\\n", $0}')"
printf 'JOB_TOKEN_SECRET=%s\nSIGNING_KEY="%s"\n' "$JOB_SECRET" "$SIGNING_KEY" > "$E2E/.dev.vars"
npx wrangler d1 migrations apply omarchy-repo --local --persist-to "$WRANGLER_STATE" >/dev/null
# Two registered project workers (what POST /factory/workers + a maintainer's
# trust produce), seeded straight into the local index: their tokens are
# omw_e2e_w1 and omw_e2e_w2.
W1_HASH=$(printf %s omw_e2e_w1 | sha256sum | cut -d' ' -f1); W2_HASH=$(printf %s omw_e2e_w2 | sha256sum | cut -d' ' -f1)
# …and the governance the brain would have applied from factory/MAINTAINERS.toml:
# one group, whose maintainer is the contributor 'e2e' (token omc_e2e).
C_HASH=$(printf %s omc_e2e | sha256sum | cut -d' ' -f1)
npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
     ('w1', 'aarch64', 'e2e', '$W1_HASH', 'shared', 'project', 'e2e', '2000-01-01T00:00:00Z'),
     ('w2', 'aarch64', 'e2e', '$W2_HASH', 'shared', 'project', 'e2e', '2000-01-01T00:00:00Z');
   INSERT INTO factory_groups (name, description, maintainers) VALUES ('community', 'everything else', '[\"e2e\"]');
   INSERT INTO contributors (login, token_hash, role, areas) VALUES ('e2e', '$C_HASH', 'maintainer', '[\"community\"]'),
     ('e2e-contributor', '$(printf %s omc_e2e_contributor | sha256sum | cut -d' ' -f1)', 'contributor', '[]')" >/dev/null
npx wrangler dev --ip 0.0.0.0 --port "$PORT" --persist-to "$WRANGLER_STATE" \
  --env-file "$E2E/.dev.vars" --var "POOL_URL:http://$HOST_FROM_CONTAINER:$PORT/pool" > "$E2E/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 60); do
  if grep -q "no release" <<<"$(curl -s "$OMARCHY_API/api/v1/releases/stable")"; then break; fi
  sleep 1
done
grep -q "no release" <<<"$(curl -s "$OMARCHY_API/api/v1/releases/stable")" || { cat "$E2E/wrangler.log"; exit 1; }
cd "$ROOT"

step "Sign fixture packages (stands in for the mirror / OPR signatures)"
mkdir -p "$E2E/pkgs"
cp "$ROOT"/crates/pkg-extract/tests/fixtures/*.pkg.tar.zst "$E2E/pkgs/"
for pkg in "$E2E"/pkgs/*.pkg.tar.zst; do
  gpg --batch --yes --detach-sign --no-armor --local-user "$KEYID" --output "$pkg.sig" "$pkg"
done

step "Publish to edge (pool upload happens once)"
"$PKG_REPO" publish --ring edge --source packages --note "zlib" "$E2E/pkgs/zlib-1:1.3.2-3-x86_64.pkg.tar.zst"
"$PKG_REPO" publish --ring edge --source packages --note "xz" "$E2E/pkgs/xz-5.8.4-1-x86_64.pkg.tar.zst"
"$PKG_REPO" publish --ring edge --source packages --note "re-publish is idempotent" "$E2E/pkgs/zlib-1:1.3.2-3-x86_64.pkg.tar.zst"

step "Promote edge → rc → stable (index writes only)"
"$PKG_REPO" promote --from edge --to rc --note "rc cut"
"$PKG_REPO" promote --from rc --to stable --note "ship"

step "Rollback: stable back to the zlib-only release, then forward again"
FIRST_EDGE=$("$PKG_REPO" releases --ring edge | awk '$2 == 1 {print $1}')
"$PKG_REPO" rollback --ring stable --to "$FIRST_EDGE" --note "rollback drill"
summary_body=$(curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary")
grep -q '"name":"zlib"' <<<"$summary_body" || { echo "rollback lost zlib"; exit 1; }
grep -q '"name":"xz"' <<<"$summary_body" && { echo "rollback still serves xz"; exit 1; }
"$PKG_REPO" promote --from rc --to stable --note "forward again"
"$PKG_REPO" releases --ring stable

step "Render databases for stable (the pool signs them)"
signing_key=$(curl -s "$OMARCHY_API/api/v1/signing-key")
grep -q "\"fingerprint\":\"$KEYID\"" <<<"$signing_key" || { echo "pool does not hold the signing key: $signing_key"; exit 1; }
"$PKG_REPO" render --ring stable
curl -so "$E2E/stable.db" "$OMARCHY_API/pool/x86_64/omarchy-packages-stable.db"
curl -so "$E2E/stable.db.sig" "$OMARCHY_API/pool/x86_64/omarchy-packages-stable.db.sig"
gpg --verify "$E2E/stable.db.sig" "$E2E/stable.db" 2>/dev/null || { echo "the pool's database signature does not verify"; exit 1; }
# A client's own signature is not taken over the pool's.
sup=$(curl -s -X PUT "$OMARCHY_API/api/v1/releases/1/artifacts/db.sig?repo=omarchy-packages-stable&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary 'not a signature')
grep -q '"status":"superseded"' <<<"$sup" || { echo "client signature was not superseded: $sup"; exit 1; }

step "Pool sanity (flat layout: databases beside the packages)"
for f in omarchy-packages-stable.db omarchy-packages-stable.db.sig omarchy-packages-stable.files "zlib-1:1.3.2-3-x86_64.pkg.tar.zst" "zlib-1:1.3.2-3-x86_64.pkg.tar.zst.sig"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/pool/x86_64/$f")
  [[ "$code" == 200 ]] || { echo "unexpected $code for $f"; exit 1; }
done
[[ "$(curl -s -H 'Range: bytes=0-3' "$OMARCHY_API/pool/x86_64/zlib-1:1.3.2-3-x86_64.pkg.tar.zst" | od -An -tx1 | tr -d ' \n')" == "28b52ffd" ]] || { echo "range request broken"; exit 1; }
# Read bodies fully before grepping: `curl | grep -q` under pipefail fails
# with exit 23 when grep closes the pipe early.
stats_body=$(curl -s "$OMARCHY_API/api/v1/stats")
grep -q '"kind":"render"' <<<"$stats_body" || { echo "render event missing from stats"; exit 1; }
dash_body=$(curl -s "$OMARCHY_API/")
grep -q "tested before they reach you" <<<"$dash_body" || {
  echo "dashboard not served; response head:"; head -c 600 <<<"$dash_body"; echo
  echo "--- worker log tail ---"; tail -20 "$E2E/wrangler.log"; exit 1; }
for p in /get-started /how-it-works /status /api /contribute /factory; do
  body=$(curl -s "$OMARCHY_API$p"); grep -q "omarchy-pool" <<<"$body" || { echo "page $p not served"; exit 1; }
done
search_body=$(curl -s "$OMARCHY_API/api/v1/search?q=zlib&ring=stable")
grep -q '"name":"zlib"' <<<"$search_body" || { echo "search did not find zlib: $search_body"; exit 1; }
pkg_body=$(curl -s "$OMARCHY_API/api/v1/package/zlib?ring=stable")
grep -q '"shown_ring":"stable"' <<<"$pkg_body" || { echo "package page data missing: $pkg_body"; exit 1; }
# Security: an advisory on the served zlib object shows up in the ring's report,
# and what loads libz.so.1 counts as exposed.
zlib_sha=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print([p["sha256"] for p in d["packages"] if p["name"]=="zlib"][0])' <<<"$(curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary")")
auth=(-H "authorization: Bearer $OMARCHY_TOKEN" -H "content-type: application/json")
curl -sf -X PUT "$OMARCHY_API/api/v1/security/advisories" "${auth[@]}" -d '{"advisories":[{"id":"arch:AVG-9999:zlib","source":"arch","package":"zlib","cves":["CVE-2099-0001"],"severity":"high","status":"vulnerable","fixed":null,"url":"https://security.archlinux.org/AVG-9999"}],"cves":[{"cve":"CVE-2099-0001","kev":true,"epss":0.9}]}' >/dev/null
curl -sf -X PUT "$OMARCHY_API/api/v1/security/matches" "${auth[@]}" -d "{\"matches\":[{\"sha256\":\"$zlib_sha\",\"advisory\":\"arch:AVG-9999:zlib\",\"match\":\"exact\",\"status\":\"vulnerable\"}]}" >/dev/null
sec_body=$(curl -s "$OMARCHY_API/api/v1/security?ring=stable")
grep -q '"name":"zlib"' <<<"$sec_body" || { echo "security report missing zlib: $sec_body"; exit 1; }
grep -q '"kev":1\|"kev":true' <<<"$sec_body" || { echo "KEV flag missing: $sec_body"; exit 1; }
pkg_sec=$(curl -s "$OMARCHY_API/api/v1/package/xz?ring=stable")
grep -q '"via":"zlib"' <<<"$pkg_sec" || echo "note: xz is not exposed through zlib in the fixtures ($(python3 -c 'import json,sys; print(json.load(sys.stdin)["security"])' <<<"$pkg_sec"))"
status_body=$(curl -s "$OMARCHY_API/api/v1/status")
grep -q '"state":"online"' <<<"$status_body" || { echo "service status not online: $status_body"; exit 1; }
grep -q '"signing":true' <<<"$status_body" || { echo "status does not report signing: $status_body"; exit 1; }
# A cached API answer tells the browser to keep it no longer than our own
# expiry (the platform rewrites the stored copy's cache-control to hours).
curl -s -o /dev/null "$OMARCHY_API/api/v1/stats"; hit_headers=$(curl -s -D - -o /dev/null "$OMARCHY_API/api/v1/stats")
grep -qi "x-pool-cache: hit" <<<"$hit_headers" || { echo "second /stats was not served from the cache: $hit_headers"; exit 1; }
ma=$(grep -i "^cache-control:" <<<"$hit_headers" | grep -o 'max-age=[0-9]*' | cut -d= -f2)
[[ -n "$ma" && "$ma" -le 30 ]] || { echo "a cache hit must not extend the browser's max-age: $hit_headers"; exit 1; }
echo "databases, signatures, package blobs, Range requests, stats, pages, security and service status OK"

step "Factory: enqueue, claim with a lease, fail → requeue, complete after publish"
w1=(-H "authorization: Bearer omw_e2e_w1" -H "content-type: application/json")
w2=(-H "authorization: Bearer omw_e2e_w2" -H "content-type: application/json")
# The guard: xz is served by 'packages' for x86_64 → refused there; aarch64 has nobody → queued.
enq=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/enqueue" "${auth[@]}" -d '{"name":"xz","group":"community","pkgbuild_ref":"deadbeef","reason":"pkgbuild-changed","arches":["x86_64","aarch64"]}')
grep -q '"arches":\["aarch64"\]' <<<"$enq" || { echo "enqueue did not skip the upstream-served arch: $enq"; exit 1; }
grep -q '"source":"packages"' <<<"$enq" || { echo "enqueue did not name who ships it: $enq"; exit 1; }
refused=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/enqueue" "${auth[@]}" -d '{"name":"xz","group":"community","pkgbuild_ref":"deadbeef","reason":"x","arches":["x86_64"]}')
[[ "$refused" == 409 ]] || { echo "expected 409 for a name upstream ships, got $refused"; exit 1; }
tid=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["tasks"][0])' <<<"$enq")
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${auth[@]}" -d '{"arch":"aarch64"}')" == 403 ]] || { echo "a job token must not claim"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" -H "authorization: Bearer omw_unknown" -H "content-type: application/json" -d '{"arch":"aarch64"}')" == 401 ]] || { echo "an unregistered worker token must not claim"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w1[@]}" -d '{"arch":"x86_64"}')" == 400 ]] || { echo "a worker claims only its registered architecture"; exit 1; }
claim=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${w1[@]}" -d '{"arch":"aarch64","hostname":"e2e"}')
grep -q "\"id\":$tid," <<<"$claim" || { echo "claim did not return the queued task: $claim"; exit 1; }
job=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$claim")
[[ "$job" == omj.* ]] || { echo "claim did not issue a job token: $claim"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w2[@]}" -d '{"arch":"aarch64"}')" == 204 ]] || { echo "second worker must get nothing"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/heartbeat" "${w2[@]}")" == 409 ]] || { echo "a stranger must not heartbeat"; exit 1; }
curl -sf -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/heartbeat" -H "authorization: Bearer $job" >/dev/null || { echo "the job token must heartbeat its own task"; exit 1; }
failed=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/fail" "${w1[@]}" -d '{"error":"boom"}')
grep -q '"status":"queued"' <<<"$failed" || { echo "first failure must requeue: $failed"; exit 1; }
claim2=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${w2[@]}" -d '{"arch":"aarch64"}')
grep -q '"attempts":2' <<<"$claim2" || { echo "second claim must be attempt 2: $claim2"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/complete" "${w2[@]}" -d '{"sha256":"0000","filename":"nope"}')" == 409 ]] || { echo "complete before publish must be refused"; exit 1; }
# The "build result" must be in the pool: the xz object already published
# stands in for it (the fixtures are x86_64 packages; the brain checks the
# pool, not the architecture of the bytes).
xz_sha=$(sha256sum "$E2E/pkgs/xz-5.8.4-1-x86_64.pkg.tar.zst" | cut -d' ' -f1)
done_body=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/complete" "${w2[@]}" -d "{\"sha256\":\"$xz_sha\",\"filename\":\"xz-5.8.4-1-x86_64.pkg.tar.zst\",\"version\":\"5.8.4-1\",\"duration_ms\":1200}")
grep -q '"status":"done"' <<<"$done_body" || { echo "complete failed: $done_body"; exit 1; }
fac=$(curl -s "$OMARCHY_API/api/v1/factory")
grep -q '"builds_done":1' <<<"$fac" || { echo "worker stats missing: $fac"; exit 1; }
built=$(curl -s "$OMARCHY_API/api/v1/factory/built")
grep -q '"name":"xz","arch":"aarch64"' <<<"$built" || { echo "built list missing the task: $built"; exit 1; }
fpage=$(curl -s "$OMARCHY_API/factory"); grep -q "Factory" <<<"$fpage" || { echo "factory page not served"; exit 1; }
reg=$(curl -s "$OMARCHY_API/api/v1/factory/packages"); grep -q '"packages"' <<<"$reg" || { echo "registry not served: $reg"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/packages" -H "content-type: application/json" -d '{"url":"https://github.com/x/y"}')" == 401 ]] || { echo "registering without a contributor token must be refused"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$tid/artifacts/x.log" "${auth[@]}" --data 'x')" == 401 ]] || { echo "the publish token must not write to staging"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/approve" "${auth[@]}" -d '{}')" == 401 ]] || { echo "approving needs a maintainer's contributor token"; exit 1; }
review=$(curl -s "$OMARCHY_API/api/v1/factory/review"); grep -q '"staged"' <<<"$review" || { echo "review list not served: $review"; exit 1; }
groups=$(curl -s "$OMARCHY_API/api/v1/factory/groups"); grep -q '"maintainers":\["e2e"\]' <<<"$groups" || { echo "groups not served from the governance table: $groups"; exit 1; }
me=$(curl -s "$OMARCHY_API/api/v1/factory/me" -H "authorization: Bearer omc_e2e"); grep -q '"role":"maintainer"' <<<"$me" || { echo "the seeded maintainer is not one: $me"; exit 1; }
gpage=$(curl -s "$OMARCHY_API/governance"); grep -q "Becoming a maintainer" <<<"$gpage" || { echo "governance page not served"; exit 1; }
# No shared secret: a maintainer runs jobs by hand (queued, not executed with their token); a contributor cannot.
mauth=(-H "authorization: Bearer omc_e2e" -H "content-type: application/json")
qj=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/jobs" "${mauth[@]}" -d '{"kind":"health","params":{"ring":"stable","arch":"x86_64"}}')
grep -q '"task":' <<<"$qj" || { echo "a maintainer could not queue a job: $qj"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/jobs" -H "authorization: Bearer omc_e2e_contributor" -H "content-type: application/json" -d '{"kind":"gc"}')" == 403 ]] || { echo "a contributor must not queue jobs"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/jobs" "${mauth[@]}" -d '{"kind":"promote","params":{"from":"edge","to":"edge"}}')" == 400 ]] || { echo "bad job params must be refused"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/events" "${mauth[@]}" -d '{"kind":"note","status":"ok","summary":"a maintainer wrote this"}')" == 201 ]] || { echo "a maintainer must be able to write a journal note"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/pool/gc" "${mauth[@]}")" == 401 ]] || { echo "a maintainer token must not write to the pool directly (jobs do)"; exit 1; }
rpage=$(curl -s "$OMARCHY_API/review"); grep -q "Review" <<<"$rpage" || { echo "review page not served"; exit 1; }
# A signature for bytes the pool does not serve under that filename is refused.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/pool/$(printf 'a%.0s' {1..64})/sig?filename=xz-5.8.4-1-x86_64.pkg.tar.zst&arch=x86_64" -H "authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/pkgs/xz-5.8.4-1-x86_64.pkg.tar.zst.sig")" == 409 ]] || { echo "a mismatching signature must be refused"; exit 1; }
echo "factory queue, lease, requeue, guard and completion OK"

step "pacman in $IMAGE against the worker mirror"
gpg --armor --export "$KEYID" > "$E2E/omarchy-poc.pub.asc"
cat > "$E2E/pacman.conf" <<CONF
[options]
Architecture = x86_64
SigLevel = Required DatabaseRequired

[omarchy-packages-stable]
Server = http://$HOST_FROM_CONTAINER:$PORT/pool/\$arch
CONF
cat > "$E2E/check.sh" <<'CHECK'
set -euo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key poc@omarchy.invalid >/dev/null 2>&1
echo "--- pacman -Sy"; pacman --config /repo/pacman.conf -Sy
echo "--- pacman -Sl omarchy-packages-stable"; pacman --config /repo/pacman.conf -Sl omarchy-packages-stable
echo "--- pacman -Sp zlib xz"; pacman --config /repo/pacman.conf -Sp zlib xz
echo "--- pacman -Fy && -Fl xz (files database must carry file lists)"
pacman --config /repo/pacman.conf -Fy >/dev/null
pacman --config /repo/pacman.conf -Fl xz | grep -q 'usr/bin/xz$' || { echo "files database is empty"; exit 1; }
echo "--- pacman -Sw xz && -U"; pacman --config /repo/pacman.conf -Sw --noconfirm xz >/dev/null
pacman --config /repo/pacman.conf -U --noconfirm /var/cache/pacman/pkg/xz-5.8.4-1-x86_64.pkg.tar.zst 2>&1 | grep -E "upgrading|installing|error"
pacman -Q xz
CHECK
"$RUNTIME" run --rm --platform linux/amd64 ${RUN_EXTRA[@]+"${RUN_EXTRA[@]}"} -v "$E2E:/repo:ro" "$IMAGE" bash /repo/check.sh

step "OK — pacman consumed a release served by the worker"
