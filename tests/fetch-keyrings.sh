#!/usr/bin/env bash
# Builds the keyring files the sync verifies upstream package signatures
# against:
#   archlinux.gpg     from the archlinux-keyring package (Arch core, x86_64)
#   archlinuxarm.gpg  from the archlinuxarm-keyring package (Arch Linux ARM core)
#   omarchy.gpg       Omarchy's signing key, as shipped in omarchy-iso
#
# The keyring packages are fetched over HTTPS from the mirrors and are the one
# trust-on-first-use step of the pipeline; everything imported afterwards must
# verify against them.
#
# Usage: tests/fetch-keyrings.sh <out dir>
set -euo pipefail

OUT="$1"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

latest() { # base-url db-name package-name → filename from the sync db
  curl -sfL -A "pkg-repo" "$1/$2.db" -o "$TMP/$2.db"
  python3 - "$TMP/$2.db" "$3" <<'PY'
import io, sys, tarfile
raw = open(sys.argv[1], "rb").read()
if raw[:4] == b"\x28\xb5\x2f\xfd":
    import compression.zstd as zstd  # Python 3.14+
    raw = zstd.decompress(raw)
t = tarfile.open(fileobj=io.BytesIO(raw), mode="r:*")
for m in t.getmembers():
    if m.name.endswith("/desc"):
        d = t.extractfile(m).read().decode()
        name = d.split("%NAME%\n", 1)[1].split("\n", 1)[0]
        if name == sys.argv[2]:
            print(d.split("%FILENAME%\n", 1)[1].split("\n", 1)[0]); break
PY
}

extract_keyring() { # base-url filename path-in-archive out
  curl -sfL -A "pkg-repo" "$1/$2" -o "$TMP/$2"
  case "$2" in
    *.zst) tar --use-compress-program=unzstd -xOf "$TMP/$2" "$3" > "$4" ;;
    *) tar -xOf "$TMP/$2" "$3" > "$4" ;;
  esac
  echo "$4: $(stat -c%s "$4" 2>/dev/null || stat -f%z "$4") bytes (from $2)"
}

extract_keyring "https://mirror.omarchy.org/core/os/x86_64" \
  "$(latest https://mirror.omarchy.org/core/os/x86_64 core archlinux-keyring)" \
  usr/share/pacman/keyrings/archlinux.gpg "$OUT/archlinux.gpg"

extract_keyring "http://os.archlinuxarm.org/aarch64/core" \
  "$(latest http://os.archlinuxarm.org/aarch64/core core archlinuxarm-keyring)" \
  usr/share/pacman/keyrings/archlinuxarm.gpg "$OUT/archlinuxarm.gpg"

curl -sfL "https://raw.githubusercontent.com/omacom/omarchy-iso/quattro/builder/omarchy.gpg" -o "$OUT/omarchy.gpg"
echo "$OUT/omarchy.gpg: $(stat -c%s "$OUT/omarchy.gpg" 2>/dev/null || stat -f%z "$OUT/omarchy.gpg") bytes (omarchy-iso builder/omarchy.gpg)"
