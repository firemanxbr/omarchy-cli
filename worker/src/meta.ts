import type { Env } from "./index";

export const REPO_URL = "https://github.com/firemanxbr/omarchy-pool";
export const DASHBOARD_HOST = "omarchy-pool.firemanxbr.org";
export const LEGACY_DASHBOARD_HOST = "dashboard-omarchy.firemanxbr.org";

export interface RunningVersion {
  version: string;
  commit: string | null;
  deployed_at: string | null;
  release_url: string | null;
  commit_url: string | null;
}

/** What is running: the release tag, its commit and when it was deployed. */
export function version(env: Env): RunningVersion {
  const v = env.POOL_VERSION || "dev";
  const commit = env.POOL_COMMIT || null;
  return {
    version: v,
    commit,
    deployed_at: env.POOL_DEPLOYED_AT || null,
    release_url: v === "dev" ? null : `${REPO_URL}/releases/tag/${v}`,
    commit_url: commit ? `${REPO_URL}/commit/${commit}` : null,
  };
}

/**
 * Every upstream repository the pipeline mirrors (the SOURCES table of
 * sync.yml), so the dashboard can show what has not been synced yet.
 */
export const EXPECTED_SOURCES: { source: string; arch: string; upstream: string }[] = [
  { source: "core", arch: "x86_64", upstream: "mirror.omarchy.org" },
  { source: "extra", arch: "x86_64", upstream: "mirror.omarchy.org" },
  { source: "multilib", arch: "x86_64", upstream: "mirror.omarchy.org" },
  { source: "packages", arch: "x86_64", upstream: "pkgs.omarchy.org" },
  { source: "core", arch: "aarch64", upstream: "os.archlinuxarm.org" },
  { source: "extra", arch: "aarch64", upstream: "os.archlinuxarm.org" },
  { source: "alarm", arch: "aarch64", upstream: "os.archlinuxarm.org" },
  { source: "packages", arch: "aarch64", upstream: "pkgs.omarchy.org" },
];
