#!/usr/bin/env bash
# End-to-end: render a signed pacman database from the fixture packages and
# verify that a real pacman accepts it.
#
# Requires: cargo, gpg, and podman or docker. Runs entirely locally; the
# repository is served to the container as a bind mount over file://.
#
# Usage: tests/e2e-pacman.sh [--keep]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E="$ROOT/target/e2e"
GNUPGHOME="${OMARCHY_POC_GNUPGHOME:-$HOME/.cache/omarchy-cli-poc/gnupg}"
export GNUPGHOME
source "$(cd "$(dirname "$0")" && pwd)/images.env"; IMAGE="$ARCHLINUX_BASE"
RUNTIME="$(command -v podman || command -v docker)"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "Throwaway signing key"
if ! gpg --list-secret-keys poc@omarchy.invalid >/dev/null 2>&1; then
  mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"
  gpg --batch --quiet --passphrase '' --quick-generate-key \
    "Omarchy POC Signing (throwaway, do not use) <poc@omarchy.invalid>" ed25519 sign 30d
fi
KEYID="$(gpg --list-keys --with-colons poc@omarchy.invalid | awk -F: '/^fpr/{print $10; exit}')"
echo "key: $KEYID"

step "Render repository into $E2E"
rm -rf "$E2E"
MIRROR="$E2E/omarchy/os/x86_64"
mkdir -p "$MIRROR"
cargo run -q -p pkg-extract -- index "$ROOT/crates/pkg-extract/tests/fixtures" -o "$E2E/index.json"
cargo run -q -p pkg-repo -- build --index "$E2E/index.json" --repo omarchy --out "$MIRROR" --sign "$KEYID"
cp "$ROOT"/crates/pkg-extract/tests/fixtures/*.pkg.tar.zst "$MIRROR/"
# Package signatures normally come from the Arch mirror or the OPR build; here
# the same throwaway key stands in for both.
for pkg in "$MIRROR"/*.pkg.tar.zst; do
  gpg --batch --yes --detach-sign --no-armor --local-user "$KEYID" --output "$pkg.sig" "$pkg"
done
gpg --armor --export "$KEYID" > "$E2E/omarchy-poc.pub.asc"

cat > "$E2E/pacman.conf" <<CONF
[options]
Architecture = x86_64
SigLevel = Required DatabaseRequired
LocalFileSigLevel = Optional

[omarchy]
Server = file:///repo/\$repo/os/\$arch
CONF

cat > "$E2E/check.sh" <<'CHECK'
set -euo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key poc@omarchy.invalid >/dev/null 2>&1

echo "--- pacman -Sy (signed database must be accepted)"
pacman --config /repo/pacman.conf -Sy

echo "--- pacman -Sl omarchy"
pacman --config /repo/pacman.conf -Sl omarchy

echo "--- pacman -Si zlib"
pacman --config /repo/pacman.conf -Si zlib

echo "--- pacman -Sp zlib xz (resolve download URLs from the index)"
pacman --config /repo/pacman.conf -Sp zlib xz

echo "--- pacman -Fy / -Fl xz (files database)"
pacman --config /repo/pacman.conf -Fy >/dev/null
pacman --config /repo/pacman.conf -Fl xz | head -3

echo "--- pacman -Sw zlib xz (download, verify sha256 and package signatures)"
pacman --config /repo/pacman.conf -Sw --noconfirm zlib xz
ls /var/cache/pacman/pkg/ | grep -E "^(zlib|xz)-"

echo "--- pacman -U from cache (install the downloaded package for real)"
pacman --config /repo/pacman.conf -U --noconfirm /var/cache/pacman/pkg/xz-5.8.4-1-x86_64.pkg.tar.zst
pacman -Q xz
CHECK

step "Run pacman inside $IMAGE"
"$RUNTIME" run --rm --platform linux/amd64 -v "$E2E:/repo:ro" "$IMAGE" bash /repo/check.sh

step "OK — pacman accepted the generated, signed database"
