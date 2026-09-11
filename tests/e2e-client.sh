#!/usr/bin/env bash
# End-to-end for the thin client against the staging index.
#
#   1. Exports the pacman database and shared libraries of two real Arch images
#      (current, and January 2021 with glibc 2.32) into target/rootfs*/.
#   2. Runs `omarchy-cli check` on the host against both: the current system is
#      safe, the 2021 one is BLOCKED on libc.so.6(GLIBC_2.34).
#   3. If cargo-zigbuild is available, cross-compiles omarchy-cli for
#      x86_64-unknown-linux-musl and runs `omarchy-cli upgrade` inside the
#      current Arch container: safety check → pacman -U from the pool → pinned.
#
# Requires: cargo, podman or docker, network access to $OMARCHY_API.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export OMARCHY_API="${OMARCHY_API:-https://pkgs.firemanxbr.org}"
RUNTIME="$(command -v podman || command -v docker)"
CURRENT="docker.io/library/archlinux:base"
OLD="docker.io/library/archlinux:base-20210131.0.14634"
PUBKEY="$ROOT/docs/omarchy-poc.pub.asc"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

export_rootfs() { # image dest
  rm -rf "$2" && mkdir -p "$2"
  local cid
  cid="$("$RUNTIME" create --platform linux/amd64 "$1" true)"
  "$RUNTIME" export "$cid" | tar -x -C "$2" --include 'var/lib/pacman/local/*' --include 'usr/lib/lib*.so*' 2>/dev/null || true
  "$RUNTIME" rm "$cid" >/dev/null
}

step "Build client"
cargo build -q -p omarchy-cli
CLI="$ROOT/target/debug/omarchy-cli"

step "Export rootfs slices (pacman db + libraries)"
export_rootfs "$CURRENT" "$ROOT/target/rootfs-current"
export_rootfs "$OLD" "$ROOT/target/rootfs-2021"
echo "current glibc: $(grep -A1 '%VERSION%' "$ROOT"/target/rootfs-current/var/lib/pacman/local/glibc-*/desc | tail -1)"
echo "2021 glibc:    $(grep -A1 '%VERSION%' "$ROOT"/target/rootfs-2021/var/lib/pacman/local/glibc-*/desc | tail -1)"

step "status / check on the current system (expected: safe)"
"$CLI" --root "$ROOT/target/rootfs-current" status
"$CLI" --root "$ROOT/target/rootfs-current" check xz
"$CLI" --root "$ROOT/target/rootfs-current" install xz --dry-run | grep -q '^Would run: pacman -U' || { echo "dry-run did not produce a pacman -U command"; exit 1; }

step "check on the January 2021 system (expected: BLOCKED, exit 2)"
set +e
"$CLI" --root "$ROOT/target/rootfs-2021" check xz
code=$?
set -e
[[ $code -eq 2 ]] || { echo "expected exit 2, got $code"; exit 1; }
json="$("$CLI" --root "$ROOT/target/rootfs-2021" --json check xz || true)"
grep -q '"severity": "blocker"' <<<"$json"
echo "blocked as expected — pacman was never invoked"

if command -v cargo-zigbuild >/dev/null 2>&1; then
  step "Cross-compile and run 'omarchy-cli upgrade' inside $CURRENT"
  rustup target add x86_64-unknown-linux-musl >/dev/null 2>&1 || true
  cargo zigbuild -q --release --target x86_64-unknown-linux-musl -p omarchy-cli
  E="$ROOT/target/e2e-client"
  rm -rf "$E" && mkdir -p "$E"
  cp "$ROOT/target/x86_64-unknown-linux-musl/release/omarchy-cli" "$E/"
  cp "$PUBKEY" "$E/omarchy-poc.pub.asc"
  cat > "$E/check.sh" <<CHECK
set -euo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key poc@omarchy.invalid >/dev/null 2>&1
export OMARCHY_API=$OMARCHY_API
# pacman 7's seccomp download sandbox cannot run under x86_64 emulation.
sed -i 's/^#DisableSandboxSyscalls/DisableSandboxSyscalls/' /etc/pacman.conf
grep -q '^DisableSandboxSyscalls' /etc/pacman.conf || sed -i '0,/^\\[options\\]/s//[options]\\nDisableSandboxSyscalls/' /etc/pacman.conf
echo "--- status"; /repo/omarchy-cli status
echo "--- upgrade"; /repo/omarchy-cli upgrade --noconfirm 2>&1 | grep -vE 'warning: database file'
echo "--- pacman -Q xz"; pacman -Q xz 2>/dev/null
echo "--- status after"; /repo/omarchy-cli status | grep -E 'Pinned|Updates'
echo "--- upgrade again"; /repo/omarchy-cli upgrade --noconfirm | grep -q 'Nothing to do'
CHECK
  "$RUNTIME" run --rm --platform linux/amd64 -v "$E:/repo:ro" "$CURRENT" bash /repo/check.sh
else
  step "cargo-zigbuild not installed; skipping the in-container upgrade (brew install zig && cargo install cargo-zigbuild)"
fi

step "OK — thin client: release awareness, ABI safety check, pacman-driven upgrade"
