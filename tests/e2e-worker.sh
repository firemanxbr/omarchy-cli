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
source "$ROOT/tests/images.env"; IMAGE="$ARCHLINUX_BASE"
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
  local code=$?
  # What the local pool said, when a step failed: the Worker's own log is
  # the only place a 'Network connection lost' or a D1 error shows up.
  if [[ $code -ne 0 && -f "$E2E/wrangler.log" ]]; then
    printf '\n\033[1;31m==> the local pool (wrangler dev) log, last 80 lines:\033[0m\n' >&2
    tail -n 80 "$E2E/wrangler.log" >&2
  fi
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
W1_HASH=$(printf %s omw_e2e_w1 | sha256sum | cut -d' ' -f1); W2_HASH=$(printf %s omw_e2e_w2 | sha256sum | cut -d' ' -f1); W3_HASH=$(printf %s omw_e2e_w3 | sha256sum | cut -d' ' -f1)
# …and the governance the brain would have applied from factory/MAINTAINERS.toml:
# one group, whose maintainer is the contributor 'e2e' (token omc_e2e).
C_HASH=$(printf %s omc_e2e | sha256sum | cut -d' ' -f1)
npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
     ('w1', 'aarch64', 'e2e', '$W1_HASH', 'shared', 'project', 'e2e', '2000-01-01T00:00:00Z'),
     ('w2', 'aarch64', 'e2e', '$W2_HASH', 'shared', 'project', 'e2e', '2000-01-01T00:00:00Z'),
     ('w3', 'aarch64', 'e2e-contributor', '$W3_HASH', 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z');
   INSERT INTO factory_groups (name, description, maintainers) VALUES ('community', 'everything else', '[\"e2e\"]');
   INSERT INTO contributors (login, token_hash, session_hash, role, areas) VALUES ('e2e', '$C_HASH', '$(printf %s oms_e2e | sha256sum | cut -d' ' -f1)', 'maintainer', '[\"community\"]'),
     ('e2e-contributor', '$(printf %s omc_e2e_contributor | sha256sum | cut -d' ' -f1)', NULL, 'contributor', '[]')" >/dev/null
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
# One architecture at a time: rc gets edge's aarch64 rows (there are none in the
# fixtures) while its x86_64 keeps what it serves; the response says x86_64 is unchanged.
"$PKG_REPO" promote --from edge --to rc --arch aarch64 --note "aarch64 only"
rc_arch=$(curl -s "$OMARCHY_API/api/v1/releases/rc?fields=summary&arch=x86_64"); grep -q '"name":"zlib"' <<<"$rc_arch" && grep -q '"name":"xz"' <<<"$rc_arch" || { echo "a per-arch promotion must keep the other architecture: $(head -c 200 <<<"$rc_arch")"; exit 1; }
# The diff between two releases: the rollback dropped xz, the promotion put it back.
diff_out=$("$PKG_REPO" diff --ring stable); grep -q "^+ xz 5.8.4-1 (x86_64)" <<<"$diff_out" || { echo "diff does not show xz coming back: $diff_out"; exit 1; }
diff_json=$("$PKG_REPO" diff --ring stable --json); python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["counts"]["added"]==1 and d["counts"]["removed"]==0 and d["from"]["id"] < d["to"]["id"], d["counts"]' <<<"$diff_json" || { echo "diff --json is off"; exit 1; }
rel_json=$("$PKG_REPO" releases --all --json); python3 -c 'import json,sys; d=json.load(sys.stdin); assert set(d)=={"edge","rc","stable"} and d["stable"]["releases"][0]["is_head"]==1, list(d)' <<<"$rel_json" || { echo "releases --all --json is off"; exit 1; }
dpage=$(curl -s "$OMARCHY_API/diff?ring=stable"); grep -q "Release diff" <<<"$dpage" || { echo "diff page not served"; exit 1; }

step "Render databases for stable (the pool signs them)"
signing_key=$(curl -s "$OMARCHY_API/api/v1/signing-key")
grep -q "\"fingerprint\":\"$KEYID\"" <<<"$signing_key" || { echo "pool does not hold the signing key: $signing_key"; exit 1; }
"$PKG_REPO" render --ring stable
curl -so "$E2E/stable.db" "$OMARCHY_API/pool/packages/x86_64/omarchy-packages-stable.db"
curl -so "$E2E/stable.db.sig" "$OMARCHY_API/pool/packages/x86_64/omarchy-packages-stable.db.sig"
gpg --verify "$E2E/stable.db.sig" "$E2E/stable.db" 2>/dev/null || { echo "the pool's database signature does not verify"; exit 1; }
# The include names the directory the database is in — the source's own — and no other (nothing is moving).
inc=$(curl -s "$OMARCHY_API/api/v1/pacman.conf?ring=stable&arch=x86_64")
grep -q '^Server = .*/pool/packages/\$arch$' <<<"$inc" || { echo "the include does not name the source's directory: $inc"; exit 1; }
! grep -q '^Server = .*/pool/\$arch$' <<<"$inc" || { echo "the include still names the flat directory: $inc"; exit 1; }
# A client's own signature is not taken over the pool's.
sup=$(curl -s -X PUT "$OMARCHY_API/api/v1/releases/1/artifacts/db.sig?repo=omarchy-packages-stable&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary 'not a signature')
grep -q '"status":"superseded"' <<<"$sup" || { echo "client signature was not superseded: $sup"; exit 1; }
# Does what the pool serves verify? The fixtures were published with the
# pool's own key: clean. A signature of other bytes planted beside zlib is
# found; without an upstream channel serving those bytes it is reported for
# a replacement, not silently kept.
gpg --armor --export "$KEYID" > "$E2E/verify-key.asc"
vout=$("$PKG_REPO" verify --ring stable --arch x86_64 --keyring "$E2E/verify-key.asc" --work-dir "$E2E/verify-work" --pool "$OMARCHY_API/pool" 2>&1) || { echo "verify failed: $vout"; exit 1; }
grep -q "0 bad signature(s)" <<<"$vout" || { echo "verify must find the pool clean: $vout"; exit 1; }
zlib_sha=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print([p["sha256"] for p in d["packages"] if p["name"]=="zlib"][0])' <<<"$(curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary&arch=x86_64")")
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/pool/$zlib_sha/sig?filename=zlib-1:1.3.2-3-x86_64.pkg.tar.zst&source=packages&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/pkgs/xz-5.8.4-1-x86_64.pkg.tar.zst.sig"
vout=$("$PKG_REPO" verify --ring stable --arch x86_64 --keyring "$E2E/verify-key.asc" --work-dir "$E2E/verify-work" --pool "$OMARCHY_API/pool" --repair 2>&1 || true)
grep -q "1 bad signature(s)" <<<"$vout" && grep -q "needs replacing" <<<"$vout" || { echo "verify must find the planted signature: $vout"; exit 1; }
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/pool/$zlib_sha/sig?filename=zlib-1:1.3.2-3-x86_64.pkg.tar.zst&source=packages&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/pkgs/zlib-1:1.3.2-3-x86_64.pkg.tar.zst.sig"
# A release that only touches aarch64 keeps x86_64's rendered databases: the
# artifact rows carry over and the response says not to render it again.
# wrangler dev's proxy drops a request now and then on CI runners ("Network
# connection lost", the dev server continues — seen right here, never
# locally); one retry two seconds later tells that apart from a real error.
unch=""
for attempt in 1 2 3; do
  unch=$(curl -s -w '\nHTTP %{http_code} in %{time_total}s' -X POST "$OMARCHY_API/api/v1/releases" -H "Authorization: Bearer $OMARCHY_TOKEN" -H "content-type: application/json" -d "{\"ring\":\"stable\",\"remove\":[\"nothing-here\"],\"remove_arch\":\"aarch64\",\"note\":\"aarch64-only change (attempt $attempt)\"}")
  grep -q '"unchanged_arches":\["x86_64"\]' <<<"$unch" && break
  echo "attempt $attempt: the local pool did not answer the aarch64-scoped release: $unch"
  sleep 2
done
grep -q '"unchanged_arches":\["x86_64"\]' <<<"$unch" || { echo "an aarch64-scoped release must report x86_64 unchanged"; curl -s "$OMARCHY_API/api/v1/status"; echo; exit 1; }
carried=$(curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary"); grep -q '"repo":"omarchy-packages-stable","arch":"x86_64","kind":"db"' <<<"$carried" || { echo "the parent's x86_64 databases were not carried over: $(head -c 300 <<<"$carried")"; exit 1; }

step "Verify across rings: an any package is one object per architecture directory"
# An `any` package is one object per architecture directory, with different
# bytes (Arch Linux ARM rebuilds them). Pinned by two rings with a bad
# signature on the x86_64 copy, verify used to carry the aarch64 bytes into
# the x86_64 re-pin of the second ring (production, 2026-09-14: "packages
# not indexed"). Now: one bad signature, nothing re-pinned.
for a in x86_64 aarch64; do
  mkdir -p "$E2E/any/$a/root"
  printf 'pkgname = e2e-any\npkgver = 1-1\npkgdesc = one object per directory (%s)\narch = any\nsize = 1\n' "$a" > "$E2E/any/$a/root/.PKGINFO"
  (cd "$E2E/any/$a/root" && tar -cf - .PKGINFO | xz -c > "../e2e-any-1-1-any.pkg.tar.xz")
  gpg --batch --yes --detach-sign --no-armor --local-user "$KEYID" --output "$E2E/any/$a/e2e-any-1-1-any.pkg.tar.xz.sig" "$E2E/any/$a/e2e-any-1-1-any.pkg.tar.xz"
  for r in rc stable; do "$PKG_REPO" publish --ring "$r" --source packages --arch "$a" --note "e2e-any $a" "$E2E/any/$a/e2e-any-1-1-any.pkg.tar.xz" >/dev/null; done
done
any_x86=$(sha256sum "$E2E/any/x86_64/e2e-any-1-1-any.pkg.tar.xz" | cut -d' ' -f1)
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/pool/$any_x86/sig?filename=e2e-any-1-1-any.pkg.tar.xz&source=packages&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/any/aarch64/e2e-any-1-1-any.pkg.tar.xz.sig"
vout=$("$PKG_REPO" verify --keyring "$E2E/verify-key.asc" --work-dir "$E2E/verify-work" --pool "$OMARCHY_API/pool" --repair 2>&1 || true)
grep -q "1 bad signature(s)" <<<"$vout" && grep -q "0 pinned bytes the pool does not store (0 re-pinned)" <<<"$vout" || { echo "verify must find one bad signature and re-pin nothing: $vout"; exit 1; }
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/pool/$any_x86/sig?filename=e2e-any-1-1-any.pkg.tar.xz&source=packages&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/any/x86_64/e2e-any-1-1-any.pkg.tar.xz.sig"

step "Pool sanity (one directory per source: databases beside the packages)"
for f in omarchy-packages-stable.db omarchy-packages-stable.db.sig omarchy-packages-stable.files "zlib-1:1.3.2-3-x86_64.pkg.tar.zst" "zlib-1:1.3.2-3-x86_64.pkg.tar.zst.sig"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/pool/packages/x86_64/$f")
  [[ "$code" == 200 ]] || { echo "unexpected $code for $f"; exit 1; }
done
[[ "$(curl -s -H 'Range: bytes=0-3' "$OMARCHY_API/pool/packages/x86_64/zlib-1:1.3.2-3-x86_64.pkg.tar.zst" | od -An -tx1 | tr -d ' \n')" == "28b52ffd" ]] || { echo "range request broken"; exit 1; }

# Read bodies fully before grepping: `curl | grep -q` under pipefail fails
# with exit 23 when grep closes the pipe early.
stats_body=$(curl -s "$OMARCHY_API/api/v1/stats")
grep -q '"kind":"render"' <<<"$stats_body" || { echo "render event missing from stats"; exit 1; }
dash_body=$(curl -s "$OMARCHY_API/")
grep -q "tested before they reach you" <<<"$dash_body" || {
  echo "dashboard not served; response head:"; head -c 600 <<<"$dash_body"; echo
  echo "--- worker log tail ---"; tail -20 "$E2E/wrangler.log"; exit 1; }
for p in /docs /docs/get-started /docs/workers /docs/how-it-works /docs/governance /status /api /contribute /factory; do
  body=$(curl -s "$OMARCHY_API$p"); grep -q "omarchy-pool" <<<"$body" || { echo "page $p not served"; exit 1; }
done
# The old addresses of the documentation chapters redirect into the section.
[[ "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$OMARCHY_API/how-it-works")" == "301 $OMARCHY_API/docs/how-it-works" ]] || { echo "/how-it-works must redirect to /docs/how-it-works"; exit 1; }
gpage=$(curl -s "$OMARCHY_API/governance" -L); grep -q "Becoming a maintainer" <<<"$gpage" || { echo "governance page not served"; exit 1; }
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
# Community tasks are their owner's first: a donated (--shared) worker sees
# someone else's only from shared_after on; without --shared, never.
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "INSERT INTO build_tasks (name, \"group\", arch, pkgbuild_ref, reason, priority, publish, trust, owner, kind, shared_after) VALUES
     ('later', 'community', 'aarch64', 'draft:https://github.com/x/later@latest', 'bump to v2', 100, 0, 'community', 'someone-else', 'build', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+14 days')),
     ('nowish', 'community', 'aarch64', 'draft:https://github.com/x/nowish@latest', 'package-request #1', 100, 0, 'community', 'someone-else', 'build', NULL)" >/dev/null)
w3=(-H "authorization: Bearer omw_e2e_w3" -H "content-type: application/json")
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","agent":"openai/gpt-5","agent_status":"ok"}')" == 204 ]] || { echo "a worker not started --shared must only see its owner's tasks"; exit 1; }
# Donating a worker is a maintainer's call: a contributor's --shared is ignored; a maintainer's is honoured.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","shared":true,"agent":"openai/gpt-5","agent_status":"ok"}')" == 204 ]] || { echo "a contributor's worker must not build strangers' packages, --shared or not"; exit 1; }
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command "UPDATE build_workers SET owner = 'e2e' WHERE id = 'w3'" >/dev/null)
# A draft is the agent's work: a worker whose agent did not answer the probe gets nothing; one whose agent did gets it.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","shared":true,"agent":"openai/gpt-5","agent_status":"error","agent_error":"HTTP 402"}')" == 204 ]] || { echo "a worker whose agent is down must not be handed a draft"; exit 1; }
c3=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","shared":true,"agent":"openai/gpt-5","agent_status":"ok"}')
grep -q '"name":"nowish"' <<<"$c3" || { echo "a shared worker must get the task that is shareable now: $c3"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","shared":true,"agent":"openai/gpt-5","agent_status":"ok"}')" == 204 ]] || { echo "a shared worker must not get a task before its shared_after"; exit 1; }
fac3=$(curl -s "$OMARCHY_API/api/v1/factory?limit=50"); grep -q '"id":"w3","arch":"aarch64"' <<<"$fac3" && grep -q '"mode":"shared"' <<<"$fac3" && grep -q '"agent_status":"ok"' <<<"$fac3" && grep -q '"ready":true' <<<"$fac3" || { echo "the claim did not record the worker as shared and ready: $fac3"; exit 1; }
# The community build's evidence goes to staging with the job token; the
# builder cannot write the audit files. Staging it queues the second agent.
c3_id=$(jq -r .task.id <<<"$c3"); c3_tok=$(jq -r .token <<<"$c3"); c3j=(-H "authorization: Bearer $c3_tok")
for f in PKGBUILD build.log PKGINFO nowish-1.0-1-aarch64.pkg.tar.zst; do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/$f" "${c3j[@]}" --data-binary "evidence: $f")" == 201 ]] || { echo "the job token must upload $f to its own staging"; exit 1; }
done
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/audit.json" "${c3j[@]}" --data-binary '{"verdict":"ok"}')" == 403 ]] || { echo "a builder must not write the audit about its own build"; exit 1; }
st3=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$c3_id/complete" "${c3j[@]}" -H "content-type: application/json" -d '{"sha256":"1111","filename":"nowish-1.0-1-aarch64.pkg.tar.zst","version":"1.0-1"}'); grep -q '"status":"staged"' <<<"$st3" || { echo "the community build did not stage: $st3"; exit 1; }
review=$(curl -s "$OMARCHY_API/api/v1/factory/review"); grep -q '"staged"' <<<"$review" || { echo "review list not served: $review"; exit 1; }
python3 -c 'import json,sys; d=json.load(sys.stdin); t=[t for t in d["staged"] if t["id"]=='"$c3_id"'][0]; assert t["audit"]["status"]=="queued", t["audit"]' <<<"$review" || { echo "staging a build must queue its audit: $(head -c 400 <<<"$review")"; exit 1; }
[[ "$(curl -s "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/PKGINFO")" == "evidence: PKGINFO" ]] || { echo "the .PKGINFO is public evidence"; exit 1; }
# A project worker that declares the audit kind (it has an agent key) takes it;
# the report is attached to the staged build's evidence with the audit's own token.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","kinds":["audit"]}')" == 204 ]] || { echo "a community worker never audits"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w1[@]}" -d '{"arch":"aarch64","kinds":["audit"],"agent":"anthropic/claude-sonnet-5","agent_status":"error","agent_error":"no answer"}')" == 204 ]] || { echo "the second agent must answer the probe before it audits"; exit 1; }
au=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${w1[@]}" -d '{"arch":"aarch64","kinds":["audit"],"agent":"anthropic/claude-sonnet-5","agent_status":"ok"}'); grep -q '"kind":"audit"' <<<"$au" && grep -q "\"task\":$c3_id" <<<"$au" || { echo "the project worker did not get the audit: $au"; exit 1; }
# What the worker said it runs shows on the Factory page; the key itself never travels.
facw=$(curl -s "$OMARCHY_API/api/v1/factory?limit=10&after=agent")
python3 -c 'import json,sys; w=[w for w in json.load(sys.stdin)["workers"] if w["id"]=="w1"][0]; assert w["agent"]=="anthropic/claude-sonnet-5", w' <<<"$facw" || { echo "the worker's agent is not listed"; exit 1; }
au_id=$(jq -r .task.id <<<"$au"); auj=(-H "authorization: Bearer $(jq -r .token <<<"$au")")
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/PKGBUILD" "${auj[@]}" --data-binary 'x')" == 400 ]] || { echo "the audit writes its report only"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/audit.json" "${auj[@]}" --data-binary '{"verdict":"warn","summary":"SKIP checksum","findings":[{"severity":"high","area":"supply-chain","where":"sha256sums","what":"SKIP","fix":"pin it"}]}')" == 201 ]] || { echo "the audit could not attach its report"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/audit.md" "${auj[@]}" --data-binary '# Audit: warn')" == 201 ]] || { echo "the audit could not attach audit.md"; exit 1; }
aud=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$au_id/complete" "${auj[@]}" -H "content-type: application/json" -d '{"summary":"warn: SKIP checksum","result":{"verdict":"warn","summary":"SKIP checksum","model":"e2e","findings":[{"severity":"high","area":"supply-chain"}]}}'); grep -q '"status":"done"' <<<"$aud" || { echo "the audit did not complete: $aud"; exit 1; }
review=$(curl -s "$OMARCHY_API/api/v1/factory/review")
python3 -c 'import json,sys; d=json.load(sys.stdin); a=[t for t in d["staged"] if t["id"]=='"$c3_id"'][0]["audit"]; assert a["status"]=="done" and a["verdict"]=="warn" and a["findings"]==1 and a["high"]==1, a' <<<"$review" || { echo "review does not show the audit verdict: $(head -c 400 <<<"$review")"; exit 1; }
[[ "$(curl -s "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/audit.md")" == "# Audit: warn" ]] || { echo "the audit report is public evidence"; exit 1; }
groups=$(curl -s "$OMARCHY_API/api/v1/factory/groups"); grep -q '"maintainers":\["e2e"\]' <<<"$groups" || { echo "groups not served from the governance table: $groups"; exit 1; }
me=$(curl -s "$OMARCHY_API/api/v1/factory/me" -H "authorization: Bearer omc_e2e"); grep -q '"role":"maintainer"' <<<"$me" || { echo "the seeded maintainer is not one: $me"; exit 1; }
gpage=$(curl -s "$OMARCHY_API/docs/governance"); grep -q "Becoming a maintainer" <<<"$gpage" || { echo "governance page not served"; exit 1; }
# The browser session (cookie omc=oms_…) signs the dashboard in; signing out invalidates it on the server, not only in the browser.
sme=$(curl -s "$OMARCHY_API/auth/me" -H "cookie: omc=oms_e2e"); grep -q '"login":"e2e"' <<<"$sme" || { echo "the seeded session does not sign in: $sme"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/auth/logout" -H "cookie: omc=oms_e2e")" == 302 ]] || { echo "logout must redirect"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/auth/me" -H "cookie: omc=oms_e2e")" == 401 ]] || { echo "a signed-out session must stop working"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/api/v1/factory/me" -H "authorization: Bearer omc_e2e")" == 200 ]] || { echo "signing out of the browser must not revoke the CLI token"; exit 1; }
# A worker learns what its registration is (the image decides its mode from this).
wself=$(curl -s "$OMARCHY_API/api/v1/factory/workers/self" -H "authorization: Bearer omw_e2e_w3"); grep -q '"trust":"community"' <<<"$wself" && grep -q '"owner":"e2e"' <<<"$wself" || { echo "workers/self did not describe the registration: $wself"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/api/v1/factory/workers/self")" == 401 ]] || { echo "workers/self must need a worker token"; exit 1; }
upage=$(curl -s "$OMARCHY_API/api/v1/users/e2e"); grep -q '"role":"maintainer"' <<<"$upage" && grep -q '"github":"https://github.com/e2e"' <<<"$upage" || { echo "the profile API did not describe the seeded maintainer: $upage"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/api/v1/users/nobody-here")" == 404 ]] || { echo "an unknown login must be 404"; exit 1; }
upg=$(curl -s "$OMARCHY_API/user/e2e"); grep -q "omarchy-pool" <<<"$upg" || { echo "profile page not served"; exit 1; }
pkgm=$(curl -s "$OMARCHY_API/api/v1/package/zlib?ring=stable"); grep -q '"maintenance":{"packager":' <<<"$pkgm" || { echo "package view lacks maintenance: $(head -c 200 <<<"$pkgm")"; exit 1; }
# No shared secret: a maintainer runs jobs by hand (queued, not executed with their token); a contributor cannot.
mauth=(-H "authorization: Bearer omc_e2e" -H "content-type: application/json")
qj=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/jobs" "${mauth[@]}" -d '{"kind":"health","params":{"ring":"stable","arch":"x86_64"}}')
grep -q '"task":' <<<"$qj" || { echo "a maintainer could not queue a job: $qj"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/jobs" -H "authorization: Bearer omc_e2e_contributor" -H "content-type: application/json" -d '{"kind":"gc"}')" == 403 ]] || { echo "a contributor must not queue jobs"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/jobs" "${mauth[@]}" -d '{"kind":"promote","params":{"from":"edge","to":"edge"}}')" == 400 ]] || { echo "bad job params must be refused"; exit 1; }
rb=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/jobs" "${mauth[@]}" -d '{"kind":"rollback","params":{"ring":"stable","to":"1"}}'); grep -q '"kind":"rollback"' <<<"$rb" || { echo "a maintainer could not queue a rollback: $rb"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/events" "${mauth[@]}" -d '{"kind":"note","status":"ok","summary":"a maintainer wrote this"}')" == 201 ]] || { echo "a maintainer must be able to write a journal note"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/pool/gc" "${mauth[@]}")" == 401 ]] || { echo "a maintainer token must not write to the pool directly (jobs do)"; exit 1; }
# Nobody approves their own package — and the group's only maintainer is no exception (docs/GOVERNANCE.md).
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "INSERT INTO build_tasks (name, \"group\", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES
     ('mine', 'community', 'aarch64', '1.0-1', 'draft:https://github.com/e2e/mine@latest', 'contributor', 100, 0, 'community', 'e2e', 'build', 'staged', 'staging/e2e/mine/1/');
   UPDATE factory_groups SET maintainers = '[\"e2e\",\"other\"]' WHERE name = 'community'" >/dev/null)
mine=$(curl -s "$OMARCHY_API/api/v1/factory/review" | python3 -c 'import json,sys; print([t["id"] for t in json.load(sys.stdin)["staged"] if t["name"]=="mine"][0])')
# A contributor's build is evidence: approving it is refused before anything else. The owner rule shows on "build":
# a maintainer never has the project build their own package — with another maintainer around or as the sole one.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/approve" "${mauth[@]}" -d '{}')" == 409 ]] || { echo "a contributor's build must never be approvable"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/build" "${mauth[@]}" -d '{}')" == 403 ]] || { echo "a maintainer must not have the project build their own package when another maintainer exists"; exit 1; }
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command "UPDATE factory_groups SET maintainers = '[\"e2e\"]' WHERE name = 'community'" >/dev/null)
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/build" "${mauth[@]}" -d '{}')" == 403 ]] || { echo "the sole maintainer must not have the project build their own package either"; exit 1; }
# Somebody else's package: a contributor's build is never approved — it is evidence. A maintainer has the project
# build it (review:<task>, the project's own recipe, its agent, a worker it trusts); the approval comes on that build.
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command "UPDATE build_tasks SET owner = 'someone-else' WHERE id = $mine" >/dev/null)
dec=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/approve" "${mauth[@]}" -d '{"note":"reads well"}'); [[ "$dec" == 409 ]] || { echo "a contributor's build must not be approvable (got $dec)"; exit 1; }
pb=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/build" "${mauth[@]}" -d '{"note":"reads well"}'); grep -q "\"from\":$mine" <<<"$pb" && grep -q '"by":"e2e"' <<<"$pb" || { echo "the project build must be queued from the staged evidence: $pb"; exit 1; }
ptask=$(jq -r .task <<<"$pb")
[[ "$(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --json --command "SELECT pkgbuild_ref || ' ' || trust || ' ' || publish AS r FROM build_tasks WHERE id = $ptask" | jq -r '.[0].results[0].r')" == "review:$mine project 0" ]] || { echo "the project build is a project-trust, staged (publish 0) build from review:$mine"; exit 1; }
[[ "$(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --json --command "SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'build' AND pkgbuild_ref LIKE 'staging:%'" | jq -r '.[0].results[0].n')" == 0 ]] || { echo "no build may start from a contributor's staged artifact"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/build" "${mauth[@]}" -d '{}')" == 409 ]] || { echo "one project build at a time per staged build"; exit 1; }
# Nothing was approved yet: the profile's record says so.
rec=$(curl -s "$OMARCHY_API/api/v1/users/e2e?after=review")   # a fresh key: the profile is edge-cached for a minute
python3 -c 'import json,sys; rs=[g for g in json.load(sys.stdin)["record"] if g["group"]=="community"]; assert not rs or rs[0]["maintained"]["approvals"]==0, rs' <<<"$rec" || { echo "the profile record is off: $(python3 -c 'import json,sys; print(json.load(sys.stdin)["record"])' <<<"$rec")"; exit 1; }
rpage=$(curl -s "$OMARCHY_API/review"); grep -q "Review" <<<"$rpage" || { echo "review page not served"; exit 1; }
# A signature for bytes the pool does not serve under that filename is refused.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/pool/$(printf 'a%.0s' {1..64})/sig?filename=xz-5.8.4-1-x86_64.pkg.tar.zst&source=packages&arch=x86_64" -H "authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/pkgs/xz-5.8.4-1-x86_64.pkg.tar.zst.sig")" == 409 ]] || { echo "a mismatching signature must be refused"; exit 1; }
echo "factory queue, lease, requeue, guard and completion OK"

step "pacman in $IMAGE against the worker mirror"
gpg --armor --export "$KEYID" > "$E2E/omarchy-poc.pub.asc"
cat > "$E2E/pacman.conf" <<CONF
[options]
Architecture = x86_64
SigLevel = Required DatabaseRequired

[omarchy-packages-stable]
Server = http://$HOST_FROM_CONTAINER:$PORT/pool/packages/\$arch
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
