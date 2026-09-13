/**
 * OPR provenance: once a day the brain reads omacom/omarchy-pkgs — the
 * repository the Omarchy Package Repository is built from — and records,
 * per package, whether its PKGBUILD is Omarchy's own (`source: local`) or
 * synced from the AUR (`source: aur`, tracking an `upstream_commit`), and
 * the commit that last changed it. One tree request tells what changed
 * since the last scan; only changed packages cost a request each. The
 * number the dashboard drives to zero: packages in stable still built
 * from an AUR recipe.
 */
import type { Env } from "./index";

export const OPR_REPO = "omacom/omarchy-pkgs";
const API = `https://api.github.com/repos/${OPR_REPO}`;

interface TreeEntry { path: string; type: string; sha: string }
interface OprMeta { source?: string; upstream_commit?: string; release_ring?: string; channels?: string[]; pinned?: boolean }

function headers(env: Env): Record<string, string> {
  const h: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "omarchy-pool" };
  if (env.GITHUB_TOKEN) h.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

export async function syncProvenance(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'provenance_scanned'").first<{ value: string }>();
  if (last?.value === day) return "provenance: scanned today";
  // The whole tree in one request: every PKGBUILD and .omarchy/package.json with its blob sha.
  const headRes = await fetcher(`${API}/commits/master`, { headers: headers(env) });
  if (!headRes.ok) throw new Error(`${OPR_REPO} head: HTTP ${headRes.status}`);
  const head = ((await headRes.json()) as { sha: string }).sha;
  const treeRes = await fetcher(`${API}/git/trees/${head}?recursive=1`, { headers: headers(env) });
  if (!treeRes.ok) throw new Error(`${OPR_REPO} tree: HTTP ${treeRes.status}`);
  const tree = ((await treeRes.json()) as { tree: TreeEntry[]; truncated?: boolean }).tree;
  const pkgbuilds = new Map<string, string>();
  const metas = new Map<string, string>();
  for (const e of tree) {
    const m = e.path.match(/^pkgbuilds\/([^/]+)\/(PKGBUILD|\.omarchy\/package\.json)$/);
    if (!m || e.type !== "blob") continue;
    (m[2] === "PKGBUILD" ? pkgbuilds : metas).set(m[1], e.sha);
  }
  const known = new Map((await env.DB.prepare("SELECT name, pkgbuild_blob, meta FROM opr_packages").all<{ name: string; pkgbuild_blob: string; meta: string }>()).results.map((r) => [r.name, r]));
  let changed = 0, fetched = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const [name, blob] of pkgbuilds) {
    const was = known.get(name);
    const metaSha = metas.get(name);
    const unchanged = was && was.pkgbuild_blob === blob;
    if (unchanged) continue;
    changed++;
    // The metadata (small) and the last commit touching the package (one request each, changed packages only).
    let meta: OprMeta = {};
    if (metaSha) {
      const r = await fetcher(`https://raw.githubusercontent.com/${OPR_REPO}/${head}/pkgbuilds/${name}/.omarchy/package.json`, { headers: { "user-agent": "omarchy-pool" } });
      fetched++;
      if (r.ok) {
        try { meta = (await r.json()) as OprMeta; } catch { meta = {}; }
      }
    }
    let commit: { sha: string; date: string } | null = null;
    const c = await fetcher(`${API}/commits?path=${encodeURIComponent(`pkgbuilds/${name}`)}&sha=${head}&per_page=1`, { headers: headers(env) });
    fetched++;
    if (c.ok) {
      const list = (await c.json()) as { sha: string; commit: { committer?: { date?: string }; author?: { date?: string } } }[];
      if (list[0]) commit = { sha: list[0].sha, date: list[0].commit.committer?.date ?? list[0].commit.author?.date ?? "" };
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO opr_packages (name, source, upstream_commit, release_ring, channels, pinned, pkgbuild_blob, pkgbuild_commit, pkgbuild_committed_at, meta, scanned_commit, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (name) DO UPDATE SET source = excluded.source, upstream_commit = excluded.upstream_commit, release_ring = excluded.release_ring, channels = excluded.channels,
           pinned = excluded.pinned, pkgbuild_blob = excluded.pkgbuild_blob, pkgbuild_commit = excluded.pkgbuild_commit, pkgbuild_committed_at = excluded.pkgbuild_committed_at,
           meta = excluded.meta, scanned_commit = excluded.scanned_commit, updated_at = excluded.updated_at`,
      ).bind(name, meta.source === "aur" ? "aur" : meta.source === "local" ? "local" : "unknown", meta.upstream_commit ?? null, meta.release_ring ?? null, meta.channels ? JSON.stringify(meta.channels) : null, meta.pinned ? 1 : 0, blob, commit?.sha ?? null, commit?.date || null, JSON.stringify(meta), head),
    );
    // Stay well inside one invocation's subrequest budget; the rest tomorrow.
    if (fetched >= 400) break;
  }
  // Packages that left the repository.
  const gone = [...known.keys()].filter((n) => !pkgbuilds.has(n));
  if (gone.length) stmts.push(env.DB.prepare("DELETE FROM opr_packages WHERE name IN (SELECT value FROM json_each(?))").bind(JSON.stringify(gone)));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  const complete = fetched < 400;
  if (complete) {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('provenance_scanned', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(day).run();
  }
  const summary = `provenance: ${OPR_REPO}@${head.slice(0, 7)}: ${pkgbuilds.size} packages, ${changed} changed, ${gone.length} gone${complete ? "" : " — more tomorrow"}`;
  if (changed || gone.length) {
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('provenance', NULL, 'packages', 'ok', ?, ?)")
      .bind(summary, JSON.stringify({ commit: head, packages: pkgbuilds.size, changed, gone }))
      .run();
  }
  return summary;
}

/** Provenance of one OPR package, for the package page. */
export async function provenanceOf(env: Env, name: string): Promise<Record<string, unknown> | null> {
  const r = await env.DB.prepare("SELECT name, source, upstream_commit, release_ring, channels, pinned, pkgbuild_commit, pkgbuild_committed_at, scanned_commit, updated_at FROM opr_packages WHERE name = ?")
    .bind(name)
    .first<{ name: string; source: string; upstream_commit: string | null; release_ring: string | null; channels: string | null; pinned: number; pkgbuild_commit: string | null; pkgbuild_committed_at: string | null; scanned_commit: string; updated_at: string }>();
  if (!r) return null;
  return {
    repository: `https://github.com/${OPR_REPO}`,
    pkgbuild: `https://github.com/${OPR_REPO}/tree/${r.pkgbuild_commit ?? "master"}/pkgbuilds/${r.name}`,
    source: r.source,
    upstream_commit: r.upstream_commit,
    aur: r.source === "aur" ? `https://aur.archlinux.org/cgit/aur.git/log/?h=${encodeURIComponent(r.name)}` : null,
    release_ring: r.release_ring,
    channels: r.channels ? JSON.parse(r.channels) : null,
    pinned: r.pinned === 1,
    pkgbuild_commit: r.pkgbuild_commit,
    pkgbuild_committed_at: r.pkgbuild_committed_at,
    scanned_at: r.updated_at,
  };
}

/** How many OPR packages a ring serves, by where their recipe comes from — the number to drive to zero is `aur`. */
export async function provenanceCounts(env: Env, ring: string): Promise<{ packages: number; local: number; aur: number; unknown: number }> {
  const r = await env.DB.prepare(
    `SELECT COUNT(DISTINCT p.name) AS packages,
            COUNT(DISTINCT CASE WHEN o.source = 'local' THEN p.name END) AS local,
            COUNT(DISTINCT CASE WHEN o.source = 'aur' THEN p.name END) AS aur,
            COUNT(DISTINCT CASE WHEN o.name IS NULL OR o.source = 'unknown' THEN p.name END) AS unknown
       FROM ring_packages rp JOIN packages p ON p.id = rp.package_id LEFT JOIN opr_packages o ON o.name = p.name
      WHERE rp.ring = ? AND p.source = 'packages'`,
  ).bind(ring).first<{ packages: number; local: number; aur: number; unknown: number }>();
  return r ?? { packages: 0, local: 0, aur: 0, unknown: 0 };
}
