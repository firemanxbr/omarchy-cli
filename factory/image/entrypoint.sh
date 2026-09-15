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
#                      an agent key — ANTHROPIC_API_KEY, OPENAI_API_KEY,
#                      GEMINI_API_KEY or XAI_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN for
#                      a Claude subscription — brings the owner's agent).
#   project trust    → the project's worker: the pool's jobs and the rebuild
#                      of approved packages, each in a fresh sibling
#                      container through the runtime's socket mounted at
#                      /var/run/docker.sock (docs: /docs/workers); with an
#                      agent key it also audits staged builds for the
#                      maintainers (the second agent).
#
# OMARCHY_WORKER_ROLE names one of the three containers the project runs
# (docs: /docs/workers — *The three roles*), and is optional: without it the
# trust decides everything, as above. With it:
#
#   pool       a project worker for the pool's own jobs only — sync, render,
#              promote, rollback, health, security, enqueue, gc, verify;
#              never a build, never an audit. No agent key needed.
#   review     a project worker for the maintainers' work only — the rebuild
#              of approved packages and the audit of staged builds (the
#              second agent, so it wants an agent key); never a pool job.
#   community  a shared community worker: builds anyone's community
#              packages, drafts PKGBUILDs for package requests with its
#              owner's agent key (WORKER_SHARED=1 is implied).
#   agent      no worker at all: the agent served over HTTP on :8790
#              (factory/bin/agent-proxy) for a sibling container that
#              cannot run it — the emulated x86_64 community worker, where
#              Claude Code's binary dies under qemu. Needs no token.
#
# A role reports itself in the worker's labels ("role"), so the Factory page
# shows what each container is for. Extra arguments go to `pkg-repo work`
# in project mode (--idle-exit, --once; --kind and --labels are the role's
# when a role is set); in community mode they are ignored.
set -euo pipefail
: "${OMARCHY_API:=https://pkgs.firemanxbr.org}"
role="${OMARCHY_WORKER_ROLE:-}"
case "$role" in ""|pool|review|community|agent) ;; *) echo "omarchy-worker: OMARCHY_WORKER_ROLE must be pool, review, community or agent (or unset)" >&2; exit 2 ;; esac
if [[ "$role" == agent ]]; then
  # The agent alone, for the containers that cannot run it. Claude Code is
  # installed below the same way a worker installs it; then the proxy.
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${CLAUDE_CODE_BIN:-}" ]] && ! command -v claude >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/claude" ]]; then
    curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || echo "omarchy-worker: Claude Code did not install; the proxy will answer 502 until it does" >&2
  fi
  export PATH="$HOME/.local/bin:$PATH"
  exec python3 /usr/local/lib/omarchy-factory/bin/agent-proxy
fi
: "${OMARCHY_WORKER_TOKEN:?OMARCHY_WORKER_TOKEN is required: register a worker on the Contributors page}"

self="$(curl -sS --fail-with-body --max-time 30 "$OMARCHY_API/api/v1/factory/workers/self" -H "authorization: Bearer $OMARCHY_WORKER_TOKEN" 2>&1)" \
  || { echo "omarchy-worker: the pool did not accept this token: $self" >&2; exit 2; }
id="$(jq -r .id <<<"$self")"; trust="$(jq -r .trust <<<"$self")"; arch="$(jq -r .arch <<<"$self")"; owner="$(jq -r '.owner // ""' <<<"$self")"
host_arch="$(uname -m)"; [[ "$host_arch" == arm64 ]] && host_arch=aarch64
mode="${OMARCHY_WORKER_MODE:-$([[ "$trust" == project ]] && echo project || echo community)}"
# A role is a promise about what this container does; the registration's
# trust must allow it, or the container says so and stops rather than
# quietly doing something else.
case "$role" in
  pool|review) [[ "$trust" == project ]] || { echo "omarchy-worker: $id is a $trust registration; the $role role needs a project-trusted one (a maintainer trusts it on Review)" >&2; exit 2; }; mode=project ;;
  community) [[ "$trust" == community ]] || { echo "omarchy-worker: $id is project-trusted; the community role wants a community registration (never mix the project's work with contributors' builds)" >&2; exit 2; }; mode=community; export WORKER_SHARED=1 ;;
esac
# A community worker builds inside this container, so it must be the
# registered architecture; a project worker starts a container per task
# with the task's platform, so its registration is a label (an x86_64 pool
# or review worker runs natively on an aarch64 host).
if [[ "$arch" != "$host_arch" && "$mode" != project ]]; then
  echo "omarchy-worker: $id is registered for $arch but this machine is $host_arch" >&2; exit 2
fi
agent=""; for k in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY XAI_API_KEY; do [[ -n "${!k:-}" ]] && agent=1; done
# A Claude subscription as the agent (CLAUDE_CODE_OAUTH_TOKEN, from `claude
# setup-token` on the owner's machine): factory/bin/agent.py runs Claude
# Code in print mode, so the binary must be here. The image does not ship
# it (it is Anthropic's, under their terms); the official installer fetches
# the release for this architecture, checksum verified, into this
# container's home at first start. ~200 MB, once per container.
if [[ "${FACTORY_PROVIDER:-claude-code}" == claude-code && -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${CLAUDE_CODE_BIN:-}" ]] && ! command -v claude >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/claude" ]]; then
  echo "omarchy-worker: CLAUDE_CODE_OAUTH_TOKEN is set; installing Claude Code (claude.ai/install.sh) for the audits and drafts" >&2
  if curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 && [[ -x "$HOME/.local/bin/claude" ]]; then
    echo "omarchy-worker: Claude Code $("$HOME/.local/bin/claude" --version 2>/dev/null | head -n1) installed" >&2
  else
    echo "omarchy-worker: Claude Code did not install; audits and drafts will fail until it does (CLAUDE_CODE_BIN can point at a mounted binary)" >&2
  fi
fi
export PATH="$HOME/.local/bin:$PATH"
labels="$(jq -cn --argjson l "${WORKER_LABELS:-"{}"}" --arg r "$role" 'if $r == "" then $l else $l + {role: $r} end')"
export WORKER_LABELS="$labels"

case "$mode" in
  project)
    # The runtime's socket (DOCKER_HOST, unix:///var/run/docker.sock in the image).
    sock="${DOCKER_HOST:-unix:///var/run/docker.sock}"; sock="${sock#unix://}"
    if [[ "$sock" != *://* && ! -S "$sock" ]]; then
      echo "omarchy-worker: $id is a project worker; its builds and checks run in fresh containers through your runtime — mount its socket at $sock (docs: /docs/workers)" >&2
      exit 2
    fi
    [[ -n "${OMARCHY_WORK_DIR:-}" ]] || echo "omarchy-worker: OMARCHY_WORK_DIR not set; using /var/lib/omarchy-worker — mount the same host path there" >&2
    case "$role" in
      pool)
        echo "omarchy-worker: $id — pool worker ($arch): the pool's jobs, no builds, no audits" >&2
        exec pkg-repo work --arch "$arch" --labels "$labels" --kind sync --kind render --kind promote --kind rollback --kind health --kind security --kind enqueue --kind gc --kind verify --kind relayout "$@"
        ;;
      review)
        [[ -n "$agent" ]] || echo "omarchy-worker: $id has no agent key — approved rebuilds run, audits wait for a review worker with one (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY or XAI_API_KEY)" >&2
        echo "omarchy-worker: $id — review worker ($arch): approved rebuilds${agent:+ and audits of staged builds}, no pool jobs" >&2
        exec pkg-repo work --arch "$arch" --labels "$labels" --kind build --kind publish ${agent:+--kind audit} "$@"
        ;;
      *)
        echo "omarchy-worker: $id — project worker ($arch, ${owner:-project}); pool jobs and approved rebuilds${agent:+, audits of staged builds}" >&2
        exec pkg-repo work --arch "$arch" "$@"
        ;;
    esac
    ;;
  community)
    [[ "$role" != community || -n "$agent" ]] || echo "omarchy-worker: $id has no agent key — registered packages build, package requests (drafts) wait for a community worker with one" >&2
    # The worker reads GitHub's API for every package it builds (the release,
    # the files); without a token GitHub allows 60 requests an hour from this
    # address, and ten builds in a row were ten "rate limit reached" failures.
    [[ -n "${GITHUB_TOKEN:-}" ]] || echo "omarchy-worker: no GITHUB_TOKEN — GitHub allows 60 API requests an hour from this address; a fine-grained token with no permissions gives 5000 (gh auth token works)" >&2
    whose="${owner}'s"; [[ -n "$role" ]] && whose="$role"
    echo "omarchy-worker: $id — $whose worker ($arch); one task per container${WORKER_SHARED:+, shared}${agent:+, with an agent}" >&2
    export WORKER_ID="$id"
    exec omarchy-build-worker --container
    ;;
  *) echo "omarchy-worker: OMARCHY_WORKER_MODE must be community or project" >&2; exit 2 ;;
esac
