import type { Env } from "./index";

export const REPO_URL = "https://github.com/firemanxbr/omarchy-pool";
export const DASHBOARD_HOST = "omarchy-pool.firemanxbr.org";
export const LEGACY_DASHBOARD_HOST = "dashboard-omarchy.firemanxbr.org";

/** What is running: the release tag, its commit and when it was deployed. */
export function version(env: Env) {
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
