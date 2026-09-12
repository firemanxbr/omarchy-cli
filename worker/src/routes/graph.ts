import { isRing, json, type Env } from "../index";
import { ringHead } from "../db";
import { REPO_ARCHES } from "../r2";

const MAX_NODES = 2000;

/**
 * Transitive dependency closure of `targets` within a ring's current release,
 * computed with a recursive CTE: requires → provides, restricted to packages in
 * the release. Requirements satisfied outside the release (e.g. glibc from the
 * Arch repos) simply do not expand; the client checks those against the local
 * pacman database.
 */
export async function handleGraph(url: URL, env: Env): Promise<Response> {
  const targets = (url.searchParams.get("targets") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ring = url.searchParams.get("ring") ?? env.DEFAULT_RING;
  // A multi-architecture release holds one row per (name, repo_arch); a client
  // only resolves within its own architecture.
  const arch = url.searchParams.get("arch");
  if (targets.length === 0) return json({ error: "targets is required" }, 400);
  if (arch !== null && !(REPO_ARCHES as readonly string[]).includes(arch)) return json({ error: "unknown arch" }, 400);
  if (!isRing(ring)) return json({ error: "unknown ring" }, 400);
  const head = await ringHead(env, ring);
  if (!head) return json({ error: `ring ${ring} has no release yet` }, 404);

  const rows = await env.DB.prepare(
    `WITH RECURSIVE
       -- MATERIALIZED: the selection is referenced from the recursive step;
       -- without the hint SQLite re-evaluates it on every iteration, which
       -- took a 29k-package ring past 30 s.
       sel(package_id) AS MATERIALIZED (SELECT rp.package_id FROM release_packages rp JOIN packages p ON p.id = rp.package_id
                            WHERE rp.release_id = ?1 AND (?4 IS NULL OR p.repo_arch = ?4)),
       -- The closure follows what pacman follows: declared dependencies
       -- (package names, or declared capabilities such as libcrypto.so=3-64)
       -- resolved through *declared* provides — never the sonames a binary
       -- loads or ships. A package bundling its own libstdc++ would otherwise
       -- count as a provider of libstdc++.so and pull half the ring in.
       closure(package_id) AS (
         SELECT p.id FROM packages p JOIN sel ON sel.package_id = p.id
          WHERE p.name IN (SELECT value FROM json_each(?2))
         UNION
         SELECT pv.package_id FROM closure c
           JOIN package_requires rq ON rq.package_id = c.package_id AND rq.kind = 'depends'
                AND rq.symbol_version IS NULL AND rq.requirement NOT GLOB '*.so.[0-9]*'
           JOIN package_provides pv ON pv.capability = rq.requirement AND pv.declared = 1
           JOIN sel ON sel.package_id = pv.package_id
       )
     SELECT p.manifest_json FROM packages p WHERE p.id IN (SELECT package_id FROM closure)
     ORDER BY p.name LIMIT ?3`,
  )
    .bind(head.id, JSON.stringify(targets), MAX_NODES + 1, arch)
    .all<{ manifest_json: string }>();

  const packages = rows.results.slice(0, MAX_NODES).map((r) => JSON.parse(r.manifest_json));
  const found = new Set(packages.map((p: { name: string }) => p.name));
  return json({
    ring,
    arch,
    release_id: head.id,
    packages,
    missing_targets: targets.filter((t) => !found.has(t)),
    truncated: rows.results.length > MAX_NODES,
  });
}
