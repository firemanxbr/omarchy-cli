#!/usr/bin/env bash
# setup.sh — prepares an Arch Linux host (Omarchy, Arch Linux ARM, Arch) to
# run the project's six workers (compose.yml beside this script; RUNBOOK,
# *The Studio host*). Run once, as root:
#
#   sudo ./setup.sh [POOL_ROOT]          default POOL_ROOT: /srv/omarchy-pool
#
# What it does, all of it idempotent:
#   - POOL_ROOT: a btrfs subvolume when / is btrfs (outside the root's
#     snapshots), a directory otherwise; work/, cache/pacman/<arch>, etc/
#     owned by the user who ran sudo
#   - docker, docker compose, qemu-user-static(-binfmt) installed and the
#     docker and binfmt services enabled — x86_64 containers on an aarch64
#     host (and the other way round) run under user-mode emulation
#   - the invoking user in the docker group (a new login picks it up)
#   - compose.yml and register.sh copied to POOL_ROOT, .env with POOL_ROOT
#     and WHERE, and one etc/*.env per service to fill in (mode 600)
#
# It writes no secret: register.sh puts the worker tokens in etc/, and the
# agent key goes in etc/agent.env by hand.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 2; }
user="${SUDO_USER:-}"; [[ -n "$user" && "$user" != root ]] || { echo "run with sudo from your own user, not as root"; exit 2; }
root="${1:-/srv/omarchy-pool}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64

echo "==> $root"
if [[ ! -d "$root" ]]; then
  parent="$(dirname "$root")"; mkdir -p "$parent"
  if [[ "$(stat -f -c %T "$parent")" == btrfs ]]; then
    btrfs subvolume create "$root" >/dev/null && echo "    btrfs subvolume (outside the root's snapshots)"
  else
    mkdir -p "$root"
  fi
fi
for d in work cache/pacman/x86_64 cache/pacman/aarch64 cache/build/x86_64 cache/build/aarch64 etc; do mkdir -p "$root/$d"; done
chown -R "$user:$user" "$root"
chmod 700 "$root/etc"

echo "==> packages and services"
pacman -S --needed --noconfirm docker docker-compose qemu-user-static qemu-user-static-binfmt >/dev/null
systemctl enable --now docker >/dev/null 2>&1
systemctl restart systemd-binfmt >/dev/null 2>&1 || true
usermod -aG docker "$user"
other=x86_64; [[ "$arch" == x86_64 ]] && other=aarch64
if [[ -f "/proc/sys/fs/binfmt_misc/qemu-$other" ]]; then echo "    $other containers: emulated (binfmt)"; else echo "    WARNING: no binfmt handler for $other — $other builds will fail on this host" >&2; fi

echo "==> $root/compose.yml"
install -m 644 -o "$user" -g "$user" "$here/compose.yml" "$root/compose.yml"
install -m 755 -o "$user" -g "$user" "$here/register.sh" "$root/register.sh"
install -m 755 -o "$user" -g "$user" "$here/rollout.sh" "$root/rollout.sh"

echo "==> rolling upgrades: omarchy-pool-rollout.timer (every 15 minutes, as $user)"
# A user unit, so the docker group and the compose project are the user's;
# linger keeps user units running without a login session.
home="$(getent passwd "$user" | cut -d: -f6)"
install -d -o "$user" -g "$user" "$home/.config/systemd/user"
cat > "$home/.config/systemd/user/omarchy-pool-rollout.service" <<UNIT
[Unit]
Description=Omarchy Pool: rolling upgrade of the workers to the latest image
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$root
ExecStart=$root/rollout.sh
UNIT
cat > "$home/.config/systemd/user/omarchy-pool-rollout.timer" <<UNIT
[Unit]
Description=Omarchy Pool: check for a new worker image every 15 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
RandomizedDelaySec=2min

[Install]
WantedBy=timers.target
UNIT
chown "$user:$user" "$home/.config/systemd/user/omarchy-pool-rollout."{service,timer}
loginctl enable-linger "$user" >/dev/null 2>&1 || true
[[ -f "$root/.env" ]] || printf 'POOL_ROOT=%s\nWHERE=%s\n' "$root" "$(hostname -s)" > "$root/.env"
chown "$user:$user" "$root/.env"
for svc in pool-x86_64 pool-aarch64 review-x86_64 review-aarch64 community-x86_64 community-aarch64; do
  f="$root/etc/$svc.env"
  [[ -f "$f" ]] || printf '# %s — written by register.sh (the worker token, shown once by the pool)\nOMARCHY_WORKER_TOKEN=\n' "$svc" > "$f"
  chown "$user:$user" "$f"; chmod 600 "$f"
done
f="$root/etc/agent.env"
if [[ ! -f "$f" ]]; then
  cat > "$f" <<'AGENT'
# The agent the review and community workers run — your key, your cost; the
# pool never holds one. One provider is enough; FACTORY_MODEL picks the model.
GEMINI_API_KEY=
FACTORY_PROVIDER=gemini
FACTORY_MODEL=
# Reasoning models think first and the budget goes there: low keeps a Flash
# model's answers complete (and cheap). Unset for a model that rejects it.
FACTORY_REASONING=low
# Drafts read the upstream repository through GitHub's API: 60 requests an
# hour per address without a token, 5000 with one — a fine-grained token
# with no permissions at all is enough (public repositories only).
GITHUB_TOKEN=
#ANTHROPIC_API_KEY=
#OPENAI_API_KEY=
#XAI_API_KEY=
AGENT
fi
chown "$user:$user" "$f"; chmod 600 "$f"

cat <<NEXT

Done. Next, as $user (log in again so the docker group applies):
  1. put your agent key in $root/etc/agent.env
  2. register the six workers and trust the project's four:
       OMARCHY_CONTRIBUTOR_TOKEN=omc_… $root/register.sh        (a maintainer's token; from the profile page, shown once)
  3. cd $root && docker compose pull && docker compose up -d
  4. systemctl --user enable --now omarchy-pool-rollout.timer     (rolling upgrades from then on)
  5. the Factory page lists them within a minute
NEXT
