#!/usr/bin/env bash
# Health check for one ring: a real pacman in an Arch container syncs the
# ring's databases from the pool, lists them, and downloads one package with
# signature verification. Posts a `health` event either way.
#
# Usage: tests/health-check.sh <ring> [arch]   (arch: x86_64 | aarch64)
# Env:   OMARCHY_API, OMARCHY_POOL, OMARCHY_TOKEN
#        OMARCHY_KEYRINGS  directory from tests/fetch-keyrings.sh (omarchy.gpg verifies the OPR's packages)
# The container is what an Omarchy machine has: the distribution's keyring
# plus Omarchy's key. chaotic-aur is opt-in and needs its own keyring, so its
# database is left out of the check.
set -uo pipefail

RING="$1"
ARCH="${2:-x86_64}"
case "$ARCH" in
  x86_64)  IMAGE="docker.io/library/archlinux:base"; PLATFORM="linux/amd64"; KEYRING="archlinux" ;;
  aarch64) IMAGE="docker.io/menci/archlinuxarm:base"; PLATFORM="linux/arm64"; KEYRING="archlinuxarm" ;;
  *) echo "unknown arch $ARCH"; exit 1 ;;
esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_REPO="${PKG_REPO:-$ROOT/target/release/pkg-repo}"
RUNTIME="$(command -v docker || command -v podman)"
POOL="${OMARCHY_POOL:?}"
WORK="$(mktemp -d)"
ms() { python3 -c "import time; print(int(time.time()*1000))"; }
started=$(ms)

repos=$(curl -sf "$OMARCHY_API/api/v1/stats" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for r in d["rings"]:
    if r["ring"] == sys.argv[1]:
        print(" ".join(sorted({a["repo"] for a in r["artifacts"] if a["kind"] == "db" and a["arch"] == sys.argv[2] and "-chaotic-" not in a["repo"]})))
' "$RING" "$ARCH")

post() { # status summary payload
  "$PKG_REPO" event --kind health --ring "$RING" --source "$ARCH" --status "$1" --summary "$2" \
    --duration-ms $(( $(ms) - started )) --payload "$3" >/dev/null 2>&1 || true
}

# The head release may not have been rendered for this architecture yet
# (a build or sync renders the architecture it touched); what users get is
# the latest rendered database at <arch>/<repo>.db, so check those.
if [[ -z "$repos" ]]; then
  for src in core extra multilib alarm packages factory; do
    if curl -sfI --max-time 20 "$POOL/$ARCH/omarchy-$src-$RING.db" >/dev/null; then repos="$repos omarchy-$src-$RING"; fi
  done
  repos="${repos# }"
fi
if [[ -z "$repos" ]]; then
  post error "$RING $ARCH: no database is served" '{}'
  echo "$RING $ARCH: nothing served"; exit 1
fi

{
  echo "[options]"
  echo "Architecture = $ARCH"
  echo "SigLevel = Required DatabaseRequired"
  for repo in $repos; do printf '\n[%s]\nServer = %s/$arch\n' "$repo" "$POOL"; done
} > "$WORK/pacman.conf"
cp "$ROOT/docs/omarchy-staging.pub.asc" "$WORK/omarchy-poc.pub.asc"
# Omarchy's key, as omarchy-keyring installs it, when the caller fetched the keyrings.
if [[ -n "${OMARCHY_KEYRINGS:-}" && -f "$OMARCHY_KEYRINGS/omarchy.gpg" ]]; then cp "$OMARCHY_KEYRINGS/omarchy.gpg" "$WORK/omarchy.gpg"; fi
# The check itself, run inside the container. Quoted heredoc: nothing in it
# expands on the host (an unquoted one silently produced an empty script —
# and an empty script exits 0, which read as "healthy").
cat > "$WORK/check.sh" <<'CHECK'
set -euo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --populate "$KEYRING" >/dev/null 2>&1 || true
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key staging@firemanxbr.org >/dev/null 2>&1
if [[ -f /repo/omarchy.gpg ]]; then
  pacman-key --add /repo/omarchy.gpg >/dev/null 2>&1
  for k in $(gpg --homedir /etc/pacman.d/gnupg --with-colons --list-keys 2>/dev/null | awk -F: '$1=="pub"{id=$5} $1=="uid" && $10 ~ /omarchy\.org/ {print id}'); do pacman-key --lsign-key "$k" >/dev/null 2>&1 || true; done
fi
pacman --config /repo/pacman.conf -Sy
total=0
for repo in $(grep -oE '^\[[a-z0-9-]+\]' /repo/pacman.conf | tr -d '[]' | grep -v options); do
  n=$(pacman --config /repo/pacman.conf -Sl "$repo" | wc -l); echo "$repo: $n packages"; total=$((total + n))
  # One package per repository, downloaded and verified against its upstream signature.
  first=$(pacman --config /repo/pacman.conf -Sl "$repo" | awk '{print $2; exit}')
  [[ -n "$first" ]] || { echo "$repo serves no package"; exit 1; }
  pacman --config /repo/pacman.conf -Sw --noconfirm "$repo/$first" >/dev/null
  echo "downloaded+verified $repo/$first"
done
echo "TOTAL=$total"
CHECK
[[ -s "$WORK/check.sh" ]] || { echo "check script was not written"; exit 1; }

out=$("$RUNTIME" run --rm --platform "$PLATFORM" -e KEYRING="$KEYRING" -v "$WORK:/repo:ro" "$IMAGE" bash /repo/check.sh 2>&1)
code=$?
total=$(grep -oE 'TOTAL=[0-9]+' <<<"$out" | tail -1 | cut -d= -f2)
echo "$out"
# A check that produced no total did not run: never call that healthy.
if [[ $code -eq 0 && -z "$total" ]]; then code=1; out="$out"$'\n'"no TOTAL line: the check did not run"; fi
if [[ $code -eq 0 ]]; then
  post ok "$RING $ARCH: pacman -Sy + signed download OK ($total packages across $(wc -w <<<"$repos" | tr -d " ") repos)" \
    "{\"repos\": \"$repos\", \"packages\": ${total:-0}}"
else
  post error "$RING $ARCH: pacman check failed (exit $code)" "{\"repos\": \"$repos\", \"tail\": $(tail -5 <<<"$out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"
fi
rm -rf "$WORK"
exit $code
