#!/usr/bin/env bash
# The second reference system for the ABI gate: what an Omarchy installation
# actually has. The ISO pacstraps `install/omarchy-base.packages` of
# omacom/omarchy (plus the archinstall base); this script installs that set
# from the pool's own ring into a fresh Arch container, exports pacman's
# database and the shared libraries, and caches the slice for seven days —
# a few hundred megabytes, a few gigabytes downloaded to make it, so not
# every gate run. x86_64 only: the ISO is.
#
# Usage: tests/omarchy-rootfs.sh <arch> [ring]  → prints the rootfs directory
# Env:   OMARCHY_API, OMARCHY_POOL, OMARCHY_WORK_DIR (cache, default /var/tmp/omarchy-pool-worker)
#        OMARCHY_KEYRINGS (omarchy.gpg verifies the OPR's packages)
set -uo pipefail

ARCH="${1:-x86_64}"
RING="${2:-stable}"
[[ "$ARCH" == x86_64 ]] || { echo "the Omarchy reference exists for x86_64 only" >&2; exit 3; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/tests/images.env"
CACHE="${OMARCHY_WORK_DIR:-/var/tmp/omarchy-pool-worker}/omarchy-rootfs/$ARCH"
RUNTIME="$(command -v docker || command -v podman)"
POOL="${OMARCHY_POOL:?}"
API="${OMARCHY_API:?}"
LIST_URL="https://raw.githubusercontent.com/omacom/omarchy/quattro/install/omarchy-base.packages"
BASE_URL="https://raw.githubusercontent.com/omacom/omarchy-iso/quattro/builder/archinstall.packages"
MAX_AGE_DAYS=7

fresh() {
  [[ -f "$CACHE/.built" && -d "$CACHE/var/lib/pacman/local" ]] || return 1
  local built now
  built=$(cat "$CACHE/.built"); now=$(date +%s)
  [[ $(( (now - built) / 86400 )) -lt $MAX_AGE_DAYS ]]
}
if fresh; then echo "$CACHE"; exit 0; fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# The ISO's package set, minus what a container neither needs nor can set
# up (kernels, firmware, boot loaders, microcode, snapshots), minus names
# the ring does not serve for this architecture (pacman refuses a whole
# transaction for one unknown target).
{ curl -sfL "$LIST_URL"; echo; curl -sfL "$BASE_URL"; } | grep -v '^#' | grep -vE '^\s*$' | sort -u > "$WORK/wanted.txt" || { echo "could not fetch the package lists" >&2; exit 1; }
grep -vE '^(linux|linux-[a-z]+|linux-firmware|limine|efibootmgr|amd-ucode|intel-ucode|snapper|base|base-devel)$' "$WORK/wanted.txt" > "$WORK/wanted2.txt"
curl -sf "$API/api/v1/releases/$RING?fields=summary&arch=$ARCH" | python3 -c '
import json, sys
served = {p["name"] for p in json.load(sys.stdin)["packages"]}
wanted = [l.strip() for l in open(sys.argv[1]) if l.strip()]
have = [n for n in wanted if n in served]
print("\n".join(have))
print(f"{len(have)} of {len(wanted)} wanted packages are served by {sys.argv[2]}", file=sys.stderr)
' "$WORK/wanted2.txt" "$RING" > "$WORK/install.txt" || { echo "could not read the ring" >&2; exit 1; }
[[ -s "$WORK/install.txt" ]] || { echo "nothing of the Omarchy set is served by $RING" >&2; exit 1; }

repos=$(for src in core extra multilib packages factory; do
  if curl -sfI --max-time 20 "$POOL/$ARCH/omarchy-$src-$RING.db" >/dev/null; then echo "omarchy-$src-$RING"; fi
done)
# The databases must be the pool's (signed); the packages are installed as
# bytes for their libraries — whether their signatures verify is the health
# check's and the verify job's question, not this reference's.
{
  echo "[options]"; echo "Architecture = $ARCH"; echo "SigLevel = DatabaseRequired PackageNever"
  echo "DisableSandbox"
  for repo in $repos; do printf '\n[%s]\nServer = %s/$arch\n' "$repo" "$POOL"; done
} > "$WORK/pacman.conf"
cp "$ROOT/docs/omarchy-staging.pub.asc" "$WORK/omarchy-poc.pub.asc"
if [[ -n "${OMARCHY_KEYRINGS:-}" && -f "$OMARCHY_KEYRINGS/omarchy.gpg" ]]; then cp "$OMARCHY_KEYRINGS/omarchy.gpg" "$WORK/omarchy.gpg"; fi
cat > "$WORK/build.sh" <<'BUILD'
set -euo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --populate archlinux >/dev/null 2>&1 || true
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key staging@firemanxbr.org >/dev/null 2>&1
if [[ -f /repo/omarchy.gpg ]]; then
  pacman-key --add /repo/omarchy.gpg >/dev/null 2>&1
  for k in $(gpg --homedir /etc/pacman.d/gnupg --with-colons --list-keys 2>/dev/null | awk -F: '$1=="pub"{id=$5} $1=="uid" && $10 ~ /omarchy\.org/ {print id}'); do pacman-key --lsign-key "$k" >/dev/null 2>&1 || true; done
fi
pacman --config /repo/pacman.conf -Sy >/dev/null
# --ask 4: take the default on provider choices; --overwrite: a container's
# stray files must not fail the transaction; hooks may complain, the
# packages still land.
mapfile -t pkgs < /repo/install.txt
pacman --config /repo/pacman.conf -S --noconfirm --needed --ask 4 --overwrite '*' "${pkgs[@]}" > /repo/install.log 2>&1 || {
  echo "pacman failed:"; tail -20 /repo/install.log; exit 1
}
n=$(ls /var/lib/pacman/local | wc -l)
echo "installed: $n packages"
tar -C / -cf /repo/rootfs.tar var/lib/pacman/local usr/lib/lib*.so* 2>/dev/null
BUILD
echo "building the Omarchy reference from $RING ($(wc -l < "$WORK/install.txt" | tr -d ' ') packages) — a few minutes" >&2
# OMARCHY_PKG_CACHE: a package cache the host shares with its build
# containers (one directory per architecture) — the reference downloads once.
cache_mount=()
if [[ -n "${OMARCHY_PKG_CACHE:-}" ]]; then mkdir -p "$OMARCHY_PKG_CACHE/x86_64"; cache_mount=(-v "$OMARCHY_PKG_CACHE/x86_64:/var/cache/pacman/pkg"); fi
"$RUNTIME" run --rm --platform linux/amd64 -v "$WORK:/repo" ${cache_mount[@]+"${cache_mount[@]}"} "$ARCHLINUX_BASE" bash /repo/build.sh >&2 || exit 1
rm -rf "$CACHE"; mkdir -p "$CACHE"
tar -xf "$WORK/rootfs.tar" -C "$CACHE"
date +%s > "$CACHE/.built"
cp "$WORK/install.txt" "$CACHE/.packages"
echo "$CACHE"
