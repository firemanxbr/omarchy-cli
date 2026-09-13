#!/usr/bin/env bash
# omarchy-build-worker — an ephemeral factory worker.
#
# Runs anywhere with a container runtime (podman or docker): a laptop, a VM,
# a GitHub-hosted runner. It never receives work; it asks for it:
#
#   claim   → POST $OMARCHY_API/api/v1/factory/claim      (a task with a 30-minute lease, or 204)
#   build   → a FRESH Arch container per task (x86_64: archlinux:base-devel,
#             aarch64: menci/archlinuxarm:base-devel), no secrets inside:
#             fetch the PKGBUILD at the task's commit, makepkg as a plain user
#   sign    → by the pool, with its own key, as the result is published
#   pool    → pkg-repo publish --source factory --ring edge; pkg-repo render edge
#   report  → POST …/tasks/<id>/complete  (or …/fail: the task goes back to the queue)
#
# A heartbeat extends the lease while the build runs; if this process dies
# the lease expires and the pool's scheduler requeues the task. The build
# container sees the PKGBUILD, the network and nothing else — tokens and the
# key stay with this process.
#
# Environment (secrets come from the operator, never from the task):
#   OMARCHY_API            https://pkgs.firemanxbr.org
#   OMARCHY_POOL           https://pool.firemanxbr.org (builds can depend on earlier factory builds)
#   FACTORY_TOKEN          bearer token for the factory endpoints
#   OMARCHY_PUBLISH_TOKEN  bearer token pkg-repo uses to publish and render
#   WORKER_ARCH            architecture to build for (default: this host's; another one runs emulated)
#   WORKER_ID              default <hostname>-<arch>-<random>
#   WORKER_LABELS          JSON shown on the Factory page, e.g. {"where":"laptop"}
#   IDLE_EXIT              exit after this many seconds without work (0 = never; default 0)
#   MAX_TASKS              exit after this many tasks (0 = unlimited; default 0)
#   PKG_REPO               path to a pkg-repo binary (default: installed from the pool's releases)
#   POOL_RELEASE           pkg-repo release tag to install (default: latest)
#   BUILD_IMAGE            override the container image
#
# `omarchy-build-worker --inside` is the half that runs in the container; the
# host copies this file in and calls it. Not meant to be run by hand.
set -euo pipefail

REPO_URL="https://github.com/firemanxbr/omarchy-pool"
LEASE_BEAT=300

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# ---------------------------------------------------------------- inside ---
# Runs as root in a fresh Arch container with /task mounted: /task/meta.sh
# (name, group, ref, arch, pool), /task/out for the result. Logs to stdout.
#
# `ref` says where the PKGBUILD comes from:
#   <commit>                   factory/pkgbuilds/<group>/<name> in omarchy-pool at that commit
#   <url>@<tag>:<path>         the contributor's own repository at a tag (path is the PKGBUILD or its directory)
#   draft:<url>@<tag|latest>   drafted here by factory/bin/draft-pkgbuild (the contributor's agent key, if any)
#   staging:<task>             the PKGBUILD a contributor's build staged, approved by a maintainer (the project rebuild)
prepare_container() {
  # pacman's download sandbox (seccomp + landlock) has no place in an
  # already-isolated, sometimes emulated container.
  sed -i -e 's/^#\?DisableSandboxSyscalls/DisableSandboxSyscalls/' -e 's/^#\?DisableSandboxFilesystem/DisableSandboxFilesystem/' /etc/pacman.conf
  for opt in DisableSandboxSyscalls DisableSandboxFilesystem; do
    grep -q "^$opt" /etc/pacman.conf || sed -i "0,/^\[options\]/s//[options]\n$opt/" /etc/pacman.conf
  done
  pacman-key --init >/dev/null 2>&1 || true
  pacman -Syu --noconfirm --needed base-devel git sudo namcap jq python pacman-contrib >/dev/null
  id builder >/dev/null 2>&1 || useradd -m -s /bin/bash builder
  echo 'builder ALL=(ALL) NOPASSWD: /usr/bin/pacman' > /etc/sudoers.d/builder
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
  elif [[ "$ref" == draft:* ]]; then
    local spec url
    spec="${ref#draft:}"; url="${spec%@*}"
    echo "==> Drafting a PKGBUILD for $url ($( [[ -n "${ANTHROPIC_API_KEY:-}" ]] && echo "with the contributor's Claude key" || echo "template; set ANTHROPIC_API_KEY on the worker for an agent-written draft"))"
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

run_makepkg() { # → /build/out/*.pkg.tar.zst
  rm -rf /build/out; mkdir -p /build/out && chown -R builder:builder /build/pkg /build/out
  # A drafted PKGBUILD carries SKIP checksums; fill them in.
  if grep -q "^sha256sums=('SKIP')" /build/pkg/PKGBUILD; then (cd /build/pkg && sudo -u builder updpkgsums); fi
  # Source signatures verify against keys shipped beside the PKGBUILD
  # (keys/pgp/<fingerprint>.asc, the AUR convention), never a keyserver.
  if compgen -G "/build/pkg/keys/pgp/*.asc" >/dev/null; then
    sudo -u builder gpg --batch --import /build/pkg/keys/pgp/*.asc 2>&1 | grep -E "imported|unchanged" || true
  fi
  # namcap flags the obvious (missing deps, bad permissions) before the build.
  sudo -u builder namcap /build/pkg/PKGBUILD || true
  # zst whatever the image's makepkg.conf says (Arch Linux ARM defaults to xz).
  (cd /build/pkg && sudo -u builder env PKGDEST=/build/out PKGEXT=.pkg.tar.zst PACKAGER="omarchy-pool factory <https://github.com/firemanxbr/omarchy-pool>" \
    makepkg --syncdeps --noconfirm --clean --cleanbuild --nosign)
}

# Build with the drafter correcting itself from the log — the contributor's
# agent doing the heavy lifting, on the contributor's machine.
build_with_retries() { # name group ref
  local name="$1" group="$2" ref="$3" attempt=1 max=1
  [[ "$ref" == draft:* && -n "${ANTHROPIC_API_KEY:-}" ]] && max=3
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
  : "${FACTORY_TOKEN:?FACTORY_TOKEN (a worker token from POST /factory/workers) is required}"
  : "${WORKER_ID:?WORKER_ID (from POST /factory/workers) is required}"
  ARCH="$(uname -m)"; [[ "$ARCH" == arm64 ]] && ARCH=aarch64
  log "container worker $WORKER_ID ($ARCH) preparing"
  prepare_container
  add_pool_repos "$ARCH" "$OMARCHY_POOL"
  local idle=0 out code body task id name group ref version
  while :; do
    out="$(api POST /factory/claim "$(jq -n --arg a "$ARCH" --arg h "$(hostname -s 2>/dev/null || echo ?)" --arg v "container" --argjson l "${WORKER_LABELS:-{\}}" '{arch:$a,hostname:$h,version:$v,labels:$l}')")" \
      || { log "claim failed: ${out##*$'\n'}"; sleep 60; continue; }
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    if [[ "$code" == "204" ]]; then
      idle=$((idle + 30))
      if [[ "${IDLE_EXIT:-0}" -gt 0 && "$idle" -ge "${IDLE_EXIT:-0}" ]]; then log "no work for ${idle}s; exiting"; exit 0; fi
      sleep 30; continue
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
    curl -sS --fail-with-body --max-time 900 -X PUT "$OMARCHY_API/api/v1/factory/tasks/$id/artifacts/$name" -H "authorization: Bearer $FACTORY_TOKEN" \
      -H "content-type: application/octet-stream" --data-binary "@$file" -o /dev/null
    return
  fi
  local base="$OMARCHY_API/api/v1/factory/tasks/$id/artifacts/$name/multipart" up parts=() n=0 etag
  up="$(curl -sS --fail-with-body -X POST "$base?action=create" -H "authorization: Bearer $FACTORY_TOKEN" | jq -r .upload_id)"
  rm -rf /build/parts && mkdir -p /build/parts && split -b 64m -d -a 4 "$file" /build/parts/p
  for part in /build/parts/p*; do
    n=$((n + 1))
    etag="$(curl -sS --fail-with-body -X POST "$base?action=part&part=$n&upload_id=$up" -H "authorization: Bearer $FACTORY_TOKEN" --data-binary "@$part" | jq -r .etag)"
    parts+=("{\"partNumber\":$n,\"etag\":\"$etag\"}")
  done
  curl -sS --fail-with-body -X POST "$base?action=complete&upload_id=$up" -H "authorization: Bearer $FACTORY_TOKEN" -H "content-type: application/json" \
    --data "{\"parts\":[$(IFS=,; echo "${parts[*]}")]}" -o /dev/null
  rm -rf /build/parts
}

# ------------------------------------------------------------------ host ---
: "${OMARCHY_API:=https://pkgs.firemanxbr.org}"
: "${OMARCHY_POOL:=https://pool.firemanxbr.org}"
: "${IDLE_EXIT:=0}"
: "${MAX_TASKS:=0}"
WORK="${WORK:-$HOME/.cache/omarchy-factory}"   # under $HOME: podman machine on macOS shares it

api() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  curl -sS --fail-with-body --max-time 60 -X "$method" "$OMARCHY_API/api/v1$path" \
    -H "authorization: Bearer $FACTORY_TOKEN" -H "content-type: application/json" \
    ${body:+--data "$body"} -w '\n%{http_code}'
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

prepare() {
  : "${FACTORY_TOKEN:?FACTORY_TOKEN is required}"
  : "${OMARCHY_PUBLISH_TOKEN:?OMARCHY_PUBLISH_TOKEN is required}"
  RUNTIME="$(command -v podman || command -v docker || true)"
  [[ -n "$RUNTIME" ]] || { log "podman or docker is required"; exit 2; }
  HOST_ARCH="$(uname -m)"; [[ "$HOST_ARCH" == arm64 ]] && HOST_ARCH=aarch64
  ARCH="${WORKER_ARCH:-$HOST_ARCH}"
  case "$ARCH" in x86_64|aarch64) ;; *) log "unsupported architecture $ARCH"; exit 2 ;; esac
  case "$ARCH" in
    x86_64) IMAGE="${BUILD_IMAGE:-docker.io/library/archlinux:base-devel}"; PLATFORM=linux/amd64 ;;
    aarch64) IMAGE="${BUILD_IMAGE:-docker.io/menci/archlinuxarm:base-devel}"; PLATFORM=linux/arm64 ;;
  esac
  WORKER_ID="${WORKER_ID:-$(hostname -s 2>/dev/null || echo worker)-$ARCH-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  [[ -n "${WORKER_LABELS:-}" ]] || WORKER_LABELS='{}'
  mkdir -p "$WORK"

  # pkg-repo: given, or from the pool's own releases (Linux hosts).
  if [[ -z "${PKG_REPO:-}" ]]; then
    PKG_REPO="$WORK/pkg-repo"
    if [[ ! -x "$PKG_REPO" ]]; then
      [[ "$(uname -s)" == Linux ]] || { log "set PKG_REPO to a pkg-repo binary on $(uname -s) (cargo build --release -p pkg-repo)"; exit 2; }
      local tag="${POOL_RELEASE:-}"
      [[ -n "$tag" ]] || tag="$(curl -sS "https://api.github.com/repos/firemanxbr/omarchy-pool/releases/latest" | jq -r .tag_name)"
      local name="omarchy-pool-$tag-$HOST_ARCH-linux"
      log "installing pkg-repo $tag"
      curl -sSL -o "$WORK/$name.tar.gz" "$REPO_URL/releases/download/$tag/$name.tar.gz"
      curl -sSL -o "$WORK/$name.tar.gz.sha256" "$REPO_URL/releases/download/$tag/$name.tar.gz.sha256"
      (cd "$WORK" && sha256sum -c "$name.tar.gz.sha256" >/dev/null)
      tar -C "$WORK" -xzf "$WORK/$name.tar.gz"
      install -m 755 "$WORK/$name/pkg-repo" "$PKG_REPO"
      rm -rf "$WORK/$name" "$WORK/$name.tar.gz"*
    fi
  fi
  WORKER_VERSION="$("$PKG_REPO" --version 2>/dev/null | awk '{print $2}')"

  # No key on this host: the pool signs what it stores (SECURITY.md).
  curl -sS "$OMARCHY_API/api/v1/status" | grep -q '"signing":true' || { log "the pool at $OMARCHY_API does not sign its objects; nothing here can"; exit 2; }
  "$RUNTIME" pull -q --platform "$PLATFORM" "$IMAGE" >/dev/null
}

heartbeat_loop() { # task-id
  while sleep "$LEASE_BEAT"; do
    api POST "/factory/tasks/$1/heartbeat" "{\"worker\":\"${WORKER_ID:-}\"}" >/dev/null 2>&1 || true
  done
}

build() { # task json
  local task="$1" id name group ref reason publish
  id="$(jq -r .task.id <<<"$task")"; name="$(jq -r .task.name <<<"$task")"; group="$(jq -r '.task.group' <<<"$task")"
  ref="$(jq -r .task.pkgbuild_ref <<<"$task")"; reason="$(jq -r .task.reason <<<"$task")"; publish="$(jq -r '.task.publish // 1' <<<"$task")"
  local dir="$WORK/task-$id" started=$SECONDS logfile="$WORK/task-$id.log"
  rm -rf "$dir"; mkdir -p "$dir/out"; chmod 777 "$dir" "$dir/out"
  printf 'name=%q\ngroup=%q\nref=%q\narch=%q\npool=%q\nexport OMARCHY_API=%q\n' "$name" "$group" "$ref" "$ARCH" "$OMARCHY_POOL" "$OMARCHY_API" > "$dir/meta.sh"
  cp "${BASH_SOURCE[0]}" "$dir/worker.sh"
  log "task $id: $name for $ARCH at $ref ($reason)$([[ $publish == 0 ]] && echo " — dry run") → fresh $IMAGE"
  heartbeat_loop "$id" & local beat=$!
  disown "$beat"
  local status=0
  set +e
  (
    set -e
    "$RUNTIME" run --rm --platform "$PLATFORM" --name "omarchy-build-$id-$$" -v "$dir:/task" "$IMAGE" bash /task/worker.sh --inside
    shopt -s nullglob
    local mounted=("$dir"/out/*.pkg.tar.zst)
    [[ ${#mounted[@]} -gt 0 ]] || { echo "makepkg produced no package"; exit 3; }
    # Read the results off the shared directory once they have settled (a
    # virtiofs mount can report a stale size right after the container exits)
    # and work on private copies.
    mkdir -p "$dir/final"
    for p in "${mounted[@]}"; do
      local before after
      while :; do before="$(wc -c <"$p")"; sleep 2; after="$(wc -c <"$p")"; [[ "$before" == "$after" ]] && break; done
      cp "$p" "$dir/final/"
    done
    local pkgs=("$dir"/final/*.pkg.tar.zst)
    if [[ $publish == 0 ]]; then
      # A dry run: keep the result on this host, publish nothing.
      mkdir -p "$WORK/dry-run" && cp "${pkgs[@]}" "$WORK/dry-run/" && echo "dry run: result kept in $WORK/dry-run, not published"
    else
      "$PKG_REPO" publish --source factory --ring edge --arch "$ARCH" --note "factory task $id: $name ($reason)" "${pkgs[@]}"
      "$PKG_REPO" render --ring edge --arch "$ARCH"
    fi
  ) >"$logfile" 2>&1
  status=$?
  set -e
  kill "$beat" 2>/dev/null || true
  local took=$(( (SECONDS - started) * 1000 ))
  local tail; tail="$(tail -n 80 "$logfile" | jq -Rs .)"
  if [[ $status -eq 0 ]]; then
    local main sha filename version
    main="$(ls "$dir"/final/"$name"-[0-9]*.pkg.tar.zst 2>/dev/null | head -n1 || true)"
    [[ -n "$main" ]] || main="$(ls "$dir"/final/*.pkg.tar.zst | head -n1)"
    sha="$(sha256 "$main")"; filename="$(basename "$main")"
    version="$(tar -xOf "$main" .PKGINFO 2>/dev/null | awk -F' = ' '$1=="pkgver"{print $2}')"
    api POST "/factory/tasks/$id/complete" \
      "$(jq -n --arg w "$WORKER_ID" --arg s "$sha" --arg f "$filename" --arg v "$version" --argjson d "$took" --argjson t "$tail" \
         '{worker:$w,sha256:$s,filename:$f,version:$v,duration_ms:$d,log_tail:$t}')" >/dev/null
    log "task $id: done — $filename in $((took / 1000)) s"
    rm -rf "$dir" 2>/dev/null || sudo -n rm -rf "$dir" || true
  else
    local err; err="$(grep -m1 -E '^(==> ERROR|error|Error|fatal)' "$logfile" || tail -n1 "$logfile")"
    api POST "/factory/tasks/$id/fail" \
      "$(jq -n --arg w "$WORKER_ID" --arg e "exit $status: ${err:0:500}" --argjson d "$took" --argjson t "$tail" \
         '{worker:$w,error:$e,duration_ms:$d,log_tail:$t}')" >/dev/null || true
    log "task $id: failed (exit $status) — ${err:0:200}"
    rm -rf "$dir" 2>/dev/null || sudo -n rm -rf "$dir" || true
    # Let another worker have a go, and never spin on a broken PKGBUILD.
    sleep 60
  fi
}

main() {
  prepare
  local idle=0 done=0
  log "worker $WORKER_ID ready (pkg-repo ${WORKER_VERSION:-?}, $RUNTIME, $IMAGE); asking $OMARCHY_API for $ARCH work"
  while :; do
    local out code body
    out="$(api POST /factory/claim "$(jq -n --arg w "$WORKER_ID" --arg a "$ARCH" --arg h "$(hostname -s 2>/dev/null || echo ?)" --arg v "${WORKER_VERSION:-}" --argjson l "$WORKER_LABELS" \
             '{worker:$w,arch:$a,hostname:$h,version:$v,labels:$l}')")" || { log "claim failed: ${out##*$'\n'}"; sleep 60; continue; }
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    if [[ "$code" == "204" ]]; then
      idle=$((idle + 30))
      if [[ "$IDLE_EXIT" -gt 0 && "$idle" -ge "$IDLE_EXIT" ]]; then log "no work for ${idle}s; exiting"; break; fi
      sleep 30; continue
    fi
    idle=0
    build "$body"
    done=$((done + 1))
    if [[ "$MAX_TASKS" -gt 0 && "$done" -ge "$MAX_TASKS" ]]; then log "$done task(s) done; exiting"; break; fi
  done
}

case "${1:-}" in
  --inside) inside ;;
  --container) container_worker ;;
  *) main "$@" ;;
esac
