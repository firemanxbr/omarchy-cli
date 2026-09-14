#!/usr/bin/env bash
# omarchy-build-worker — the build half of the factory's workers.
#
# Two modes, both inside a container, never on a host by hand:
#
#   --container  the Omarchy Packaging image (a contributor's worker): claims
#                one community task with the worker's own token, builds it
#                right here, uploads the result to the contributor's staging
#                workspace and exits; a wrapper (compose restart) starts the
#                next container. No key, no publish credential: community
#                results never touch the pool.
#   --inside     called by `pkg-repo work` (a project worker) in a FRESH Arch
#                container per task (x86_64: archlinux:base-devel, aarch64:
#                menci/archlinuxarm:base-devel): fetch the PKGBUILD at the
#                task's commit (or from staging, after an approval), makepkg
#                as a plain user, leave the packages for the host, which
#                publishes them with the task's per-job token; the pool signs.
#
# Environment (secrets come from the operator, never from the task):
#   OMARCHY_API            https://pkgs.firemanxbr.org
#   OMARCHY_POOL           https://pool.firemanxbr.org (builds can depend on earlier factory builds)
#   OMARCHY_WORKER_TOKEN   this worker's token (POST /factory/workers, shown once); FACTORY_TOKEN is an accepted alias
#   WORKER_ID              the registered worker id (shown with the token)
#   WORKER_LABELS          JSON shown on the Factory page, e.g. {"where":"laptop"}
#   WORKER_SHARED          1 = build anyone's community packages (donated compute); default: the owner's only
#   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY
#                          the worker owner's agent key, if any (one is enough): drafts and corrects PKGBUILDs
#                          here, on this machine (factory/bin/agent.py; FACTORY_PROVIDER / FACTORY_MODEL choose)
#   IDLE_EXIT              exit after this many seconds without work (0 = never; default 0)
#   MAX_TASKS              exit after this many tasks (0 = unlimited; default 0)
set -euo pipefail

REPO_URL="https://github.com/firemanxbr/omarchy-pool"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# The agent this worker runs, as "<provider>/<model>" (the same choice
# factory/bin/agent.py makes), or "" without a key — reported at claim time
# so the Factory page can show it; the key itself never leaves this machine.
agent_label() {
  local p k m
  for p in anthropic:ANTHROPIC_API_KEY:claude-sonnet-5 openai:OPENAI_API_KEY:gpt-5 gemini:GEMINI_API_KEY:gemini-3.6-flash xai:XAI_API_KEY:grok-4; do
    k="${p#*:}"; k="${k%%:*}"; m="${p##*:}"
    [[ -n "${FACTORY_PROVIDER:-}" && "${FACTORY_PROVIDER}" != "${p%%:*}" ]] && continue
    [[ -n "${!k:-}" ]] && { echo "${p%%:*}/${FACTORY_MODEL:-$m}"; return; }
  done
  echo ""
}

# ---------------------------------------------------------------- inside ---
# Runs as root in a fresh Arch container with /task mounted: /task/meta.sh
# (name, group, ref, arch, pool), /task/out for the result. Logs to stdout.
#
# `ref` says where the PKGBUILD comes from:
#   <commit>                   factory/pkgbuilds/<group>/<name> in omarchy-pool at that commit
#   <url>@<tag>:<path>         the contributor's own repository at a tag (path is the PKGBUILD or its directory)
#   draft:<url>@<tag|latest>   drafted here by factory/bin/draft-pkgbuild (the contributor's agent key, if any)
#   bump:<task>@<tag>          the PKGBUILD approved in <task>, pkgver moved to <tag>, checksums refreshed
#   staging:<task>             the PKGBUILD a contributor's build staged, approved by a maintainer (the project rebuild)
prepare_container() {
  # pacman's download sandbox (seccomp + landlock) has no place in an
  # already-isolated, sometimes emulated container.
  sed -i -e 's/^#\?DisableSandboxSyscalls/DisableSandboxSyscalls/' -e 's/^#\?DisableSandboxFilesystem/DisableSandboxFilesystem/' /etc/pacman.conf
  for opt in DisableSandboxSyscalls DisableSandboxFilesystem; do
    grep -q "^$opt" /etc/pacman.conf || sed -i "0,/^\[options\]/s//[options]\n$opt/" /etc/pacman.conf
  done
  pacman-key --init >/dev/null 2>&1 || true
  pacman -Syu --noconfirm --needed base-devel git namcap jq python pacman-contrib ccache >/dev/null
  # makepkg refuses root; `builder` builds, root installs the dependencies
  # (install_deps) — no sudo anywhere: a setuid sudo does not start under
  # user-mode emulation (an x86_64 build on an aarch64 host).
  id builder >/dev/null 2>&1 || useradd -m -s /bin/bash builder
  # Every core the container sees, for make, ninja and cargo alike — the
  # image's makepkg.conf leaves MAKEFLAGS unset, which is one job; ccache
  # on, so a rebuild of the same sources compiles only what changed.
  mkdir -p /etc/makepkg.conf.d
  printf 'MAKEFLAGS="-j%s"\nNINJAFLAGS="-j%s"\nBUILDENV=(!distcc color ccache check !sign)\n' "$(nproc)" "$(nproc)" > /etc/makepkg.conf.d/omarchy-pool.conf
  # Caches that outlive the container when the operator mounts /build/cache
  # (a directory per architecture on the host: cargo's registry, Go's module
  # and build caches, ccache's objects); a fresh directory otherwise.
  install -d -o builder -g builder /build/cache /build/cache/cargo /build/cache/go /build/cache/go/mod /build/cache/go/build /build/cache/ccache
  # The pool's tooling and key, at main.
  rm -rf /build/pool && git clone -q --depth 1 "$REPO_URL" /build/pool
}

add_pool_repos() { # arch pool
  # Dependencies resolve against what the pool's edge serves for this
  # architecture — the OPR (omarchy, quickshell…) and earlier factory builds
  # — on top of the image's own mirrors. The pool's key verifies the
  # databases; the packages are then checked against the sha256 those signed
  # databases carry, so their upstream signatures need no keyring here.
  local arch="$1" pool="$2" added=0 repo
  for repo in omarchy-packages-edge omarchy-factory-edge; do
    if ! grep -q "^\[$repo\]" /etc/pacman.conf && curl -sfI --max-time 20 "$pool/$arch/$repo.db" >/dev/null; then
      printf '\n[%s]\nSigLevel = DatabaseRequired DatabaseTrustedOnly PackageNever\nServer = %s/$arch\n' "$repo" "$pool" >> /etc/pacman.conf
      added=1
    fi
  done
  if [[ $added == 1 ]]; then
    pacman-key --add /build/pool/docs/omarchy-staging.pub.asc >/dev/null 2>&1
    local poolkey; poolkey="$(gpg --homedir /etc/pacman.d/gnupg --with-colons --show-keys /build/pool/docs/omarchy-staging.pub.asc 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}')"
    pacman-key --lsign-key "$poolkey" >/dev/null 2>&1
    pacman -Sy >/dev/null
  fi
}

fetch_pkgbuild() { # name group ref → /build/pkg holds the PKGBUILD directory
  local name="$1" group="$2" ref="$3"
  rm -rf /build/pkg /build/src
  if [[ "$ref" == staging:* ]]; then
    local from="${ref#staging:}"
    echo "==> PKGBUILD from staged task $from (approved)"
    mkdir -p /build/pkg
    curl -sSf "${OMARCHY_API:-https://pkgs.firemanxbr.org}/api/v1/factory/tasks/$from/artifacts/PKGBUILD" -o /build/pkg/PKGBUILD
  elif [[ "$ref" == bump:* ]]; then
    # A new upstream release of an approved package: the PKGBUILD a
    # maintainer approved, with pkgver moved to the tag and pkgrel reset;
    # the checksums are refreshed before the build (updpkgsums).
    local spec from tag ver
    spec="${ref#bump:}"; from="${spec%@*}"; tag="${spec#*@}"; ver="${tag#v}"; ver="${ver#V}"
    echo "==> PKGBUILD from approved task $from, bumped to $tag"
    mkdir -p /build/pkg
    curl -sSf "${OMARCHY_API:-https://pkgs.firemanxbr.org}/api/v1/factory/tasks/$from/artifacts/PKGBUILD" -o /build/pkg/PKGBUILD
    sed -i -e "s/^pkgver=.*/pkgver=${ver//\//\\/}/" -e "s/^pkgrel=.*/pkgrel=1/" /build/pkg/PKGBUILD
    chown -R builder:builder /build/pkg && (cd /build/pkg && as_builder updpkgsums) || echo "updpkgsums failed; the build will tell"
  elif [[ "$ref" == draft:* ]]; then
    local spec url
    spec="${ref#draft:}"; url="${spec%@*}"
    echo "==> Drafting a PKGBUILD for $url ($( [[ -n "$(agent_label)" ]] && echo "with the contributor's agent, $(agent_label)" || echo "template; set an agent key on the worker for an agent-written draft"))"
    mkdir -p /build/pkg
    GITHUB_TOKEN="${GITHUB_TOKEN:-}" python3 /build/pool/factory/bin/draft-pkgbuild --url "$url" --name "$name" --out /build/pkg
  elif [[ "$ref" == *@*:* ]]; then
    local url rest tag path
    url="${ref%%@*}"; rest="${ref#*@}"; tag="${rest%%:*}"; path="${rest#*:}"
    echo "==> PKGBUILD from $url at $tag ($path)"
    if [[ "$tag" == HEAD ]]; then git clone -q --depth 1 "$url" /build/src; else git clone -q --depth 1 --branch "$tag" "$url" /build/src; fi
    [[ -e "/build/src/$path" ]] || { echo "no $path in $url at $tag"; exit 3; }
    if [[ -d "/build/src/$path" ]]; then cp -a "/build/src/$path" /build/pkg; else mkdir -p /build/pkg && cp -a "$(dirname "/build/src/$path")"/. /build/pkg/; fi
  else
    # Everything happens on the container's own filesystem (a bind mount from
    # macOS breaks fakeroot); only the result is copied out.
    git init -q /build/src
    git -C /build/src remote add origin "$REPO_URL"
    git -C /build/src fetch -q --depth 1 origin "$ref"
    git -C /build/src checkout -q FETCH_HEAD
    [[ -f "/build/src/factory/pkgbuilds/$group/$name/PKGBUILD" ]] || { echo "no PKGBUILD at factory/pkgbuilds/$group/$name in $ref"; exit 3; }
    # Build outside the checkout: build tools walk up the tree (cargo finds the
    # pool's own workspace Cargo.toml above factory/).
    cp -a "/build/src/factory/pkgbuilds/$group/$name" /build/pkg
  fi
  [[ -f /build/pkg/PKGBUILD ]] || { echo "no PKGBUILD found for $ref"; exit 3; }
}

as_builder() { runuser -u builder -- "$@"; }

# Extends the task's lease while the build runs (every five minutes; the
# lease is thirty): a build longer than the lease is not handed to another
# worker. Killed when the task ends.
heartbeat_loop() { # task-id
  while :; do
    sleep 300
    api POST "/factory/tasks/$1/heartbeat" '{}' >/dev/null 2>&1 || true
  done
}

# What `makepkg --syncdeps` would install, installed by root instead: the
# PKGBUILD's depends, makedepends and checkdepends (this architecture's
# too), from .SRCINFO. Nothing to escalate from the build user.
install_deps() {
  local deps
  deps="$(cd /build/pkg && as_builder makepkg --printsrcinfo 2>/dev/null \
    | awk -F' = ' '/^[[:space:]]*(make|check)?depends(_[a-z0-9_]+)? = /{print $2}' | sort -u)"
  [[ -n "$deps" ]] || return 0
  # shellcheck disable=SC2086
  pacman -S --needed --noconfirm --asdeps -- $deps
}

run_makepkg() { # → /build/out/*.pkg.tar.zst
  rm -rf /build/out; mkdir -p /build/out && chown -R builder:builder /build/pkg /build/out
  # A drafted PKGBUILD carries SKIP checksums; fill them in.
  if grep -q "^sha256sums=('SKIP')" /build/pkg/PKGBUILD; then (cd /build/pkg && as_builder updpkgsums); fi
  # Source signatures verify against keys shipped beside the PKGBUILD
  # (keys/pgp/<fingerprint>.asc, the AUR convention), never a keyserver.
  if compgen -G "/build/pkg/keys/pgp/*.asc" >/dev/null; then
    as_builder gpg --batch --import /build/pkg/keys/pgp/*.asc 2>&1 | grep -E "imported|unchanged" || true
  fi
  # namcap flags the obvious (missing deps, bad permissions) before the build.
  as_builder namcap /build/pkg/PKGBUILD || true
  install_deps
  # zst whatever the image's makepkg.conf says (Arch Linux ARM defaults to xz).
  (cd /build/pkg && as_builder env PKGDEST=/build/out PKGEXT=.pkg.tar.zst PACKAGER="omarchy-pool factory <https://github.com/firemanxbr/omarchy-pool>" \
    CARGO_HOME=/build/cache/cargo CARGO_BUILD_JOBS="$(nproc)" GOMODCACHE=/build/cache/go/mod GOCACHE=/build/cache/go/build GOFLAGS=-modcacherw CCACHE_DIR=/build/cache/ccache \
    makepkg --noconfirm --clean --cleanbuild --nosign)
}

# Build with the drafter correcting itself from the log — the contributor's
# agent doing the heavy lifting, on the contributor's machine.
build_with_retries() { # name group ref
  local name="$1" group="$2" ref="$3" attempt=1 max=1
  [[ "$ref" == draft:* && -n "$(agent_label)" ]] && max=3
  fetch_pkgbuild "$name" "$group" "$ref"
  while :; do
    if run_makepkg > /build/attempt.log 2>&1; then cat /build/attempt.log; return 0; fi
    cat /build/attempt.log
    if (( attempt >= max )); then return 4; fi
    attempt=$((attempt + 1))
    echo "==> Attempt $attempt: correcting the PKGBUILD from the log"
    cp /build/pkg/PKGBUILD /build/PKGBUILD.prev
    local url; url="${ref#draft:}"; url="${url%@*}"
    python3 /build/pool/factory/bin/draft-pkgbuild --url "$url" --name "$name" --out /build/pkg --previous /build/PKGBUILD.prev --log /build/attempt.log || return 4
  done
}

inside() {
  local name group ref arch pool
  # shellcheck source=/dev/null
  source /task/meta.sh
  prepare_container
  add_pool_repos "$arch" "$pool"
  build_with_retries "$name" "$group" "$ref"
  mkdir -p /task/out && cp /build/out/*.pkg.tar.zst /task/out/ && cp /build/pkg/PKGBUILD /task/out/PKGBUILD && ls /task/out
}

# ------------------------------------------------------------- container ---
# The Omarchy Packaging image runs this: one container, one task. It claims
# a task for its registered worker, builds it right here (the container is
# the fresh environment — a wrapper restarts a new one per task), uploads
# the result to the contributor's staging workspace and exits. No signing
# key, no publish token: community results never touch the pool directly.
container_worker() {
  OMARCHY_WORKER_TOKEN="${OMARCHY_WORKER_TOKEN:-${FACTORY_TOKEN:-}}"
  : "${OMARCHY_WORKER_TOKEN:?OMARCHY_WORKER_TOKEN (a worker token from POST /factory/workers) is required}"
  : "${WORKER_ID:?WORKER_ID (from POST /factory/workers) is required}"
  ARCH="$(uname -m)"; [[ "$ARCH" == arm64 ]] && ARCH=aarch64
  log "container worker $WORKER_ID ($ARCH) preparing"
  # SIGTERM (docker stop, a rolling upgrade) drains: a build in progress runs
  # to its end and is reported — bash runs the trap once the foreground
  # command returns — and nothing new is claimed. Exit 0 either way.
  DRAIN=0; trap 'DRAIN=1' TERM INT
  prepare_container
  add_pool_repos "$ARCH" "$OMARCHY_POOL"
  local idle=0 out code body task id name group ref version
  while :; do
    if [[ "$DRAIN" == 1 ]]; then log "draining: nothing claimed since the stop signal; exiting"; exit 0; fi
    out="$(api POST /factory/claim "$(jq -n --arg a "$ARCH" --arg h "$(hostname -s 2>/dev/null || echo ?)" --arg v "container" --arg g "$(agent_label)" --argjson l "${WORKER_LABELS:-"{}"}" --argjson s "$( [[ "${WORKER_SHARED:-0}" == 1 ]] && echo true || echo false)" '{arch:$a,hostname:$h,version:$v,labels:$l,shared:$s,agent:$g}')")" \
      || { log "claim failed: ${out##*$'\n'}"; sleep 60; continue; }
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    if [[ "$code" == "204" ]]; then
      idle=$((idle + 30))
      if [[ "${IDLE_EXIT:-0}" -gt 0 && "$idle" -ge "${IDLE_EXIT:-0}" ]]; then log "no work for ${idle}s; exiting"; exit 0; fi
      for _ in $(seq 1 30); do [[ "$DRAIN" == 1 ]] && break; sleep 1; done
      continue
    fi
    break
  done
  task="$body"
  id="$(jq -r .task.id <<<"$task")"; name="$(jq -r .task.name <<<"$task")"; group="$(jq -r .task.group <<<"$task")"; ref="$(jq -r .task.pkgbuild_ref <<<"$task")"
  log "task $id: $name for $ARCH ($ref)"
  heartbeat_loop "$id" & local beat=$!; disown "$beat"
  local started=$SECONDS status=0
  set +e
  ( set -e; build_with_retries "$name" "$group" "$ref" ) > /build/build.log 2>&1
  status=$?
  set -e
  local took=$(( (SECONDS - started) * 1000 )) tail; tail="$(tail -n 80 /build/build.log | jq -Rs .)"
  if [[ $status -ne 0 ]]; then
    kill "$beat" 2>/dev/null || true
    local err; err="$(grep -m1 -E '^(==> ERROR|error|Error|fatal)' /build/build.log || tail -n1 /build/build.log)"
    log "task $id: failed (exit $status) — ${err:0:200}"
    # Upload what there is for the record, then report.
    upload_staging "$id" /build/build.log build.log || true
    [[ -f /build/pkg/PKGBUILD ]] && upload_staging "$id" /build/pkg/PKGBUILD PKGBUILD || true
    api POST "/factory/tasks/$id/fail" "$(jq -n --arg e "exit $status: ${err:0:500}" --argjson d "$took" --argjson t "$tail" '{error:$e,duration_ms:$d,log_tail:$t}')" >/dev/null || true
    exit 1
  fi
  shopt -s nullglob
  local pkgs=(/build/out/*.pkg.tar.zst) main sha filename version
  main="$(ls /build/out/"$name"-[0-9]*.pkg.tar.zst 2>/dev/null | head -n1 || true)"; [[ -n "$main" ]] || main="${pkgs[0]}"
  sha="$(sha256 "$main")"; filename="$(basename "$main")"
  version="$(tar -xOf "$main" .PKGINFO 2>/dev/null | awk -F' = ' '$1=="pkgver"{print $2}')"
  log "task $id: built $filename in $((took / 1000)) s; uploading to staging"
  for p in "${pkgs[@]}"; do upload_staging "$id" "$p" "$(basename "$p")"; done
  upload_staging "$id" /build/pkg/PKGBUILD PKGBUILD
  upload_staging "$id" /build/build.log build.log
  tar -xOf "$main" .PKGINFO > /build/PKGINFO && upload_staging "$id" /build/PKGINFO PKGINFO || true
  kill "$beat" 2>/dev/null || true
  api POST "/factory/tasks/$id/complete" "$(jq -n --arg s "$sha" --arg f "$filename" --arg v "$version" --argjson d "$took" --argjson t "$tail" '{sha256:$s,filename:$f,version:$v,duration_ms:$d,log_tail:$t}')" >/dev/null
  log "task $id: staged — a maintainer takes it from here"
}

# Upload one file to the task's staging workspace: one PUT up to 90 MB, multipart above.
upload_staging() { # task-id file name
  local id="$1" file="$2" name="$3" size; size="$(wc -c <"$file" | tr -d ' ')"
  if (( size <= 90 * 1024 * 1024 )); then
    curl -sS --fail-with-body --max-time 900 -X PUT "$OMARCHY_API/api/v1/factory/tasks/$id/artifacts/$name" -H "authorization: Bearer $OMARCHY_WORKER_TOKEN" \
      -H "content-type: application/octet-stream" --data-binary "@$file" -o /dev/null
    return
  fi
  local base="$OMARCHY_API/api/v1/factory/tasks/$id/artifacts/$name/multipart" up parts=() n=0 etag
  up="$(curl -sS --fail-with-body -X POST "$base?action=create" -H "authorization: Bearer $OMARCHY_WORKER_TOKEN" | jq -r .upload_id)"
  rm -rf /build/parts && mkdir -p /build/parts && split -b 64m -d -a 4 "$file" /build/parts/p
  for part in /build/parts/p*; do
    n=$((n + 1))
    etag="$(curl -sS --fail-with-body -X POST "$base?action=part&part=$n&upload_id=$up" -H "authorization: Bearer $OMARCHY_WORKER_TOKEN" --data-binary "@$part" | jq -r .etag)"
    parts+=("{\"partNumber\":$n,\"etag\":\"$etag\"}")
  done
  curl -sS --fail-with-body -X POST "$base?action=complete&upload_id=$up" -H "authorization: Bearer $OMARCHY_WORKER_TOKEN" -H "content-type: application/json" \
    --data "{\"parts\":[$(IFS=,; echo "${parts[*]}")]}" -o /dev/null
  rm -rf /build/parts
}

# ------------------------------------------------------------------ api ----
: "${OMARCHY_API:=https://pkgs.firemanxbr.org}"
: "${OMARCHY_POOL:=https://pool.firemanxbr.org}"
: "${IDLE_EXIT:=0}"
: "${MAX_TASKS:=0}"
api() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  curl -sS --fail-with-body --max-time 60 -X "$method" "$OMARCHY_API/api/v1$path" \
    -H "authorization: Bearer $OMARCHY_WORKER_TOKEN" -H "content-type: application/json" \
    ${body:+--data "$body"} -w '\n%{http_code}'
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

case "${1:-}" in
  --inside) inside ;;
  --container) container_worker ;;
  *) echo "usage: $0 --inside | --container (project workers run 'pkg-repo work', which calls --inside)" >&2; exit 2 ;;
esac
