#!/usr/bin/env bash
# omarchy-worker — one image, one command, for contributors and maintainers.
#
# The registration behind OMARCHY_WORKER_TOKEN decides what this container
# does; nothing else differs between a contributor's machine and a
# maintainer's:
#
#   community trust  → the contributor's worker: one task per container,
#                      built right here, the result into the contributor's
#                      staging workspace (WORKER_SHARED=1 builds anyone's,
#                      ANTHROPIC_API_KEY brings the owner's agent).
#   project trust    → the project's worker: the pool's jobs and the rebuild
#                      of approved packages, each in a fresh sibling
#                      container through the runtime's socket mounted at
#                      /var/run/docker.sock (docs: /docs/workers); with
#                      ANTHROPIC_API_KEY it also audits staged builds for
#                      the maintainers (the second agent).
#
# Extra arguments go to `pkg-repo work` in project mode (--kind, --idle-exit,
# --once, --labels); in community mode they are ignored.
set -euo pipefail
: "${OMARCHY_API:=https://pkgs.firemanxbr.org}"
: "${OMARCHY_WORKER_TOKEN:?OMARCHY_WORKER_TOKEN is required: register a worker on the Contributors page}"

self="$(curl -sS --fail-with-body --max-time 30 "$OMARCHY_API/api/v1/factory/workers/self" -H "authorization: Bearer $OMARCHY_WORKER_TOKEN" 2>&1)" \
  || { echo "omarchy-worker: the pool did not accept this token: $self" >&2; exit 2; }
id="$(jq -r .id <<<"$self")"; trust="$(jq -r .trust <<<"$self")"; arch="$(jq -r .arch <<<"$self")"; owner="$(jq -r '.owner // ""' <<<"$self")"
host_arch="$(uname -m)"; [[ "$host_arch" == arm64 ]] && host_arch=aarch64
if [[ "$arch" != "$host_arch" && "${OMARCHY_WORKER_MODE:-}" != project ]]; then
  echo "omarchy-worker: $id is registered for $arch but this machine is $host_arch" >&2; exit 2
fi
mode="${OMARCHY_WORKER_MODE:-$([[ "$trust" == project ]] && echo project || echo community)}"

case "$mode" in
  project)
    if [[ ! -S /var/run/docker.sock ]]; then
      echo "omarchy-worker: $id is a project worker; its builds and checks run in fresh containers through your runtime — mount its socket at /var/run/docker.sock (docs: /docs/workers)" >&2
      exit 2
    fi
    [[ -n "${OMARCHY_WORK_DIR:-}" ]] || echo "omarchy-worker: OMARCHY_WORK_DIR not set; using /var/lib/omarchy-worker — mount the same host path there" >&2
    echo "omarchy-worker: $id — project worker ($arch, ${owner:-project}); pool jobs and approved rebuilds${ANTHROPIC_API_KEY:+, audits of staged builds}" >&2
    exec pkg-repo work --arch "$arch" "$@"
    ;;
  community)
    echo "omarchy-worker: $id — ${owner}'s worker ($arch); one task per container${WORKER_SHARED:+, shared}" >&2
    export WORKER_ID="$id"
    exec omarchy-build-worker --container
    ;;
  *) echo "omarchy-worker: OMARCHY_WORKER_MODE must be community or project" >&2; exit 2 ;;
esac
