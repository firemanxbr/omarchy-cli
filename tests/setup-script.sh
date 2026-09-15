#!/usr/bin/env bash
# worker/src/setup.sh against a pacman.conf like the Studio's (Asahi: [omarchy]
# and [asahi-alarm] above [core], Arch Linux ARM's mirrors below): the include
# lands above [core] once, what is above keeps its place, a second run changes
# nothing, --ring rewrites the include, --remove puts the file back.
# The network and pacman are stubs on PATH; root is a stub `id`.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/etc/pacman.d"
sed -e 's|__API__|https://pool.test|g' -e 's|__POOL__|https://pool.test/r2|g' "$here/../worker/src/setup.sh" > "$tmp/setup.sh"

cat > "$tmp/bin/id" <<'S'
#!/usr/bin/env bash
[[ "$1" == -u ]] && echo 0 || command id "$@"
S
cat > "$tmp/bin/curl" <<'S'
#!/usr/bin/env bash
# -fsSL <url> [-o file]
url=""; out=""; while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
echo "curl $url" >> "$STUB_LOG"
case "$url" in
  *omarchy-staging.pub.asc) body="-----BEGIN PGP PUBLIC KEY BLOCK-----" ;;
  *pacman.conf\?ring=*) ring="${url#*ring=}"; ring="${ring%%&*}"; body="# generated for $ring
[omarchy-core-$ring]
SigLevel = Required DatabaseRequired
Server = https://pool.test/r2/\$arch

[omarchy-extra-$ring]
SigLevel = Required DatabaseRequired
Server = https://pool.test/r2/\$arch
" ;;
  *) echo "unexpected url $url" >&2; exit 22 ;;
esac
if [[ -n "$out" ]]; then printf '%s\n' "$body" > "$out"; else printf '%s\n' "$body"; fi
S
cat > "$tmp/bin/pacman-key" <<'S'
#!/usr/bin/env bash
echo "pacman-key $*" >> "$STUB_LOG"
case "$1" in --list-keys) [[ -f "$STUB_KEYS" ]] ;; --add) touch "$STUB_KEYS" ;; --lsign-key) : ;; esac
S
cat > "$tmp/bin/pacman" <<'S'
#!/usr/bin/env bash
echo "pacman $*" >> "$STUB_LOG"
S
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH" STUB_LOG="$tmp/log" STUB_KEYS="$tmp/keys" PACMAN_CONF="$tmp/etc/pacman.conf" POOL_INCLUDE="$tmp/etc/pacman.d/omarchy-pool.conf"

cat > "$PACMAN_CONF" <<'C'
[options]
HoldPkg = pacman glibc
Architecture = aarch64
SigLevel = Required DatabaseOptional

[omarchy]
SigLevel = Required DatabaseOptional
Server = https://github.com/maralcbr/omarchy-pkgs/releases/download/asahi-packages-stable-x

[asahi-alarm]
SigLevel = Required DatabaseOptional
Server = https://github.com/asahi-alarm/asahi-alarm/releases/download/aarch64

[core]
Server = https://fl.us.mirror.archlinuxarm.org/$arch/$repo

[extra]
Server = https://fl.us.mirror.archlinuxarm.org/$arch/$repo
C
cp "$PACMAN_CONF" "$tmp/original.conf"
fail() { echo "FAIL: $*" >&2; echo "--- pacman.conf ---" >&2; cat "$PACMAN_CONF" >&2; echo "--- log ---" >&2; cat "$STUB_LOG" 2>/dev/null >&2; exit 1; }

# 1. First run: key trusted, include written, one Include line above [core], the Asahi repositories still above it.
bash "$tmp/setup.sh" --ring stable > "$tmp/out1" 2>&1 || fail "first run exited $?: $(cat "$tmp/out1")"
grep -q "pacman-key --add" "$STUB_LOG" && grep -q "pacman-key --lsign-key staging@firemanxbr.org" "$STUB_LOG" || fail "the key was not trusted"
grep -q '^\[omarchy-core-stable\]' "$POOL_INCLUDE" || fail "no stable include"
[[ "$(grep -c '^Include = ' "$PACMAN_CONF")" == 1 ]] || fail "expected exactly one Include line"
awk '/^\[omarchy\]/{a=NR} /^Include = /{i=NR} /^\[core\]/{c=NR} END { exit !(a < i && i < c) }' "$PACMAN_CONF" || fail "Include is not between [omarchy] and [core]"
grep -q "pacman -Sy$" "$STUB_LOG" || fail "no pacman -Sy"
grep -q "Now run:  sudo pacman -Syu" "$tmp/out1" || fail "no closing advice"
[[ -f "$PACMAN_CONF.bak-omarchy-pool" ]] || fail "no backup"
echo "ok: first run"

# 2. Second run: nothing changes in pacman.conf, the key is not added again.
cp "$PACMAN_CONF" "$tmp/after1.conf"; : > "$STUB_LOG"
bash "$tmp/setup.sh" --ring stable > /dev/null 2>&1 || fail "second run failed"
cmp -s "$PACMAN_CONF" "$tmp/after1.conf" || fail "second run changed pacman.conf"
grep -q "pacman-key --add" "$STUB_LOG" && fail "the key was added twice"
echo "ok: idempotent"

# 3. Another ring rewrites the include only.
bash "$tmp/setup.sh" --ring rc > /dev/null 2>&1 || fail "rc run failed"
grep -q '^\[omarchy-core-rc\]' "$POOL_INCLUDE" && ! grep -q 'stable' "$POOL_INCLUDE" || fail "include not rewritten for rc"
cmp -s "$PACMAN_CONF" "$tmp/after1.conf" || fail "switching rings touched pacman.conf"
echo "ok: --ring rc"

# 4. A bad ring, a non-root user: refused before touching anything.
bash "$tmp/setup.sh" --ring nightly > /dev/null 2>&1 && fail "--ring nightly accepted"
echo "ok: bad ring refused"

# 5. --remove: the include is gone and pacman.conf is the original again.
bash "$tmp/setup.sh" --remove > /dev/null 2>&1 || fail "--remove failed"
[[ ! -f "$POOL_INCLUDE" ]] || fail "include still there after --remove"
cmp -s "$PACMAN_CONF" "$tmp/original.conf" || fail "pacman.conf differs from the original after --remove"
echo "ok: --remove"

# 6. A pacman.conf without [core]: the Include goes at the end.
printf '[options]\nArchitecture = auto\n\n[custom]\nServer = https://x/$arch\n' > "$PACMAN_CONF"
bash "$tmp/setup.sh" > /dev/null 2>&1 || fail "run without [core] failed"
[[ "$(tail -n1 "$PACMAN_CONF")" == "Include = $POOL_INCLUDE" ]] || fail "Include not appended when [core] is absent"
echo "ok: no [core]"
echo "SETUP SCRIPT OK"
