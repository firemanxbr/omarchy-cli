# The project's host

What the project runs its workers on: one machine, six containers of the
one worker image — two of each role, one per architecture (the roles:
[factory/README.md](../README.md) *Three roles*; how the day goes:
[docs/RUNBOOK.md](../../docs/RUNBOOK.md) *The Studio host*). Anyone donating
a machine to the project can use the same three files.

| File | What |
|---|---|
| `setup.sh` | run once with `sudo`: the directory tree (a btrfs subvolume where `/` is btrfs), docker + compose + user-mode emulation for the other architecture, the docker group, the env files to fill in |
| `register.sh` | registers the six workers with the pool under a maintainer's token, trusts the four project ones, writes each worker token into `etc/<service>.env` — prints only the ids |
| `compose.yml` | the six services: `pool-*`, `review-*` (project trust, the runtime's socket, a work directory at the same path on both sides, the shared package cache), `community-*` (community trust, shared, one task per container); the x86_64 community worker is an emulated container on an aarch64 host |

```
POOL_ROOT (/srv/omarchy-pool)
├── .env                 POOL_ROOT and WHERE (the label on the Factory page)
├── compose.yml
├── register.sh
├── etc/                 mode 700; secrets, yours: one worker token per service, agent.env with the agent key
├── work/<service>/      OMARCHY_WORK_DIR of each project worker (task dirs, the clone of this repository, the ABI references)
└── cache/pacman/<arch>/ one pacman package cache per architecture, mounted into every build container (OMARCHY_PKG_CACHE)
```

Install, from a checkout of this repository on the host (or copy the three
files over):

```bash
sudo factory/host/setup.sh                        # then log in again (the docker group)
$EDITOR /srv/omarchy-pool/etc/agent.env           # GEMINI_API_KEY=… (or another provider's)
OMARCHY_CONTRIBUTOR_TOKEN=omc_… /srv/omarchy-pool/register.sh
cd /srv/omarchy-pool && docker compose pull && docker compose up -d
```

Operate:

```bash
docker compose ps                                 # the six, and whether they are up
docker compose logs -f --tail 50 review-aarch64   # one worker
docker compose pull && docker compose up -d       # after a pool release (the image is tagged with it) — recreates the six; a task in flight goes back to the queue when its lease expires (30 min), so do it with the workers idle when you can
docker compose restart pool-x86_64                # a worker that looks stuck (a task it holds goes back to the queue when its lease expires)
```

The Factory page shows the six by role, with the agent each reports; a
worker that is not alive there is not running here. Moving the tree to
another disk (the 4 TB one, when it has a USB enclosure) is `docker compose
down`, copy, mount at the same `POOL_ROOT`, `docker compose up -d`.
