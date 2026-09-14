#!/usr/bin/env bash
# register.sh — registers this host's six workers with the pool and trusts
# the project's four (pool and review), writing each worker token into
# etc/<service>.env beside this script; nothing is printed but the ids.
#
#   OMARCHY_CONTRIBUTOR_TOKEN=omc_… ./register.sh        a maintainer's token (profile page)
#
# A service whose etc/*.env already holds a token is left alone, so the
# script is safe to run again after adding a worker or losing one. To
# replace a registration, revoke it on the dashboard (or DELETE
# /factory/workers/<id>), blank the token in its env file, run again.
set -euo pipefail
: "${OMARCHY_API:=https://pkgs.firemanxbr.org}"
: "${OMARCHY_CONTRIBUTOR_TOKEN:?OMARCHY_CONTRIBUTOR_TOKEN is required: the contributor token of a maintainer, from the profile page (never paste it anywhere else)}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
where="$(sed -n 's/^WHERE=//p' "$here/.env" 2>/dev/null | head -1)"; where="${where:-$(hostname -s)}"
command -v jq >/dev/null || { echo "jq is required (pacman -S jq)"; exit 2; }

api() { curl -sS --fail-with-body --max-time 30 -X "$1" "$OMARCHY_API/api/v1$2" -H "authorization: Bearer $OMARCHY_CONTRIBUTOR_TOKEN" -H "content-type: application/json" ${3:+-d "$3"}; }

me="$(api GET /factory/me)" || { echo "the pool did not accept the contributor token: $me" >&2; exit 2; }
login="$(jq -r .login <<<"$me")"; role="$(jq -r .role <<<"$me")"
[[ "$role" == maintainer ]] || { echo "$login is a $role; a maintainer's token is needed to trust the project's workers" >&2; exit 2; }

for svc in pool-x86_64 pool-aarch64 review-x86_64 review-aarch64 community-x86_64 community-aarch64; do
  f="$here/etc/$svc.env"; role="${svc%-*}"; arch="${svc##*-}"
  if [[ -f "$f" ]] && grep -qE '^OMARCHY_WORKER_TOKEN=omw_' "$f"; then
    prev="$(sed -n 's/^# worker: //p' "$f" | head -1)"
    echo "$svc: already registered ($prev); skipping"
    continue
  fi
  body="$(jq -n --arg n "$where-$role-$arch" --arg a "$arch" --arg w "$where" --arg r "$role" '{name: $n, arch: $a, labels: {where: $w, role: $r}}')"
  reg="$(api POST /factory/workers "$body")" || { echo "$svc: registration failed: $reg" >&2; exit 1; }
  id="$(jq -r .worker <<<"$reg")"; token="$(jq -r .token <<<"$reg")"
  umask 077
  printf '# %s\n# worker: %s\nOMARCHY_WORKER_TOKEN=%s\n' "$svc" "$id" "$token" > "$f"
  if [[ "$role" != community ]]; then
    api POST "/factory/workers/$id/trust" '{"trust":"project"}' >/dev/null || { echo "$svc: registered as $id but not trusted — trust it on Review" >&2; continue; }
    echo "$svc: $id (project trust by $login)"
  else
    echo "$svc: $id (community, shared)"
  fi
done
echo "tokens are in $here/etc/*.env (mode 600); docker compose up -d starts the workers"
