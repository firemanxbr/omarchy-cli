/**
 * Joining a ring in one command.
 *
 *   GET /setup                              the script: curl -fsSL …/setup | sudo bash -s -- --ring stable
 *   GET /api/v1/pacman.conf?ring=&arch=     the pacman.d include for a ring: what it serves right now
 *
 * The script is short on purpose — it is what a user pipes into sudo, so
 * it must be readable in one screen. It touches two things: a file of its
 * own under /etc/pacman.d, and one `Include` line in /etc/pacman.conf, above
 * [core], once. `--remove` takes both away. It never upgrades: pacman -Syu
 * is the user's.
 */
import { isRing, type Env } from "../index";
import { isRepoArch } from "../r2";
import { EXPECTED_SOURCES, sourceRank } from "../meta";
import { ringHead } from "../db";

/** The include file: one section per database the ring serves for the architecture, in REPO_ORDER (meta.ts); optional sources only when asked (`with=chaotic`). */

export async function pacmanInclude(env: Env, ring: string, arch: string, withOptional: Set<string>, setupUrl: string): Promise<string | null> {
  if (!isRing(ring) || !isRepoArch(arch)) return null;
  const head = await ringHead(env, ring);
  if (!head) return null;
  const dbs = await env.DB.prepare("SELECT repo FROM release_artifacts WHERE release_id = ? AND kind = 'db' AND arch = ? ORDER BY repo").bind(head.id, arch).all<{ repo: string }>();
  const pool = env.POOL_URL.replace(/\/$/, "");
  const sourceOf = (repo: string) => repo.replace(/^omarchy-/, "").replace(new RegExp(`-${ring}$`), "");
  const repos = dbs.results.map((r) => r.repo).sort((a, b) => sourceRank(sourceOf(a)) - sourceRank(sourceOf(b)) || a.localeCompare(b));
  const lines = [
    `# omarchy-pool — ring ${ring}, ${arch}. Generated from what the ring serves (release #${head.seq}).`,
    `# Included from /etc/pacman.conf above [core]; the mirrors below it are the fallback.`,
    `# ${setupUrl} rewrites this file; edit /etc/pacman.conf, not this.`,
    "",
  ];
  for (const repo of repos) {
    const source = sourceOf(repo);
    const expected = EXPECTED_SOURCES.find((e) => e.source === source && e.arch === arch);
    if (expected?.optional && !withOptional.has(source)) continue;
    lines.push(`[${repo}]`, "SigLevel = Required DatabaseRequired", `Server = ${pool}/$arch`, "");
  }
  return lines.join("\n");
}

import SETUP_SH from "../setup.sh";

/** The script, with this deployment's addresses in it. */
export function setupScript(apiBase: string, pool: string): string {
  return SETUP_SH.split("__API__").join(apiBase).split("__POOL__").join(pool);
}
