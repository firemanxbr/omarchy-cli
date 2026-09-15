/**
 * The record for what came before it. Until 2026-09-15 a package entered
 * the pool as a registration (a repository URL, a name) or as a GitHub
 * issue; since then it enters as a package request, written once to the
 * pool bucket and signed (record.ts, routes/contributors.ts). The
 * registrations made before that have no record, so the scheduler writes
 * one for each — from what the pool already knows: the registration, the
 * GitHub metadata it detected, and the PKGBUILD the contributor's worker
 * staged (its url, pkgdesc and license), when there is one. The record
 * says it was written this way (`migrated`), and it changes nothing else:
 * the package keeps its state and takes every gate like any other.
 */
import type { Env } from "./index";
import { putRecord, recordKey } from "./record";
import { parseProjectUrl } from "./routes/contributors";
import { version } from "./meta";

interface Registration {
  name: string;
  owner: string;
  url: string;
  arches: string;
  release: string | null;
  detected: string | null;
  created_at: string;
}

/** `pkgdesc='…'`, `url="…"`, `license=('MIT')` — the three lines a PKGBUILD always has. */
export function pkgbuildFields(text: string): { url: string | null; pkgdesc: string | null; license: string | null } {
  // Quoted (either quote, parentheses allowed inside — "The popular web
  // browser by Google (Stable Channel)"), the first element of an array
  // (license=('MIT')), or bare (url=https://…).
  const one = (key: string): string | null => {
    const quoted = text.match(new RegExp(`^${key}=(['"])(.*?)\\1`, "m"));
    if (quoted) return quoted[2].trim() || null;
    const array = text.match(new RegExp(`^${key}=\\(\\s*(['"]?)([^'")\\s]+)\\1`, "m"));
    if (array) return array[2].trim() || null;
    const bare = text.match(new RegExp(`^${key}=(\\S+)`, "m"));
    return bare ? bare[1].trim() : null;
  };
  return { url: one("url"), pkgdesc: one("pkgdesc"), license: one("license") };
}

export async function backfillRequests(env: Env): Promise<string> {
  const rows = await env.DB.prepare("SELECT name, owner, url, arches, release, detected, created_at FROM factory_packages WHERE request_id IS NULL ORDER BY created_at LIMIT 10").all<Registration>();
  if (!rows.results.length) return "";
  const done: string[] = [];
  for (const r of rows.results) {
    const detected = r.detected ? (JSON.parse(r.detected) as Record<string, unknown>) : {};
    // The staged PKGBUILD, if any: the contributor's own words for the project, the description and the licence.
    const staged = await env.DB.prepare("SELECT id FROM build_tasks WHERE name = ? AND owner = ? AND staged_prefix IS NOT NULL ORDER BY id DESC LIMIT 1").bind(r.name, r.owner).first<{ id: number }>();
    let fields = { url: null as string | null, pkgdesc: null as string | null, license: null as string | null };
    if (staged) {
      const obj = await env.STAGING.get(`staging/${r.owner}/${r.name}/${staged.id}/PKGBUILD`);
      if (obj) fields = pkgbuildFields(await obj.text());
    }
    const parsed = parseProjectUrl(fields.url ?? r.url);
    const project = "error" in parsed ? r.url : parsed.project;
    const tag = r.release ?? (typeof detected.latest_tag === "string" ? detected.latest_tag : null) ?? "unknown";
    const source = !("error" in parsed) && parsed.github ? `${parsed.project}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz` : project;
    const description = fields.pkgdesc ?? (typeof detected.description === "string" ? detected.description : null) ?? `${r.name} (registered before requests existed)`;
    const license = fields.license ?? (typeof detected.license === "string" && detected.license !== "NOASSERTION" ? detected.license : null) ?? "unknown";
    const req = await env.DB.prepare(
      `INSERT INTO package_requests (name, owner, project, source, version, description, license, arches, checklist, detected, migrated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 1, ?) RETURNING id`,
    )
      .bind(r.name, r.owner, project, source, tag, description.slice(0, 120), license, r.arches, JSON.stringify(detected), r.created_at)
      .first<{ id: number }>();
    if (!req) continue;
    const key = recordKey(r.name, req.id, "request.json");
    const record = await putRecord(env, key, {
      schema: "omarchy-pool/package-request/1",
      request: req.id, name: r.name, project, source, version: tag, description: description.slice(0, 120), license, arches: JSON.parse(r.arches),
      requested_by: r.owner, requested_at: r.created_at,
      checklist: null,
      migrated: { from: "a registration made before package requests existed", registered_at: r.created_at, pkgbuild_of_task: staged?.id ?? null, written_at: new Date().toISOString() },
      detected, pool: version(env).version,
    });
    await env.DB.batch([
      env.DB.prepare("UPDATE package_requests SET record = ?, sha256 = ? WHERE id = ?").bind(record.key, record.sha256, req.id),
      env.DB.prepare("UPDATE factory_packages SET request_id = ?, project = ?, source = ?, description = ?, license = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(req.id, project, source, description.slice(0, 120), license, r.name),
    ]);
    done.push(`${r.name} → ${req.id}`);
  }
  return `requests: ${done.length} registration(s) given their record — ${done.join(", ")}`;
}
