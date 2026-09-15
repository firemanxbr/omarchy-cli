#!/usr/bin/env bash
# omarchy-pool setup — point pacman at a ring of the pool, in one command.
#
#   curl -fsSL __API__/setup | sudo bash -s -- --ring stable
#
# Options: --ring stable|rc|edge (default stable) · --with chaotic (optional sources) · --remove (undo)
#
# What it does, and nothing else:
#   1. trusts the key that signs the pool's databases (once);
#   2. writes /etc/pacman.d/omarchy-pool.conf — the repositories the ring serves right now;
#   3. adds one line to /etc/pacman.conf, above [core]:  Include = /etc/pacman.d/omarchy-pool.conf  (once);
#   4. refreshes the databases (pacman -Sy) and tells you to run: sudo pacman -Syu
# Your own repositories stay where they are: what is above [core] keeps priority, what is below is the fallback.
set -euo pipefail
API="__API__/api/v1"; POOL="__POOL__"
CONF="${PACMAN_CONF:-/etc/pacman.conf}"; INC="${POOL_INCLUDE:-/etc/pacman.d/omarchy-pool.conf}"
RING=stable; WITH=""; REMOVE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ring) RING="$2"; shift 2 ;;
    --with) WITH="$2"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) echo "usage: curl -fsSL __API__/setup | sudo bash -s -- [--ring stable|rc|edge] [--with chaotic] [--remove]"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ "$RING" == stable || "$RING" == rc || "$RING" == edge ]] || { echo "--ring must be stable, rc or edge" >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo "run it with sudo:  curl -fsSL __API__/setup | sudo bash -s -- --ring $RING" >&2; exit 1; }
ARCH="$(uname -m)"; [[ "$ARCH" == arm64 ]] && ARCH=aarch64
[[ "$ARCH" == x86_64 || "$ARCH" == aarch64 ]] || { echo "the pool serves x86_64 and aarch64; this machine is $ARCH" >&2; exit 1; }
[[ -f "$CONF" ]] || { echo "no $CONF here — is this Arch?" >&2; exit 1; }

if [[ $REMOVE -eq 1 ]]; then
  rm -f "$INC"
  if grep -q "^Include = $INC" "$CONF"; then
    cp "$CONF" "$CONF.bak-omarchy-pool"
    awk -v inc="Include = $INC" '$0 == inc { skip = 1; next } skip && $0 == "" { skip = 0; next } { skip = 0; print }' "$CONF" > "$CONF.new" && mv "$CONF.new" "$CONF"
  fi
  pacman -Sy >/dev/null 2>&1 || true
  echo "omarchy-pool: removed. pacman is back on its own repositories."
  exit 0
fi

# 1. The key that signs the databases (packages keep their upstream signatures).
if ! pacman-key --list-keys staging@firemanxbr.org >/dev/null 2>&1; then
  key="$(mktemp)"; curl -fsSL "$POOL/omarchy-staging.pub.asc" -o "$key"
  pacman-key --add "$key" >/dev/null && pacman-key --lsign-key staging@firemanxbr.org >/dev/null
  rm -f "$key"; echo "omarchy-pool: the database key is trusted (staging@firemanxbr.org)"
fi

# 2. The repositories: what the ring serves right now, from the pool itself.
mkdir -p "$(dirname "$INC")"
curl -fsSL "$API/pacman.conf?ring=$RING&arch=$ARCH${WITH:+&with=$WITH}" -o "$INC.new"
grep -q '^\[omarchy-' "$INC.new" || { rm -f "$INC.new"; echo "the pool has no databases for $RING/$ARCH yet — see $POOL" >&2; exit 1; }
mv "$INC.new" "$INC"; chmod 644 "$INC"

# 3. One line in pacman.conf, above [core], once.
if ! grep -q "^Include = $INC" "$CONF"; then
  cp "$CONF" "$CONF.bak-omarchy-pool"
  if grep -q '^\[core\]' "$CONF"; then
    awk -v inc="Include = $INC" '!done && /^\[core\]/ { print inc; print ""; done = 1 } { print }' "$CONF" > "$CONF.new"
  else
    { cat "$CONF"; echo; echo "Include = $INC"; } > "$CONF.new"
  fi
  mv "$CONF.new" "$CONF"
  echo "omarchy-pool: $CONF includes $INC above [core] (backup: $CONF.bak-omarchy-pool)"
fi

# 4. The databases.
pacman -Sy
echo
echo "omarchy-pool: ring $RING for $ARCH — $(grep -c '^\[omarchy-' "$INC") repositories in $INC."
echo "Now run:  sudo pacman -Syu"
