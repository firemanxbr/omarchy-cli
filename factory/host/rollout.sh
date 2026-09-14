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

docker compose pull --quiet 2>&1 | grep -viE "pulled|pulling|^\s*$" || true
changed=0
# Community workers first (one task per container, quick to drain), the
# review pair next, the pool pair last: the pool's own jobs pause least.
# Only the services the active profiles enable (compose.yml: `emulated`).
enabled="$(docker compose config --services 2>/dev/null | tr '\n' ' ')"
for svc in community-x86_64 community-aarch64 review-x86_64 review-aarch64 pool-x86_64 pool-aarch64; do
  [[ " $enabled " == *" $svc "* ]] || continue
  image="$(docker compose config --format json | jq -r ".services[\"$svc\"].image")"
  wanted="$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)"
  cid="$(docker compose ps -q "$svc" 2>/dev/null | head -1)"
  if [[ -z "$cid" ]]; then
    log "$svc: not running; starting"
    (( check )) || docker compose up -d --no-deps --no-build "$svc" >/dev/null 2>&1
    changed=1; continue
  fi
  running="$(docker inspect -f '{{.Image}}' "$cid")"
  [[ "$running" == "$wanted" ]] && continue
  task="$(docker logs --tail 40 "$cid" 2>&1 | grep -oE '^task [0-9]+: [^(]*\(attempt' | tail -1 | sed 's/ (attempt$//' || true)"
  log "$svc: ${running:7:12} → ${wanted:7:12}${task:+ (draining: $task)}"
  changed=1
  (( check )) && continue
  # up -d recreates a container whose image changed: stop (drain), remove, start.
  docker compose up -d --no-deps --no-build "$svc" >/dev/null 2>&1 \
    && log "$svc: running $(docker inspect -f '{{.Image}}' "$(docker compose ps -q "$svc")" | cut -c8-19)" \
    || log "$svc: FAILED to replace — docker compose logs $svc"
done
(( changed )) || log "nothing to roll out: the six run the latest image"
(( check )) || docker image prune -f >/dev/null 2>&1 || true
