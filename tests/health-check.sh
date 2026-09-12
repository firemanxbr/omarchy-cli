#!/usr/bin/env bash
# Health check for one ring: a real pacman in an Arch container syncs the
# ring's databases from the pool, lists them, and downloads one package with
# signature verification. Posts a `health` event either way.
#
# Usage: tests/health-check.sh <ring>
# Env:   OMARCHY_API, OMARCHY_POOL, OMARCHY_PUBLISH_TOKEN
set -uo pipefail

RING="$1"
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
        print(" ".join(sorted({a["repo"] for a in r["artifacts"] if a["kind"] == "db"})))
' "$RING")

post() { # status summary payload
  "$PKG_REPO" event --kind health --ring "$RING" --status "$1" --summary "$2" \
    --duration-ms $(( $(ms) - started )) --payload "$3" >/dev/null 2>&1 || true
}

if [[ -z "$repos" ]]; then
  post warn "$RING: no databases rendered yet" '{}'
  echo "$RING: nothing rendered"; exit 0
fi

{
  echo "[options]"
  echo "Architecture = x86_64"
  echo "SigLevel = Required DatabaseRequired"
  for repo in $repos; do printf '\n[%s]\nServer = %s/$arch\n' "$repo" "$POOL"; done
} > "$WORK/pacman.conf"
cp "$ROOT/docs/omarchy-poc.pub.asc" "$WORK/"
cat > "$WORK/check.sh" <<'CHECK'
set -euo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key poc@omarchy.invalid >/dev/null 2>&1
pacman --config /repo/pacman.conf -Sy
total=0
for repo in $(grep -oE '^\[[a-z0-9-]+\]' /repo/pacman.conf | tr -d '[]' | grep -v options); do
  n=$(pacman --config /repo/pacman.conf -Sl "$repo" | wc -l); echo "$repo: $n packages"; total=$((total + n))
done
first=$(pacman --config /repo/pacman.conf -Sl | awk '$1 != "" {print $2; exit}')
pacman --config /repo/pacman.conf -Sw --noconfirm "$first"
echo "downloaded+verified $first"
echo "TOTAL=$total"
CHECK

out=$("$RUNTIME" run --rm -v "$WORK:/repo:ro" docker.io/library/archlinux:base bash /repo/check.sh 2>&1)
code=$?
total=$(grep -oE '^TOTAL=[0-9]+' <<<"$out" | cut -d= -f2)
echo "$out"
if [[ $code -eq 0 ]]; then
  post ok "$RING: pacman -Sy + signed download OK ($total packages across $(wc -w <<<"$repos" | tr -d " ") repos)" \
    "{\"repos\": \"$repos\", \"packages\": ${total:-0}}"
else
  post error "$RING: pacman check failed (exit $code)" "{\"repos\": \"$repos\", \"tail\": $(tail -5 <<<"$out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"
fi
rm -rf "$WORK"
exit $code
