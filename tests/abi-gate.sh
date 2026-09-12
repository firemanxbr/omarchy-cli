#!/usr/bin/env bash
# ABI gate for one ring: would upgrading a reference Arch system to what the
# ring serves leave it with unsatisfiable symbol versions? The reference is the
# official Arch (x86_64) / Arch Linux ARM (aarch64) base image: its pacman
# database and libraries are exported, `omarchy-cli status` lists the packages
# the ring would upgrade, and `omarchy-cli check` runs the ELF-level safety
# check on them in batches. Posts an `abi` event; exits 2 on any blocker.
#
# Usage: tests/abi-gate.sh <ring> [arch]   (arch: x86_64 | aarch64)
# Env:   OMARCHY_API, OMARCHY_POOL, OMARCHY_PUBLISH_TOKEN
set -uo pipefail

RING="$1"
ARCH="${2:-x86_64}"
case "$ARCH" in
  x86_64)  IMAGE="docker.io/library/archlinux:base"; PLATFORM="linux/amd64" ;;
  aarch64) IMAGE="docker.io/menci/archlinuxarm:base"; PLATFORM="linux/arm64" ;;
  *) echo "unknown arch $ARCH"; exit 1 ;;
esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_REPO="${PKG_REPO:-$ROOT/target/release/pkg-repo}"
CLI="${OMARCHY_CLI:-$ROOT/target/release/omarchy-cli}"
RUNTIME="$(command -v docker || command -v podman)"
WORK="$(mktemp -d)"
ms() { python3 -c "import time; print(int(time.time()*1000))"; }
started=$(ms)

post() { # status summary payload
  "$PKG_REPO" event --kind abi --ring "$RING" --source "$ARCH" --status "$1" --summary "$2" \
    --duration-ms $(( $(ms) - started )) --payload "$3" >/dev/null 2>&1 || true
}

# Reference system: pacman's local database plus the shared libraries.
cid="$("$RUNTIME" create --platform "$PLATFORM" "$IMAGE" true)"
mkdir -p "$WORK/rootfs"
if tar --version 2>/dev/null | grep -q GNU; then
  "$RUNTIME" export "$cid" | tar -x -C "$WORK/rootfs" --wildcards 'var/lib/pacman/local/*' 'usr/lib/lib*.so*' 2>/dev/null || true
else
  "$RUNTIME" export "$cid" | tar -x -C "$WORK/rootfs" --include 'var/lib/pacman/local/*' --include 'usr/lib/lib*.so*' 2>/dev/null || true
fi
"$RUNTIME" rm "$cid" >/dev/null
installed=$(ls "$WORK/rootfs/var/lib/pacman/local" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$installed" == "0" ]]; then
  post error "$RING $ARCH: could not export the reference system from $IMAGE" '{}'
  echo "no pacman database exported from $IMAGE"; rm -rf "$WORK"; exit 1
fi

status_json=$("$CLI" --api "$OMARCHY_API" --pool "$OMARCHY_POOL" --ring "$RING" --arch "$ARCH" --root "$WORK/rootfs" --json status 2>"$WORK/status.err")
if [[ $? -ne 0 ]]; then
  if grep -qi "no release" "$WORK/status.err"; then
    post warn "$RING $ARCH: no release to check" '{}'
    echo "$RING $ARCH: no release"; rm -rf "$WORK"; exit 0
  fi
  post error "$RING $ARCH: omarchy-cli status failed" "{\"error\": $(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[-800:]))' < "$WORK/status.err")}"
  cat "$WORK/status.err"; rm -rf "$WORK"; exit 1
fi
updates=()
while IFS= read -r name; do [[ -n "$name" ]] && updates+=("$name"); done < <(python3 -c 'import json,sys; print("\n".join(u["name"] for u in json.load(sys.stdin).get("updates", [])))' <<<"$status_json")
echo "$RING $ARCH: reference $IMAGE has $installed packages, $((${#updates[@]})) would be upgraded"

checked=0; failed_batches=0; n=0
if [[ ${#updates[@]} -gt 0 ]]; then
  for ((i = 0; i < ${#updates[@]}; i += 40)); do
    batch=("${updates[@]:i:40}")
    n=$((n + 1))
    "$CLI" --api "$OMARCHY_API" --pool "$OMARCHY_POOL" --ring "$RING" --arch "$ARCH" --root "$WORK/rootfs" --json check "${batch[@]}" >"$WORK/plan-$n.json" 2>"$WORK/check.err"
    code=$?
    if [[ $code -ne 0 && $code -ne 2 ]]; then
      failed_batches=$((failed_batches + 1)); echo "check failed (exit $code): $(tail -1 "$WORK/check.err")"; rm -f "$WORK/plan-$n.json"; continue
    fi
    checked=$((checked + ${#batch[@]}))
  done
fi
# Totals over every batch: blockers, warnings, and the first blockers for the event.
cat > "$WORK/tally.py" <<'PY'
import glob, json, sys
b = w = 0
details = []
for f in sorted(glob.glob(sys.argv[1] + "/plan-*.json")):
    for x in json.load(open(f)).get("findings", []):
        if x.get("severity") == "blocker":
            b += 1
            if len(details) < 20:
                details.append({"package": x.get("package"), "requirement": x.get("requirement"), "detail": x.get("detail")})
        elif x.get("severity") == "warning":
            w += 1
json.dump(details, open(sys.argv[1] + "/details.json", "w"))
print(b, w)
PY
read -r blockers warnings < <(python3 "$WORK/tally.py" "$WORK")
details=$(cat "$WORK/details.json")
for f in "$WORK"/plan-*.json; do [[ -f "$f" ]] && python3 -c 'import json,sys; [print("  BLOCKER " + x["package"] + ": " + x["requirement"] + " — " + x["detail"]) for x in json.load(open(sys.argv[1])).get("findings", []) if x["severity"] == "blocker"]' "$f"; done
rm -rf "$WORK"

payload="{\"image\": \"$IMAGE\", \"installed\": $installed, \"updates\": ${#updates[@]}, \"checked\": $checked, \"blockers\": $blockers, \"warnings\": $warnings, \"failed_batches\": $failed_batches, \"details\": $details}"
if [[ $failed_batches -gt 0 ]]; then
  post error "$RING $ARCH: ABI check incomplete ($failed_batches batch(es) failed)" "$payload"; exit 1
elif [[ $blockers -gt 0 ]]; then
  post error "$RING $ARCH: $blockers ABI blocker(s) across $checked upgrade(s) from $IMAGE" "$payload"
  echo "BLOCKED: $blockers unsatisfiable symbol version(s)"; exit 2
else
  post ok "$RING $ARCH: ${#updates[@]} upgrade(s) from $IMAGE, no ABI blocker ($warnings warning(s))" "$payload"
  echo "ABI OK"; exit 0
fi
