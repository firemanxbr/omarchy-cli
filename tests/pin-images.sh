#!/usr/bin/env bash
# Pins the container images the checks run in (health, ABI, e2e) to the
# digests they have right now, so a run is reproducible until someone pins
# again. Writes tests/images.env, which the scripts source. Run it when a
# base image should move: `tests/pin-images.sh && git diff tests/images.env`.
set -euo pipefail
OUT="$(cd "$(dirname "$0")" && pwd)/images.env"

digest() { # repository tag → repo@sha256:…
  local repo="$1" tag="$2" token
  token="$(curl -sS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull" | jq -r .token)"
  curl -sSI -H "authorization: Bearer $token" \
    -H "accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://registry-1.docker.io/v2/$repo/manifests/$tag" | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}' | tr -d '\r'
}

x86="$(digest library/archlinux base)"; arm="$(digest menci/archlinuxarm base)"
[[ -n "$x86" && -n "$arm" ]] || { echo "could not resolve a digest" >&2; exit 1; }
{
  echo "# Container images the checks run in, pinned by digest (tests/pin-images.sh, $(date -u +%F))."
  echo "# The tag is kept beside the digest for the reader; the digest is what pulls."
  echo "ARCHLINUX_BASE=\"docker.io/library/archlinux:base@$x86\""
  echo "ARCHLINUXARM_BASE=\"docker.io/menci/archlinuxarm:base@$arm\""
} > "$OUT"
cat "$OUT"
