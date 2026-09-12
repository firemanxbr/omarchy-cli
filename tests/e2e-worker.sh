#!/usr/bin/env bash
# End-to-end through the edge worker, entirely local:
#   wrangler dev (local D1 + R2) → publish fixtures to edge → promote edge→rc→stable
#   → render + sign databases → pacman in a container syncs from the worker mirror.
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
export OMARCHY_PUBLISH_TOKEN="e2e-token"

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
echo "PUBLISH_TOKEN=$OMARCHY_PUBLISH_TOKEN" > "$E2E/.dev.vars"
npx wrangler d1 migrations apply omarchy-repo --local --persist-to "$WRANGLER_STATE" >/dev/null
npx wrangler dev --ip 0.0.0.0 --port "$PORT" --persist-to "$WRANGLER_STATE" \
  --env-file "$E2E/.dev.vars" --var "POOL_URL:http://$HOST_FROM_CONTAINER:$PORT/pool" > "$E2E/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 60); do
  if curl -s "$OMARCHY_API/api/v1/releases/stable" | grep -q "no release"; then break; fi
  sleep 1
done
curl -s "$OMARCHY_API/api/v1/releases/stable" | grep -q "no release" || { cat "$E2E/wrangler.log"; exit 1; }
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
curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary" | grep -q '"name":"zlib"' || { echo "rollback lost zlib"; exit 1; }
curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary" | grep -q '"name":"xz"' && { echo "rollback still serves xz"; exit 1; }
"$PKG_REPO" promote --from rc --to stable --note "forward again"
"$PKG_REPO" releases --ring stable

step "Render + sign databases for stable"
"$PKG_REPO" render --ring stable --sign "$KEYID"

step "Pool sanity (flat layout: databases beside the packages)"
for f in omarchy-packages-stable.db omarchy-packages-stable.db.sig omarchy-packages-stable.files "zlib-1:1.3.2-3-x86_64.pkg.tar.zst" "zlib-1:1.3.2-3-x86_64.pkg.tar.zst.sig"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/pool/x86_64/$f")
  [[ "$code" == 200 ]] || { echo "unexpected $code for $f"; exit 1; }
done
[[ "$(curl -s -H 'Range: bytes=0-3' "$OMARCHY_API/pool/x86_64/zlib-1:1.3.2-3-x86_64.pkg.tar.zst" | od -An -tx1 | tr -d ' \n')" == "28b52ffd" ]] || { echo "range request broken"; exit 1; }
curl -s "$OMARCHY_API/api/v1/stats" | grep -q '"kind":"render"' || { echo "render event missing from stats"; exit 1; }
curl -s "$OMARCHY_API/" | grep -q "One pool, three rings" || { echo "dashboard not served"; exit 1; }
echo "databases, signatures, package blobs, Range requests, stats and dashboard OK"

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
