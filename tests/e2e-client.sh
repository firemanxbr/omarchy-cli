#!/usr/bin/env bash
# End-to-end for the thin client, hermetic: a local worker (wrangler dev with
# local D1/R2) holds the fixture packages in `stable`.
#
#   1. Exports the pacman database and shared libraries of two real Arch images
#      (current, and January 2021 with glibc 2.32) into target/rootfs*/.
#   2. Runs `omarchy-cli check` on the host against both: the current system is
#      safe, the 2021 one is BLOCKED on libc.so.6(GLIBC_2.34).
#   3. Runs `omarchy-cli upgrade` inside the current Arch container (native
#      Linux build, or cross-compiled with cargo-zigbuild): safety check →
#      pacman -U from the pool → pinned.
#
# Requires: cargo, gpg, node (worker deps installed), podman or docker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E="$ROOT/target/e2e-client"
GNUPGHOME="${OMARCHY_POC_GNUPGHOME:-$HOME/.cache/omarchy-cli-poc/gnupg}"
export GNUPGHOME
PORT="${OMARCHY_E2E_PORT:-8796}"
RUNTIME="$(command -v podman || command -v docker)"
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
source "$(cd "$(dirname "$0")" && pwd)/images.env"; CURRENT="$ARCHLINUX_BASE"
OLD="docker.io/library/archlinux:base-20210131.0.14634"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
cleanup() { [[ -n "${WRANGLER_PID:-}" ]] && kill "$WRANGLER_PID" 2>/dev/null || true; }
trap cleanup EXIT

step "Throwaway signing key"
if ! gpg --list-secret-keys poc@omarchy.invalid >/dev/null 2>&1; then
  mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"
  gpg --batch --quiet --passphrase '' --quick-generate-key \
    "Omarchy POC Signing (throwaway, do not use) <poc@omarchy.invalid>" ed25519 sign 30d
fi
KEYID="$(gpg --list-keys --with-colons poc@omarchy.invalid | awk -F: '/^fpr/{print $10; exit}')"
PUBKEY="$E2E/omarchy-poc.pub.asc"
rm -rf "$E2E" && mkdir -p "$E2E/pkgs"
gpg --armor --export "$KEYID" > "$PUBKEY"

step "Local worker with the fixtures published to stable"
cargo build -q --release -p pkg-repo
PKG_REPO="$ROOT/target/release/pkg-repo"
cd "$ROOT/worker"
STATE="$E2E/wrangler-state"
echo "JOB_TOKEN_SECRET=$JOB_SECRET" > "$E2E/.dev.vars"
npx wrangler d1 migrations apply omarchy-repo --local --persist-to "$STATE" >/dev/null
npx wrangler dev --ip 0.0.0.0 --port "$PORT" --persist-to "$STATE" \
  --env-file "$E2E/.dev.vars" --var "POOL_URL:http://$HOST_FROM_CONTAINER:$PORT/pool" > "$E2E/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 60); do
  if grep -q "no release" <<<"$(curl -s "$OMARCHY_API/api/v1/releases/stable")"; then break; fi; sleep 1
done
cd "$ROOT"
cp "$ROOT"/crates/pkg-extract/tests/fixtures/*.pkg.tar.zst "$E2E/pkgs/"
for pkg in "$E2E"/pkgs/*.pkg.tar.zst; do
  gpg --batch --yes --detach-sign --no-armor --local-user "$KEYID" --output "$pkg.sig" "$pkg"
done
"$PKG_REPO" publish --ring edge --source packages "$E2E"/pkgs/*.pkg.tar.zst >/dev/null
"$PKG_REPO" promote --from edge --to rc >/dev/null && "$PKG_REPO" promote --from rc --to stable >/dev/null
"$PKG_REPO" render --ring stable --sign "$KEYID" >/dev/null
export OMARCHY_POOL="http://$HOST_FROM_CONTAINER:$PORT/pool"

export_rootfs() { # image dest
  rm -rf "$2" && mkdir -p "$2"
  local cid
  cid="$("$RUNTIME" create --platform linux/amd64 "$1" true)"
  if tar --version 2>/dev/null | grep -q GNU; then
    "$RUNTIME" export "$cid" | tar -x -C "$2" --wildcards 'var/lib/pacman/local/*' 'usr/lib/lib*.so*' 'usr/share/libalpm/hooks/*' 2>/dev/null || true
  else
    "$RUNTIME" export "$cid" | tar -x -C "$2" --include 'var/lib/pacman/local/*' --include 'usr/lib/lib*.so*' --include 'usr/share/libalpm/hooks/*' 2>/dev/null || true
  fi
  "$RUNTIME" rm "$cid" >/dev/null
}

step "Build client"
cargo build -q -p omarchy-cli
CLI="$ROOT/target/debug/omarchy-cli"
CLI_ARGS=(--api "$OMARCHY_API" --pool "$OMARCHY_POOL" --arch x86_64)   # the exported rootfs is x86_64 whatever the host

step "Export rootfs slices (pacman db + libraries)"
export_rootfs "$CURRENT" "$ROOT/target/rootfs-current"
export_rootfs "$OLD" "$ROOT/target/rootfs-2021"
echo "current glibc: $(grep -A1 '%VERSION%' "$ROOT"/target/rootfs-current/var/lib/pacman/local/glibc-*/desc | tail -1)"
echo "2021 glibc:    $(grep -A1 '%VERSION%' "$ROOT"/target/rootfs-2021/var/lib/pacman/local/glibc-*/desc | tail -1)"
# Every .hook the current image ships parses (pkg-hooks' real-hooks test).
OMARCHY_HOOKS_ROOT="$ROOT/target/rootfs-current" cargo test -q -p pkg-hooks --test real_hooks 2>&1 | tail -1

step "status / check on the current system (expected: safe)"
"$CLI" "${CLI_ARGS[@]}" --root "$ROOT/target/rootfs-current" status
"$CLI" "${CLI_ARGS[@]}" --root "$ROOT/target/rootfs-current" check xz
# The hook preview: a hook of the system that the plan triggers by name, one
# by a file the package ships (fetched from the ring), one it does not.
mkdir -p "$ROOT/target/rootfs-current/usr/share/libalpm/hooks" "$ROOT/target/rootfs-current/etc/pacman.d/hooks"
printf '[Trigger]\nType = Package\nOperation = Install\nOperation = Upgrade\nTarget = xz\n[Action]\nDescription = By name\nWhen = PostTransaction\nExec = /usr/bin/true\n' > "$ROOT/target/rootfs-current/usr/share/libalpm/hooks/10-by-name.hook"
printf '[Trigger]\nType = Path\nOperation = Install\nOperation = Upgrade\nTarget = usr/bin/xz\n[Action]\nDescription = By path\nWhen = PreTransaction\nExec = /usr/bin/true\n' > "$ROOT/target/rootfs-current/etc/pacman.d/hooks/20-by-path.hook"
printf '[Trigger]\nType = Package\nOperation = Remove\nTarget = xz\n[Action]\nWhen = PostTransaction\nExec = /usr/bin/true\n' > "$ROOT/target/rootfs-current/etc/pacman.d/hooks/30-not-this.hook"
hooks_json="$("$CLI" "${CLI_ARGS[@]}" --root "$ROOT/target/rootfs-current" --json check xz)"
python3 -c 'import json,sys; h={x["hook"]: x for x in json.load(sys.stdin)["hooks"]}; assert {"10-by-name.hook","20-by-path.hook"} <= set(h) and "30-not-this.hook" not in h, h; assert h["10-by-name.hook"]["matched"]=="package" and h["20-by-path.hook"]["matched"]=="path" and h["20-by-path.hook"]["when"]=="pre", h' <<<"$hooks_json" || { echo "hook preview is off: $hooks_json"; exit 1; }
text_check="$("$CLI" "${CLI_ARGS[@]}" --root "$ROOT/target/rootfs-current" check xz)"
grep -q "Hooks pacman would run" <<<"$text_check" || { echo "hook preview missing from the text output: $text_check"; exit 1; }
# A typo in the ring is refused before any request.
bad_ring="$("$CLI" "${CLI_ARGS[@]}" --root "$ROOT/target/rootfs-current" --ring stabel status 2>&1 || true)"
grep -q "ring must be edge, rc or stable" <<<"$bad_ring" || { echo "a bad ring must be refused: $bad_ring"; exit 1; }
"$CLI" "${CLI_ARGS[@]}" --root "$ROOT/target/rootfs-current" install xz --dry-run | grep -q '^Would run: pacman -U' || { echo "dry-run did not produce a pacman -U command"; exit 1; }

step "check on the January 2021 system (expected: BLOCKED, exit 2)"
set +e
"$CLI" "${CLI_ARGS[@]}" --root "$ROOT/target/rootfs-2021" check xz
code=$?
set -e
[[ $code -eq 2 ]] || { echo "expected exit 2, got $code"; exit 1; }
json="$("$CLI" "${CLI_ARGS[@]}" --root "$ROOT/target/rootfs-2021" --json check xz || true)"
grep -q '"severity": "blocker"' <<<"$json"
echo "blocked as expected — pacman was never invoked"

LINUX_BIN=""
if [[ "$(uname -s)/$(uname -m)" == "Linux/x86_64" ]]; then
  step "Native Linux build for the container"
  cargo build -q --release -p omarchy-cli
  LINUX_BIN="$ROOT/target/release/omarchy-cli"
elif command -v cargo-zigbuild >/dev/null 2>&1; then
  step "Cross-compile for x86_64-unknown-linux-musl"
  rustup target add x86_64-unknown-linux-musl >/dev/null 2>&1 || true
  cargo zigbuild -q --release --target x86_64-unknown-linux-musl -p omarchy-cli
  LINUX_BIN="$ROOT/target/x86_64-unknown-linux-musl/release/omarchy-cli"
fi

if [[ -n "$LINUX_BIN" ]]; then
  step "Run 'omarchy-cli upgrade' inside $CURRENT"
  E="$E2E/container"
  mkdir -p "$E"
  cp "$LINUX_BIN" "$E/omarchy-cli"
  cp "$PUBKEY" "$E/omarchy-poc.pub.asc"
  cat > "$E/check.sh" <<CHECK
set -euo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key poc@omarchy.invalid >/dev/null 2>&1
export OMARCHY_API=http://$HOST_FROM_CONTAINER:$PORT OMARCHY_POOL=$OMARCHY_POOL
# pacman 7's seccomp download sandbox cannot run under x86_64 emulation (harmless natively).
sed -i 's/^#DisableSandboxSyscalls/DisableSandboxSyscalls/' /etc/pacman.conf
grep -q '^DisableSandboxSyscalls' /etc/pacman.conf || sed -i '0,/^\\[options\\]/s//[options]\\nDisableSandboxSyscalls/' /etc/pacman.conf
echo "--- status"; /repo/omarchy-cli status
echo "--- upgrade"; /repo/omarchy-cli upgrade --noconfirm 2>&1 | grep -vE 'warning: database file'
echo "--- pacman -Q xz"; pacman -Q xz 2>/dev/null
echo "--- status after"; /repo/omarchy-cli status | grep -E 'Pinned|Updates'
echo "--- upgrade again"; /repo/omarchy-cli upgrade --noconfirm | grep 'Nothing to do' >/dev/null   # read it all: grep -q closes the pipe early and the client panics on EPIPE
CHECK
  "$RUNTIME" run --rm --platform linux/amd64 ${RUN_EXTRA[@]+"${RUN_EXTRA[@]}"} -v "$E:/repo:ro" "$CURRENT" bash /repo/check.sh
else
  step "No Linux build available; skipping the in-container upgrade (brew install zig && cargo install cargo-zigbuild)"
fi

step "OK — thin client: release awareness, ABI safety check, pacman-driven upgrade"
