#!/usr/bin/env bash
# omarchy-build-worker — an ephemeral factory worker.
#
# Runs inside a clean Arch Linux container (x86_64: archlinux:base-devel,
# aarch64: menci/archlinuxarm:base-devel) anywhere: a VM on a laptop, a
# GitHub-hosted runner, a Droplet. It never receives work; it asks for it:
#
#   claim  → POST $OMARCHY_API/api/v1/factory/claim        (a task with a 30-minute lease, or 204)
#   build  → fetch the PKGBUILD at the task's commit, makepkg in this container
#   sign   → gpg --detach-sign with the factory key
#   pool   → pkg-repo publish --source factory --ring edge; pkg-repo render edge
#   report → POST …/tasks/<id>/complete  (or …/fail: the task goes back to the queue)
#
# A heartbeat extends the lease while the build runs; if this process dies
# the lease expires and the pool's scheduler requeues the task.
#
# Environment (secrets come from the operator, never from the task):
#   OMARCHY_API            https://pkgs.firemanxbr.org
#   FACTORY_TOKEN          bearer token for the factory endpoints
#   OMARCHY_PUBLISH_TOKEN  bearer token pkg-repo uses to publish and render
#   OMARCHY_GPG_KEY        armored private key that signs packages and databases
#   OMARCHY_GPG_KEY_FILE   …or a file holding it (mount it read-only)
#   OMARCHY_GPG_HOME       …or a GnuPG home directory that already holds it (mounted; copied)
#   OMARCHY_GPG_KEYID      its key id
#   WORKER_ID              default <hostname>-<arch>-<random>
#   WORKER_LABELS          JSON, e.g. {"where":"laptop"}
#   IDLE_EXIT              exit after this many seconds without work (0 = never; default 0)
#   MAX_TASKS              exit after this many tasks (0 = unlimited; default 0)
#   POOL_RELEASE           pkg-repo release tag to install (default: latest)
set -euo pipefail

: "${OMARCHY_API:=https://pkgs.firemanxbr.org}"
: "${FACTORY_TOKEN:?FACTORY_TOKEN is required}"
: "${OMARCHY_PUBLISH_TOKEN:?OMARCHY_PUBLISH_TOKEN is required}"
: "${OMARCHY_GPG_KEYID:?OMARCHY_GPG_KEYID is required}"
: "${IDLE_EXIT:=0}"
: "${MAX_TASKS:=0}"
REPO_URL="https://github.com/firemanxbr/omarchy-pool"
ARCH="$(uname -m)"
case "$ARCH" in x86_64|aarch64) ;; *) echo "unsupported architecture $ARCH" >&2; exit 2 ;; esac
WORKER_ID="${WORKER_ID:-$(hostname -s 2>/dev/null || echo worker)-$ARCH-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
[[ -n "${WORKER_LABELS:-}" ]] || WORKER_LABELS='{}'
export GNUPGHOME=/root/.gnupg
WORK=/build
LEASE_BEAT=300

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
api() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  curl -sS --fail-with-body --max-time 60 -X "$method" "$OMARCHY_API/api/v1$path" \
    -H "authorization: Bearer $FACTORY_TOKEN" -H "content-type: application/json" \
    ${body:+--data "$body"} -w '\n%{http_code}'
}

prepare() {
  log "worker $WORKER_ID ($ARCH) preparing"
  pacman-key --init >/dev/null 2>&1 || true
  if [[ -f /etc/pacman.d/gnupg/trustdb.gpg && ! -s /etc/pacman.d/gnupg/pubring.kbx ]]; then
    pacman-key --populate >/dev/null 2>&1 || true
  fi
  pacman -Syu --noconfirm --needed base-devel git curl jq gnupg sudo >/dev/null
  pacman -S --noconfirm --needed namcap >/dev/null 2>&1 || true
  id builder >/dev/null 2>&1 || useradd -m -s /bin/bash builder
  echo 'builder ALL=(ALL) NOPASSWD: /usr/bin/pacman' > /etc/sudoers.d/builder
  mkdir -p "$WORK"

  # pkg-repo from the pool's own releases.
  if ! command -v pkg-repo >/dev/null; then
    local tag="${POOL_RELEASE:-}"
    [[ -n "$tag" ]] || tag="$(curl -sS "https://api.github.com/repos/firemanxbr/omarchy-pool/releases/latest" | jq -r .tag_name)"
    local name="omarchy-pool-$tag-$ARCH-linux"
    log "installing pkg-repo $tag"
    curl -sSL -o "/tmp/$name.tar.gz" "$REPO_URL/releases/download/$tag/$name.tar.gz"
    curl -sSL -o "/tmp/$name.tar.gz.sha256" "$REPO_URL/releases/download/$tag/$name.tar.gz.sha256"
    (cd /tmp && sha256sum -c "$name.tar.gz.sha256" >/dev/null)
    tar -C /tmp -xzf "/tmp/$name.tar.gz"
    install -m 755 "/tmp/$name/pkg-repo" /usr/local/bin/pkg-repo
    rm -rf "/tmp/$name" "/tmp/$name.tar.gz"*
  fi
  WORKER_VERSION="$(pkg-repo --version 2>/dev/null | awk '{print $2}')"

  # The signing key: never written to disk outside the keyring.
  mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"
  if [[ -n "${OMARCHY_GPG_KEY:-}" ]]; then
    printf '%s' "$OMARCHY_GPG_KEY" | gpg --batch --import >/dev/null 2>&1
    unset OMARCHY_GPG_KEY
  elif [[ -n "${OMARCHY_GPG_KEY_FILE:-}" ]]; then
    gpg --batch --import "$OMARCHY_GPG_KEY_FILE" >/dev/null 2>&1
  elif [[ -n "${OMARCHY_GPG_HOME:-}" ]]; then
    cp -a "$OMARCHY_GPG_HOME/." "$GNUPGHOME/" && chmod -R go-rwx "$GNUPGHOME"
  fi
  gpg --batch --list-secret-keys "$OMARCHY_GPG_KEYID" >/dev/null 2>&1 || { log "signing key $OMARCHY_GPG_KEYID is not in the keyring"; exit 2; }
  # Trust the factory key so pacman accepts factory-built dependencies.
  gpg --batch --export "$OMARCHY_GPG_KEYID" | pacman-key --add - >/dev/null 2>&1 || true
  pacman-key --lsign-key "$OMARCHY_GPG_KEYID" >/dev/null 2>&1 || true
  # Factory-built packages already in the pool satisfy dependencies of new builds.
  if ! grep -q '^\[omarchy-factory-edge\]' /etc/pacman.conf; then
    printf '\n[omarchy-factory-edge]\nSigLevel = Optional\nServer = %s/$arch\n' "${OMARCHY_POOL:-https://pool.firemanxbr.org}" >> /etc/pacman.conf
    pacman -Sy >/dev/null 2>&1 || true
  fi
}

heartbeat_loop() { # task-id
  while sleep "$LEASE_BEAT"; do
    api POST "/factory/tasks/$1/heartbeat" "{\"worker\":\"$WORKER_ID\"}" >/dev/null 2>&1 || true
  done
}

build() { # task json
  local task="$1"
  local id name group ref reason
  id="$(jq -r .task.id <<<"$task")"; name="$(jq -r .task.name <<<"$task")"; group="$(jq -r '.task.group' <<<"$task")"
  ref="$(jq -r .task.pkgbuild_ref <<<"$task")"; reason="$(jq -r .task.reason <<<"$task")"
  local dir="$WORK/$id" started=$SECONDS logfile="$WORK/$id.log"
  rm -rf "$dir"; mkdir -p "$dir/out"
  log "task $id: $name for $ARCH at $ref ($reason)"
  heartbeat_loop "$id" & local beat=$!
  local status=0
  # A subshell with its own errexit: the first failing step ends the build.
  set +e
  (
    set -e
    git init -q "$dir/src"
    git -C "$dir/src" remote add origin "$REPO_URL"
    git -C "$dir/src" fetch -q --depth 1 origin "$ref"
    git -C "$dir/src" checkout -q FETCH_HEAD
    local pkgdir="$dir/src/factory/pkgbuilds/$group/$name"
    [[ -f "$pkgdir/PKGBUILD" ]] || { echo "no PKGBUILD at factory/pkgbuilds/$group/$name in $ref"; exit 3; }
    chown -R builder:builder "$dir"
    # namcap flags the obvious (missing deps, bad permissions) before the build.
    sudo -u builder namcap "$pkgdir/PKGBUILD" || true
    (cd "$pkgdir" && sudo -u builder env PKGDEST="$dir/out" SRCDEST="$dir/srcdest" LOGDEST="$dir" \
       makepkg --syncdeps --noconfirm --clean --cleanbuild --log --nosign)
    shopt -s nullglob
    local pkgs=("$dir"/out/*.pkg.tar.zst)
    [[ ${#pkgs[@]} -gt 0 ]] || { echo "makepkg produced no package"; exit 3; }
    for p in "${pkgs[@]}"; do
      gpg --batch --yes --detach-sign --local-user "$OMARCHY_GPG_KEYID" --output "$p.sig" "$p"
    done
    OMARCHY_API="$OMARCHY_API" pkg-repo publish --source factory --ring edge --arch "$ARCH" --note "factory task $id: $name ($reason)" "${pkgs[@]}"
    OMARCHY_API="$OMARCHY_API" pkg-repo render --ring edge --arch "$ARCH" --key "$OMARCHY_GPG_KEYID"
  ) >"$logfile" 2>&1
  status=$?
  set -e
  kill "$beat" 2>/dev/null || true
  local took=$(( (SECONDS - started) * 1000 ))
  local tail; tail="$(tail -n 80 "$logfile" | jq -Rs .)"
  if [[ $status -eq 0 ]]; then
    local main sha filename version
    main="$(ls "$dir"/out/"$name"-[0-9]*.pkg.tar.zst 2>/dev/null | head -n1 || true)"
    [[ -n "$main" ]] || main="$(ls "$dir"/out/*.pkg.tar.zst | head -n1)"
    sha="$(sha256sum "$main" | cut -d' ' -f1)"; filename="$(basename "$main")"
    version="$(tar -xOf "$main" .PKGINFO 2>/dev/null | awk -F' = ' '$1=="pkgver"{print $2}')"
    api POST "/factory/tasks/$id/complete" \
      "$(jq -n --arg w "$WORKER_ID" --arg s "$sha" --arg f "$filename" --arg v "$version" --argjson d "$took" --argjson t "$tail" \
         '{worker:$w,sha256:$s,filename:$f,version:$v,duration_ms:$d,log_tail:$t}')" >/dev/null
    log "task $id: done — $filename in $((took / 1000)) s"
  else
    local err; err="$(grep -m1 -E '^(==> ERROR|error|Error|fatal)' "$logfile" || tail -n1 "$logfile")"
    api POST "/factory/tasks/$id/fail" \
      "$(jq -n --arg w "$WORKER_ID" --arg e "exit $status: ${err:0:500}" --argjson d "$took" --argjson t "$tail" \
         '{worker:$w,error:$e,duration_ms:$d,log_tail:$t}')" >/dev/null || true
    log "task $id: failed (exit $status) — ${err:0:200}"
  fi
  rm -rf "$dir"
}

main() {
  prepare
  local idle=0 done=0
  log "worker $WORKER_ID ready (pkg-repo ${WORKER_VERSION:-?}); asking $OMARCHY_API for $ARCH work"
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

main "$@"
