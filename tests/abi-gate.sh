#!/usr/bin/env bash
# ABI gate for one ring: would upgrading a reference system to what the ring
# serves leave it with unsatisfiable symbol versions? Two references: the
# official Arch (x86_64) / Arch Linux ARM (aarch64) base image, and — on
# x86_64 — an Omarchy installation, the ISO's package set installed from the
# ring (tests/omarchy-rootfs.sh, cached a week). For each, its pacman
# database and libraries are exported, `omarchy-cli status` lists the packages
# the ring would upgrade, and `omarchy-cli check` runs the ELF-level safety
# check on them in batches. Posts an `abi` event; exits 2 on any blocker in
# either reference.
#
# Usage: tests/abi-gate.sh <ring> [arch]   (arch: x86_64 | aarch64)
# Env:   OMARCHY_API, OMARCHY_POOL, OMARCHY_TOKEN, OMARCHY_WORK_DIR, OMARCHY_KEYRINGS
set -uo pipefail

RING="$1"
ARCH="${2:-x86_64}"
source "$(cd "$(dirname "$0")" && pwd)/images.env"
case "$ARCH" in
  x86_64)  IMAGE="$ARCHLINUX_BASE"; PLATFORM="linux/amd64" ;;
  aarch64) IMAGE="$ARCHLINUXARM_BASE"; PLATFORM="linux/arm64" ;;
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

# One reference: pacman's database and libraries under $2, checked as $1.
# Leaves $WORK/ref-$1.json (the numbers) and prints the blockers.
check_reference() { # name rootfs
  local name="$1" rootfs="$2" installed status_json updates=() checked=0 failed_batches=0 n=0 batch code blockers warnings details
  installed=$(ls "$rootfs/var/lib/pacman/local" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$installed" == "0" ]]; then
    echo "{\"name\": \"$name\", \"error\": \"no pacman database\"}" > "$WORK/ref-$name.json"; return
  fi
  status_json=$("$CLI" --api "$OMARCHY_API" --pool "$OMARCHY_POOL" --ring "$RING" --arch "$ARCH" --root "$rootfs" --json status 2>"$WORK/status.err")
  if [[ $? -ne 0 ]]; then
    if grep -qi "no release" "$WORK/status.err"; then echo "{\"name\": \"$name\", \"no_release\": true}" > "$WORK/ref-$name.json"; return; fi
    echo "{\"name\": \"$name\", \"error\": $(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[-800:]))' < "$WORK/status.err")}" > "$WORK/ref-$name.json"
    cat "$WORK/status.err"; return
  fi
  while IFS= read -r pkg; do [[ -n "$pkg" ]] && updates+=("$pkg"); done < <(python3 -c 'import json,sys; print("\n".join(u["name"] for u in json.load(sys.stdin).get("updates", [])))' <<<"$status_json")
  echo "$RING $ARCH: reference $name has $installed packages, ${#updates[@]} would be upgraded"
  rm -f "$WORK"/plan-*.json
  if [[ ${#updates[@]} -gt 0 ]]; then
    for ((i = 0; i < ${#updates[@]}; i += 40)); do
      batch=("${updates[@]:i:40}")
      n=$((n + 1))
      "$CLI" --api "$OMARCHY_API" --pool "$OMARCHY_POOL" --ring "$RING" --arch "$ARCH" --root "$rootfs" --json check "${batch[@]}" >"$WORK/plan-$n.json" 2>"$WORK/check.err"
      code=$?
      if [[ $code -ne 0 && $code -ne 2 ]]; then
        failed_batches=$((failed_batches + 1)); echo "check failed (exit $code): $(tail -1 "$WORK/check.err")"; rm -f "$WORK/plan-$n.json"; continue
      fi
      checked=$((checked + ${#batch[@]}))
    done
  fi
  read -r blockers warnings < <(python3 "$WORK/tally.py" "$WORK")
  details=$(cat "$WORK/details.json")
  for f in "$WORK"/plan-*.json; do [[ -f "$f" ]] && python3 -c 'import json,sys; [print("  BLOCKER (" + sys.argv[2] + ") " + x["package"] + ": " + x["requirement"] + " — " + x["detail"]) for x in json.load(open(sys.argv[1])).get("findings", []) if x["severity"] == "blocker"]' "$f" "$name"; done
  echo "{\"name\": \"$name\", \"installed\": $installed, \"updates\": ${#updates[@]}, \"checked\": $checked, \"blockers\": $blockers, \"warnings\": $warnings, \"failed_batches\": $failed_batches, \"details\": $details}" > "$WORK/ref-$name.json"
}

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

# Reference 1: the distribution's base image.
cid="$("$RUNTIME" create --platform "$PLATFORM" "$IMAGE" true)"
mkdir -p "$WORK/rootfs"
if tar --version 2>/dev/null | grep -q GNU; then
  "$RUNTIME" export "$cid" | tar -x -C "$WORK/rootfs" --wildcards 'var/lib/pacman/local/*' 'usr/lib/lib*.so*' 2>/dev/null || true
else
  "$RUNTIME" export "$cid" | tar -x -C "$WORK/rootfs" --include 'var/lib/pacman/local/*' --include 'usr/lib/lib*.so*' 2>/dev/null || true
fi
"$RUNTIME" rm "$cid" >/dev/null
if [[ "$(ls "$WORK/rootfs/var/lib/pacman/local" 2>/dev/null | wc -l | tr -d ' ')" == "0" ]]; then
  post error "$RING $ARCH: could not export the reference system from $IMAGE" '{}'
  echo "no pacman database exported from $IMAGE"; rm -rf "$WORK"; exit 1
fi
check_reference base "$WORK/rootfs"

# Reference 2 (x86_64): an Omarchy installation — the ISO's package set from
# the ring, cached a week. Missing (first run, build failed) is noted, not fatal.
omarchy_ref=""
if [[ "$ARCH" == x86_64 ]]; then
  omarchy_ref="$(OMARCHY_API="$OMARCHY_API" OMARCHY_POOL="$OMARCHY_POOL" "$ROOT/tests/omarchy-rootfs.sh" "$ARCH" "$RING" 2>"$WORK/rootfs.err")" || omarchy_ref=""
  if [[ -n "$omarchy_ref" ]]; then
    check_reference omarchy "$omarchy_ref"
  else
    echo "{\"name\": \"omarchy\", \"error\": $(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[-400:]))' < "$WORK/rootfs.err")}" > "$WORK/ref-omarchy.json"
    echo "$RING $ARCH: no Omarchy reference this run ($(tail -1 "$WORK/rootfs.err"))"
  fi
fi

# The verdict over every reference. (A heredoc inside a process substitution
# is mangled by macOS's bash 3.2, which the project workers run: a file.)
cat > "$WORK/verdict.py" <<'PY'
import glob, json, sys
refs = [json.load(open(f)) for f in sorted(glob.glob(sys.argv[1] + "/ref-*.json"))]
base = next((r for r in refs if r["name"] == "base"), {})
tot = lambda k: sum(r.get(k, 0) for r in refs if "error" not in r and "no_release" not in r)
parts = []
for r in refs:
    if "no_release" in r: parts.append(r["name"] + ": no release")
    elif "error" in r: parts.append(r["name"] + ": unavailable")
    else: parts.append("%s: %d upgrade(s), %d blocker(s)" % (r["name"], r.get("updates", 0), r.get("blockers", 0)))
json.dump({"image": sys.argv[2], "references": refs, "installed": base.get("installed", 0), "updates": tot("updates"), "checked": tot("checked"), "blockers": tot("blockers"), "warnings": tot("warnings"), "failed_batches": tot("failed_batches"), "details": [d for r in refs for d in r.get("details", [])][:20]}, open(sys.argv[1] + "/payload.json", "w"))
print(0 if "error" in base or "no_release" in base else 1, tot("blockers"), tot("warnings"), tot("failed_batches"), tot("checked"), tot("updates"), "|".join(parts).replace(" ", "_"))
PY
read -r base_ok blockers warnings failed checked updates summary_refs < <(python3 "$WORK/verdict.py" "$WORK" "$IMAGE")
payload=$(cat "$WORK/payload.json")
summary_refs="${summary_refs//_/ }"
rm -rf "$WORK"

if [[ "$base_ok" == 0 ]]; then
  if grep -q "no release" <<<"$summary_refs"; then post warn "$RING $ARCH: no release to check" "$payload"; echo "$RING $ARCH: no release"; exit 0; fi
  post error "$RING $ARCH: omarchy-cli status failed on the base reference" "$payload"; exit 1
elif [[ $failed -gt 0 ]]; then
  post error "$RING $ARCH: ABI check incomplete ($failed batch(es) failed) — ${summary_refs//|/; }" "$payload"; exit 1
elif [[ $blockers -gt 0 ]]; then
  post error "$RING $ARCH: $blockers ABI blocker(s) across $checked upgrade(s) — ${summary_refs//|/; }" "$payload"
  echo "BLOCKED: $blockers unsatisfiable symbol version(s)"; exit 2
else
  post ok "$RING $ARCH: $updates upgrade(s), no ABI blocker ($warnings warning(s)) — ${summary_refs//|/; }" "$payload"
  echo "ABI OK"; exit 0
fi
