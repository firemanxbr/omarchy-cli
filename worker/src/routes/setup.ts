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
import { isRepoArch, keyDir } from "../r2";
import { EXPECTED_SOURCES, sourceRank, sourceOfRepo } from "../meta";
import { ringHead } from "../db";
import { UNMOVED } from "./relayout";

/** The include file: one section per database the ring serves for the architecture, in REPO_ORDER (meta.ts); optional sources only when asked (`with=chaotic`). */

export async function pacmanInclude(env: Env, ring: string, arch: string, withOptional: Set<string>, setupUrl: string): Promise<string | null> {
  if (!isRing(ring) || !isRepoArch(arch)) return null;
  const head = await ringHead(env, ring);
  if (!head) return null;
  const dbs = await env.DB.prepare("SELECT repo, r2_key FROM release_artifacts WHERE release_id = ? AND kind = 'db' AND arch = ? ORDER BY repo").bind(head.id, arch).all<{ repo: string; r2_key: string }>();
  const pool = env.POOL_URL.replace(/\/$/, "");
  const sourceOf = (repo: string) => sourceOfRepo(repo) ?? repo;
  const repos = dbs.results.sort((a, b) => sourceRank(sourceOf(a.repo)) - sourceRank(sourceOf(b.repo)) || a.repo.localeCompare(b.repo));
  // A section's Server is the directory its database is in — a source's own
  // (`<source>/<arch>`), where its packages are. While a relayout is still
  // moving objects out of the flat `<arch>/` directory, that one is named
  // second: pacman tries the servers in order, so a package not yet moved
  // is still found. The line goes when the last object has moved.
  const moving = await env.DB.prepare(`SELECT 1 FROM packages WHERE ${UNMOVED} LIMIT 1`).first();
  const lines = [
    `# omarchy-pool — ring ${ring}, ${arch}. Generated from what the ring serves (release #${head.seq}).`,
    `# Included from /etc/pacman.conf above [core]; the mirrors below it are the fallback.`,
    `# ${setupUrl} rewrites this file; edit /etc/pacman.conf, not this.`,
    "",
  ];
  for (const { repo, r2_key } of repos) {
    const source = sourceOf(repo);
    const expected = EXPECTED_SOURCES.find((e) => e.source === source && e.arch === arch);
    if (expected?.optional && !withOptional.has(source)) continue;
    const dir = keyDir(r2_key) === arch ? "$arch" : keyDir(r2_key).replace(new RegExp(`/${arch}$`), "/$arch");
    lines.push(`[${repo}]`, "SigLevel = Required DatabaseRequired", `Server = ${pool}/${dir}`);
    if (moving && dir !== "$arch") lines.push(`Server = ${pool}/$arch`);
    lines.push("");
  }
  return lines.join("\n");
}

import SETUP_SH from "../setup.sh";

/** The script, with this deployment's addresses in it. */
export function setupScript(apiBase: string, pool: string): string {
  return SETUP_SH.split("__API__").join(apiBase).split("__POOL__").join(pool);
}
