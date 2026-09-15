#!/usr/bin/env bash
# rollout.sh — a rolling upgrade of the six workers to the image the pool's
# latest release published: what Kubernetes calls a rolling update, at the
# size of one host.
#
# For each service whose image changed, one at a time: stop the running
# container — SIGTERM, which the worker takes as *drain*: it finishes the
# task it holds, reports it, claims nothing new and exits (up to the
# compose file's stop_grace_period) — and start one from the new image.
# The other five keep working meanwhile; no task is ever killed, none is
# handed to another worker by an expired lease. Nothing to do when nothing
# changed, so a timer may run this every few minutes (setup.sh installs
# one: omarchy-pool-rollout.timer, every 15 minutes).
#
#   ./rollout.sh            upgrade what changed
#   ./rollout.sh --check    say what would change, change nothing
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
check=0; [[ "${1:-}" == "--check" ]] && check=1
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# The socket is root:docker. A login shell carries the group; the user
# manager that runs the timer may predate the membership and not — then
# every docker call is "permission denied", the pipefail took the script
# down at the first one and the journal showed exit 1 and nothing else
# (omarchy-studio, every 15 minutes from 2026-09-14 to 09-15). A member
# without the group re-enters with it; anyone else hears why.
if ! id -Gn | tr ' ' '\n' | grep -qx docker && getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
  exec newgrp docker <<<"exec $(printf '%q ' "${BASH_SOURCE[0]}" "$@")"
fi
docker info >/dev/null 2>&1 || { log "docker is not reachable: $(docker info 2>&1 | tail -n1)"; exit 1; }

docker compose pull --quiet 2>&1 | grep -viE "pulled|pulling|^\s*$" || true
changed=0
# Community workers first (one task per container, quick to drain), the
# review pair next, the pool pair last: the pool's own jobs pause least.
# Only the services the active profiles enable (compose.yml: `emulated`).
enabled="$(docker compose config --services 2>/dev/null | tr '\n' ' ')"
for svc in agent-proxy community-x86_64 community-aarch64 review-x86_64 review-aarch64 pool-x86_64 pool-aarch64; do
  [[ " $enabled " == *" $svc "* ]] || continue
  # Pull again before each service: a drain can take hours (a pool worker
  # finishes its sync first) and the image that was newest at the start may
  # be several releases old by the time the last service is reached —
  # pool-aarch64 ran v0.0.103 while the rest ran v0.0.116 (2026-09-15).
  docker compose pull --quiet "$svc" 2>&1 | grep -viE "pulled|pulling|^\s*$" || true
  image="$(docker compose config --format json | jq -r ".services[\"$svc\"].image")"
  wanted="$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)"
  cid="$(docker compose ps -q "$svc" 2>/dev/null | head -1)"
  if [[ -z "$cid" ]]; then
    log "$svc: not running; starting"
    (( check )) || docker compose up -d --no-deps --no-build "$svc" >/dev/null 2>&1
    changed=1; continue
  fi
  running="$(docker inspect -f '{{.Image}}' "$cid")"
  # The image, and the service's configuration: an environment or a volume
  # changed in compose.yml is a container to replace too (community-x86_64
  # kept its old environment for an hour after the agent-proxy landed,
  # 2026-09-15). compose stamps every container with its config hash.
  wanted_cfg="$(docker compose config --hash "$svc" 2>/dev/null | awk '{print $2}')"
  running_cfg="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$cid" 2>/dev/null || true)"
  [[ "$running" == "$wanted" && ( -z "$wanted_cfg" || "$running_cfg" == "$wanted_cfg" ) ]] && continue
  task="$(docker logs --tail 40 "$cid" 2>&1 | grep -oE '^task [0-9]+: [^(]*\(attempt' | tail -1 | sed 's/ (attempt$//' || true)"
  log "$svc: ${running:7:12} → ${wanted:7:12}$( [[ "$running_cfg" != "$wanted_cfg" && -n "$wanted_cfg" ]] && echo " (configuration changed)")${task:+ (draining: $task)}"
  changed=1
  (( check )) && continue
  # up -d recreates a container whose image changed: stop (drain), remove, start.
  docker compose up -d --no-deps --no-build "$svc" >/dev/null 2>&1 \
    && log "$svc: running $(docker inspect -f '{{.Image}}' "$(docker compose ps -q "$svc")" | cut -c8-19)" \
    || log "$svc: FAILED to replace — docker compose logs $svc"
done
(( changed )) || log "nothing to roll out: every service runs the latest image"
(( check )) || docker image prune -f >/dev/null 2>&1 || true
