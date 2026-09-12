import { isRing, json, RINGS, type Env, type Ring } from "../index";
import { isRepoArch } from "../r2";
import { ringHead } from "../db";
import { gunzipJson } from "../gzip";

/**
 * Package search and the package page's data, always within a ring's current
 * release and one architecture.
 *
 *   GET /search?q=&ring=stable&arch=x86_64&limit=50
 *   GET /package/:name?ring=stable&arch=x86_64
 *   GET /package/:name/files?ring=stable&arch=x86_64
 */

interface PackageRow {
  id: number;
  name: string;
  version: string;
  arch: string;
  repo_arch: string;
  source: string;
  filename: string;
  sha256: string;
  size_download: number;
  size_installed: number;
  has_signature: number;
  created_at: string;
  manifest_json?: string;
}

function scope(url: URL, env: Env): { ring: Ring; arch: string } | Response {
  const ring = url.searchParams.get("ring") ?? env.DEFAULT_RING;
  const arch = url.searchParams.get("arch") ?? "x86_64";
  if (!isRing(ring)) return json({ error: "unknown ring" }, 400);
  if (!isRepoArch(arch)) return json({ error: "unknown arch" }, 400);
  return { ring, arch };
}

export async function handleSearch(url: URL, env: Env): Promise<Response> {
  const s = scope(url, env);
  if (s instanceof Response) return s;
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 50)), 200);
  if (q.length < 2) return json({ error: "q must have at least 2 characters" }, 400);
  const head = await ringHead(env, s.ring);
  if (!head) return json({ ring: s.ring, arch: s.arch, query: q, packages: [] });
  const like = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
  const rows = await env.DB.prepare(
    `SELECT p.name, p.version, p.repo_arch, p.source, p.size_download, p.sha256,
            json_extract(p.manifest_json, '$.description') AS description
       FROM release_packages rp JOIN packages p ON p.id = rp.package_id
      WHERE rp.release_id = ?1 AND p.repo_arch = ?2
        AND (p.name LIKE ?3 ESCAPE '\\' OR json_extract(p.manifest_json, '$.description') LIKE ?3 ESCAPE '\\')
      ORDER BY CASE WHEN p.name = ?4 THEN 0 WHEN p.name LIKE ?5 ESCAPE '\\' THEN 1 WHEN p.name LIKE ?3 ESCAPE '\\' THEN 2 ELSE 3 END, p.name
      LIMIT ?6`,
  )
    .bind(head.id, s.arch, like, q, `${q.replace(/[%_]/g, (c) => "\\" + c)}%`, limit)
    .all();
  return json({ ring: s.ring, arch: s.arch, release_id: head.id, query: q, packages: rows.results }, 200, { "cache-control": "public, max-age=60" });
}

/** The package name (or soname) a dependency string refers to: `foo>=1.2` → `foo`. */
function capabilityOf(dep: string): string {
  return dep.split(/[<>=]/)[0].trim();
}

export async function handlePackage(name: string, url: URL, env: Env): Promise<Response> {
  const s = scope(url, env);
  if (s instanceof Response) return s;

  // Where the package is in every ring (for this architecture); the page
  // shows the requested ring's object, or the first ring that has it.
  const heads = await Promise.all(RINGS.map(async (ring) => ({ ring, head: await ringHead(env, ring) })));
  const inRings: { ring: string; release_id: number; release_seq: number; version: string; sha256: string; size_download: number; source: string; filename: string; created_at: string }[] = [];
  const rowsByRing = new Map<string, PackageRow>();
  for (const { ring, head } of heads) {
    if (!head) continue;
    const row = await env.DB.prepare(
      `SELECT p.id, p.name, p.version, p.arch, p.repo_arch, p.source, p.filename, p.sha256, p.size_download, p.size_installed, p.has_signature, p.created_at
         FROM release_packages rp JOIN packages p ON p.id = rp.package_id
        WHERE rp.release_id = ?1 AND p.name = ?2 AND p.repo_arch = ?3`,
    )
      .bind(head.id, name, s.arch)
      .first<PackageRow>();
    if (!row) continue;
    rowsByRing.set(ring, row);
    inRings.push({ ring, release_id: head.id, release_seq: head.seq, version: row.version, sha256: row.sha256, size_download: row.size_download, source: row.source, filename: row.filename, created_at: row.created_at });
  }
  const pick = inRings.find((r) => r.ring === s.ring) ?? inRings[0];
  const chosen = pick ? rowsByRing.get(pick.ring) : undefined;
  if (!pick || !chosen) return json({ error: `${name} is not in any ring for ${s.arch}` }, 404);
  const head = heads.find((h) => h.ring === pick.ring)?.head;
  if (!head) return json({ error: "ring vanished" }, 500);

  const full = await env.DB.prepare("SELECT manifest_json FROM packages WHERE id = ?").bind(chosen.id).first<{ manifest_json: string }>();
  const manifest = JSON.parse(full?.manifest_json ?? "{}") as {
    description?: string;
    url?: string;
    licenses?: string[];
    pkginfo?: { base?: string; builddate?: number; packager?: string; groups?: string[]; depends?: string[]; optdepends?: string[]; provides?: string[]; conflicts?: string[]; replaces?: string[] };
    provides?: string[];
    requires?: string[];
    optional?: string[];
    files?: string[];
  };
  delete manifest.files;

  // Forward edges: declared dependencies and the sonames its binaries load,
  // each resolved to the package that provides it within this ring.
  const declared = (manifest.pkginfo?.depends ?? []).map(capabilityOf);
  const sonames = (manifest.requires ?? []).filter((r) => /\.so(\.|$|\()/.test(r)).map((r) => r.replace(/\(.*\)$/, ""));
  const wanted = [...new Set([...declared, ...sonames])];
  const providers = new Map<string, { name: string; version: string }>();
  for (let i = 0; i < wanted.length; i += 100) {
    const chunk = wanted.slice(i, i + 100);
    const rows = await env.DB.prepare(
      `SELECT DISTINCT cap.value AS capability, p.name, p.version
         FROM json_each(?1) cap
         JOIN packages p ON p.repo_arch = ?3
         JOIN release_packages rp ON rp.package_id = p.id AND rp.release_id = ?2
        WHERE p.name = cap.value
           OR p.id IN (SELECT pv.package_id FROM package_provides pv WHERE pv.capability = cap.value
                        AND (pv.declared = 1 OR cap.value GLOB '*.so.[0-9]*'))`,
    )
      .bind(JSON.stringify(chunk), head.id, s.arch)
      .all<{ capability: string; name: string; version: string }>();
    for (const r of rows.results) if (!providers.has(r.capability)) providers.set(r.capability, { name: r.name, version: r.version });
  }
  const depends = declared.map((c) => ({ name: c, provider: providers.get(c) ?? null }));
  const links = [...new Set(sonames)].map((so) => ({ soname: so, provider: providers.get(so) ?? null }));

  // Reverse edges: packages in the ring that depend on this one by name or
  // by something it provides (a soname = a binary that actually loads it).
  const caps = [chosen.name, ...(manifest.provides ?? []).map(capabilityOf)];
  const reverse = await env.DB.prepare(
    `SELECT DISTINCT p.name, p.version, rq.requirement
       FROM package_requires rq
       JOIN packages p ON p.id = rq.package_id AND p.repo_arch = ?3
       JOIN release_packages rp ON rp.package_id = p.id AND rp.release_id = ?2
      WHERE rq.kind = 'depends' AND rq.requirement IN (SELECT value FROM json_each(?1)) AND p.name != ?4
      ORDER BY p.name LIMIT 400`,
  )
    .bind(JSON.stringify([...new Set(caps)]), head.id, s.arch, chosen.name)
    .all<{ name: string; version: string; requirement: string }>();
  const requiredBy = new Map<string, { name: string; version: string; declared: boolean; sonames: string[] }>();
  for (const r of reverse.results) {
    const e = requiredBy.get(r.name) ?? { name: r.name, version: r.version, declared: false, sonames: [] };
    if (/\.so(\.|$)/.test(r.requirement)) e.sonames.push(r.requirement);
    else e.declared = true;
    requiredBy.set(r.name, e);
  }

  // Security: advisories on this object, and open ones on what it depends on
  // or loads (direct exposure; deeper levels are the graph's job).
  const advisoriesOf = async (ids: number[]) =>
    ids.length
      ? (
          await env.DB.prepare(
            `SELECT pa.package_id, pa.match, pa.status AS object_status, a.id, a.source AS tracker, a.package, a.cves, a.severity, a.fixed, a.summary, a.url,
                    (SELECT MAX(c.kev) FROM cve_meta c WHERE c.cve IN (SELECT value FROM json_each(a.cves))) AS kev,
                    (SELECT MAX(c.epss) FROM cve_meta c WHERE c.cve IN (SELECT value FROM json_each(a.cves))) AS epss
               FROM package_advisories pa JOIN advisories a ON a.id = pa.advisory_id
              WHERE pa.package_id IN (SELECT value FROM json_each(?))
              ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
          )
            .bind(JSON.stringify(ids))
            .all<{ package_id: number; match: string; object_status: string; id: string; tracker: string; package: string; cves: string; severity: string; fixed: string | null; summary: string | null; url: string; kev: number | null; epss: number | null }>()
        ).results.map((r) => ({ ...r, cves: JSON.parse(r.cves) as string[], kev: !!r.kev }))
      : [];
  const own = await advisoriesOf([chosen.id]);
  const providerNames = [...new Set([...depends, ...links].map((x) => x.provider?.name).filter((n): n is string => !!n))];
  const providerIds = providerNames.length
    ? (
        await env.DB.prepare(
          `SELECT p.id, p.name FROM release_packages rp JOIN packages p ON p.id = rp.package_id
            WHERE rp.release_id = ?1 AND p.repo_arch = ?2 AND p.name IN (SELECT value FROM json_each(?3))`,
        )
          .bind(head.id, s.arch, JSON.stringify(providerNames))
          .all<{ id: number; name: string }>()
      ).results
    : [];
  const providerAdvisories = (await advisoriesOf(providerIds.map((p) => p.id))).filter((a) => a.object_status === "vulnerable");
  const nameOfId = new Map(providerIds.map((p) => [p.id, p.name]));
  const exposed = providerAdvisories.map((a) => ({
    via: nameOfId.get(a.package_id),
    declared: depends.some((d) => d.provider?.name === nameOfId.get(a.package_id)),
    sonames: links.filter((l) => l.provider?.name === nameOfId.get(a.package_id)).map((l) => l.soname),
    advisory: { id: a.id, tracker: a.tracker, cves: a.cves, severity: a.severity, fixed: a.fixed, summary: a.summary, url: a.url, match: a.match, kev: a.kev, epss: a.epss },
  }));

  return json(
    {
      name: chosen.name,
      arch: s.arch,
      shown_ring: pick.ring,
      security: {
        advisories: own.map((a) => ({ id: a.id, tracker: a.tracker, cves: a.cves, severity: a.severity, status: a.object_status, match: a.match, fixed: a.fixed, summary: a.summary, url: a.url, kev: a.kev, epss: a.epss })),
        exposed,
      },
      rings: inRings,
      package: { version: chosen.version, arch: chosen.arch, source: chosen.source, filename: chosen.filename, sha256: chosen.sha256, size_download: chosen.size_download, size_installed: chosen.size_installed, has_signature: chosen.has_signature === 1, created_at: chosen.created_at },
      manifest,
      depends,
      links,
      required_by: [...requiredBy.values()],
      pool_url: `${env.POOL_URL.replace(/\/$/, "")}/${s.arch}/${chosen.filename}`,
    },
    200,
    { "cache-control": "public, max-age=60" },
  );
}

export async function handlePackageFiles(name: string, url: URL, env: Env): Promise<Response> {
  const s = scope(url, env);
  if (s instanceof Response) return s;
  const head = await ringHead(env, s.ring);
  if (!head) return json({ error: `ring ${s.ring} has no release yet` }, 404);
  const row = await env.DB.prepare(
    `SELECT p.id, p.manifest_json FROM release_packages rp JOIN packages p ON p.id = rp.package_id
      WHERE rp.release_id = ?1 AND p.name = ?2 AND p.repo_arch = ?3`,
  )
    .bind(head.id, name, s.arch)
    .first<{ id: number; manifest_json: string }>();
  if (!row) return json({ error: `${name} is not in ${s.ring} for ${s.arch}` }, 404);
  const gz = await env.DB.prepare("SELECT gz FROM package_file_lists WHERE package_id = ?").bind(row.id).first<{ gz: ArrayBuffer | number[] }>();
  const files = gz ? await gunzipJson<string[]>(gz.gz) : ((JSON.parse(row.manifest_json) as { files?: string[] }).files ?? []);
  return json({ name, ring: s.ring, arch: s.arch, files }, 200, { "cache-control": "public, max-age=300" });
}
