/**
 * New upstream releases of approved packages, built the way the first
 * version was: by the owner's worker, as evidence for a maintainer. Once a
 * day the brain asks GitHub for each approved package's latest release
 * (one request per package, the scheduler's token when there is one) and,
 * for a tag newer than what was approved, queues a community build from
 * the approved PKGBUILD with pkgver moved to the tag (`bump:<task>@<tag>`).
 *
 * The owner's worker has fourteen days; after that a donated (--shared)
 * worker may build it. Thirty days without a build and the package is
 * unmaintained: no more bumps until its owner (or a maintainer, by removing
 * the registration for someone else) takes it up again.
 */
import type { Env } from "./index";

const SHARED_AFTER_DAYS = 14;
const UNMAINTAINED_AFTER_DAYS = 30;

interface Pkg {
  name: string;
  owner: string;
  url: string;
  group: string;
  arches: string;
  status: string;
}

/** `v1.2.3` → `1.2.3`, `release/1.0` → `1.0`; a pkgver cannot carry `-` or `/`, the usual tag punctuation becomes `.`. */
export function pkgverOf(tag: string): string {
  const last = tag.includes("/") ? tag.slice(tag.lastIndexOf("/") + 1) : tag;
  return last.replace(/^[vV]/, "").replace(/-/g, ".").replace(/[^A-Za-z0-9.+_:~]/g, "");
}

async function latestTag(url: string, env: Env, fetcher: typeof fetch): Promise<string | null> {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) return null;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "omarchy-pool" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetcher(`https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, "")}/releases/latest`, { headers });
  if (res.status === 404) return null; // no releases: nothing to bump to
  if (!res.ok) throw new Error(`releases of ${m[1]}/${m[2]}: HTTP ${res.status}`);
  const r = (await res.json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean };
  return r.tag_name && !r.draft && !r.prerelease ? r.tag_name : null;
}

export async function checkUpdates(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'updates_checked'").first<{ value: string }>();
  if (last?.value === day) return "updates: checked today";
  const log: string[] = [];

  // The policy first: a bump nobody built in thirty days marks its package.
  const stale = await env.DB.prepare(
    `SELECT DISTINCT name FROM build_tasks WHERE status = 'queued' AND trust = 'community' AND reason LIKE 'bump to %'
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-${UNMAINTAINED_AFTER_DAYS} days')`,
  )
    .bind(now.toISOString())
    .all<{ name: string }>();
  for (const { name } of stale.results) {
    await env.DB.batch([
      env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE name = ? AND status = 'queued' AND trust = 'community'").bind(`no worker built this bump in ${UNMAINTAINED_AFTER_DAYS} days; the package is unmaintained`, name),
      env.DB.prepare("UPDATE factory_packages SET status = 'unmaintained', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`no worker built the last bump in ${UNMAINTAINED_AFTER_DAYS} days; bumps stop until the owner builds again or a maintainer removes the registration`, name),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('bump', NULL, 'factory', 'warn', ?, ?)").bind(`${name} is unmaintained: no worker built its bump in ${UNMAINTAINED_AFTER_DAYS} days`, JSON.stringify({ name, days: UNMAINTAINED_AFTER_DAYS })),
    ]);
    log.push(`${name}: unmaintained`);
  }

  const pkgs = await env.DB.prepare(
    `SELECT p.name, p.owner, p.url, p."group", p.arches, p.status FROM factory_packages p
      WHERE p.status != 'unmaintained' AND p.url LIKE 'https://github.com/%'
        AND EXISTS (SELECT 1 FROM approvals a WHERE a.name = p.name AND a.decision = 'approved')`,
  ).all<Pkg>();
  let checked = 0;
  for (const p of pkgs.results) {
    let tag: string | null;
    try {
      tag = await latestTag(p.url, env, fetcher);
    } catch (e) {
      log.push(`${p.name}: ${String(e)}`);
      continue;
    }
    checked++;
    if (!tag) continue;
    const want = pkgverOf(tag);
    // What was approved last: its version and the task whose PKGBUILD to start from.
    const approved = await env.DB.prepare("SELECT task_id, version FROM approvals WHERE name = ? AND decision = 'approved' ORDER BY id DESC LIMIT 1").bind(p.name).first<{ task_id: number; version: string | null }>();
    if (!approved) continue;
    const have = (approved.version ?? "").replace(/^\d+:/, "").replace(/-\d+$/, "");
    if (have === want) continue;
    const pending = await env.DB.prepare("SELECT id FROM build_tasks WHERE name = ? AND reason = ? AND status IN ('queued', 'leased', 'staged')").bind(p.name, `bump to ${tag}`).first();
    if (pending) continue;
    const sharedAfter = new Date(now.getTime() + SHARED_AFTER_DAYS * 86400000).toISOString();
    const arches = (JSON.parse(p.arches || "[]") as string[]).filter((a) => a === "x86_64" || a === "aarch64");
    await env.DB.batch([
      ...arches.map((arch) =>
        env.DB.prepare(`INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, shared_after) VALUES (?, ?, ?, ?, ?, ?, 100, 0, 'community', ?, 'build', ?)`)
          .bind(p.name, p.group, arch, `${want}-1`, `bump:${approved.task_id}@${tag}`, `bump to ${tag}`, p.owner, sharedAfter),
      ),
      env.DB.prepare("UPDATE factory_packages SET status = 'waiting', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`${tag} released upstream; a build is queued for ${p.owner}'s worker (anyone's after ${SHARED_AFTER_DAYS} days)`, p.name),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('bump', NULL, 'factory', 'ok', ?, ?)").bind(`${p.name}: upstream ${tag} (approved ${approved.version ?? "?"}); build queued for ${p.owner}'s worker on ${arches.join(", ")}`, JSON.stringify({ name: p.name, tag, approved: approved.version, arches, owner: p.owner, shared_after: sharedAfter })),
    ]);
    log.push(`${p.name}: ${tag} queued`);
  }
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('updates_checked', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(day).run();
  return `updates: ${checked} package(s) checked${log.length ? " — " + log.join("; ") : ""}`;
}
