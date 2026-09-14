import { json, type Env } from "../index";
import { isRepoArch, packageKey, signatureKey } from "../r2";
import { gzipJson } from "../gzip";

interface Rule {
  name: string;
  constraint: { op: string; version: string } | null;
  symbol_version: string | null;
}

interface Manifest {
  schema_version: number;
  name: string;
  version: string;
  arch: string;
  sha256: string;
  filename: string;
  size_download: number;
  size_installed: number;
  provides: string[];
  requires: string[];
  optional?: string[];
  conflicts?: string[];
  replaces?: string[];
  files?: string[];
  /** The `.PKGINFO` fields as written by makepkg; `provides` there is what pacman resolves through. */
  pkginfo?: { provides?: string[] };
  /** Go modules and crates.io crates the binaries embed (statically linked). */
  components?: { ecosystem: string; name: string; version: string }[];
}

const OPS = [">=", "<=", "=", ">", "<"];
export const SOURCES = ["core", "extra", "multilib", "alarm", "packages", "chaotic", "factory"] as const;

/** Parses the Arch dependency syntax the Rust side serializes rules as. */
export function parseRule(s: string): Rule {
  let symbol_version: string | null = null;
  const open = s.indexOf("(");
  if (open >= 0 && s.endsWith(")")) {
    symbol_version = s.slice(open + 1, -1);
    s = s.slice(0, open);
  }
  for (const op of OPS) {
    const i = s.indexOf(op);
    if (i > 0) return { name: s.slice(0, i), constraint: { op, version: s.slice(i + op.length) }, symbol_version };
  }
  return { name: s, constraint: null, symbol_version };
}

/**
 * Registers a manifest whose archive is already in the pool. `?source=` records
 * provenance (core / extra / multilib / alarm / packages — the last one being OPR builds). File lists are kept inside
 * manifest_json only — the normalized package_files table is not populated
 * for mirror-scale imports (it would be ~95% of all rows).
 */
export async function handlePostPackage(url: URL, request: Request, env: Env): Promise<Response> {
  const source = url.searchParams.get("source") ?? "packages";
  if (!(SOURCES as readonly string[]).includes(source)) return json({ error: `source must be one of ${SOURCES.join(", ")}` }, 400);
  const repoArch = url.searchParams.get("arch") ?? "x86_64";
  if (!isRepoArch(repoArch)) return json({ error: "arch must be x86_64 or aarch64" }, 400);
  const m = (await request.json()) as Manifest;
  if (!m?.sha256 || !m.name || !m.version || !m.arch || !m.filename) {
    return json({ error: "manifest is missing required fields" }, 400);
  }
  const dir = repoArch;
  const key = packageKey(dir, m.filename);
  const blob = await env.PACKAGES.head(key);
  if (!blob) return json({ error: "archive not in pool; upload it first" }, 409);
  if (blob.size !== m.size_download) {
    return json({ error: `pool object is ${blob.size} bytes, manifest says ${m.size_download}` }, 422);
  }
  const existing = await env.DB.prepare("SELECT id, repo_arch FROM packages WHERE sha256 = ?").bind(m.sha256).first<{ id: number; repo_arch: string }>();
  if (existing?.repo_arch === repoArch) return json({ id: existing.id, sha256: m.sha256, status: "already-indexed" });
  // One row per sha256 (0001_init.sql): the same bytes stored under both
  // architecture directories can be indexed for one of them only.
  if (existing) {
    return json({ error: `these bytes are indexed for ${existing.repo_arch}; the index holds one row per sha256`, id: existing.id, repo_arch: existing.repo_arch }, 409);
  }

  const hasSig = (await env.PACKAGES.head(signatureKey(dir, m.filename))) ? 1 : 0;
  const files = m.files ?? [];
  delete m.files;
  const inserted = await env.DB.prepare(
    `INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(m.sha256, m.name, m.version, m.arch, m.filename, m.size_download, m.size_installed, hasSig, JSON.stringify(m), source, key, repoArch)
    .first<{ id: number }>();
  const id = inserted!.id;
  const gz = await gzipJson(files);
  await env.DB.prepare("INSERT INTO package_file_lists (package_id, count, gz) VALUES (?, ?, ?)").bind(id, files.length, gz).run();

  const stmts: D1PreparedStatement[] = [];
  // Declared provides (.PKGINFO, plus the package's own name) are what pacman
  // resolves dependencies through; the rest are sonames found in the ELF files.
  const declared = new Set([m.name, ...(m.pkginfo?.provides ?? []).map((raw) => parseRule(raw).name)]);
  const prov = env.DB.prepare(
    "INSERT INTO package_provides (package_id, capability, version_constraint, symbol_version, declared) VALUES (?, ?, ?, ?, ?)",
  );
  for (const raw of m.provides ?? []) {
    const r = parseRule(raw);
    stmts.push(prov.bind(id, r.name, r.constraint ? r.constraint.op + r.constraint.version : null, r.symbol_version, declared.has(r.name) ? 1 : 0));
  }
  const req = env.DB.prepare(
    "INSERT INTO package_requires (package_id, requirement, version_constraint, symbol_version, kind) VALUES (?, ?, ?, ?, ?)",
  );
  const kinds: [string[] | undefined, string][] = [
    [m.requires, "depends"],
    [m.optional, "optdepends"],
    [m.conflicts, "conflicts"],
    [m.replaces, "replaces"],
  ];
  for (const [list, kind] of kinds) {
    for (const raw of list ?? []) {
      const r = parseRule(raw);
      stmts.push(req.bind(id, r.name, r.constraint ? r.constraint.op + r.constraint.version : null, r.symbol_version, kind));
    }
  }
  // What the binaries embed, one row per module or crate (the security
  // layer's OSV matching reads this; the manifest keeps the list too).
  const comp = env.DB.prepare("INSERT OR IGNORE INTO package_components (package_id, ecosystem, name, version) VALUES (?, ?, ?, ?)");
  for (const c of m.components ?? []) {
    if (typeof c?.ecosystem === "string" && typeof c.name === "string" && typeof c.version === "string") stmts.push(comp.bind(id, c.ecosystem, c.name, c.version));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

  return json({ id, sha256: m.sha256, status: "indexed", components: (m.components ?? []).length }, 201);
}

export async function handleGetPackage(sha256: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT manifest_json FROM packages WHERE sha256 = ?").bind(sha256).first<{ manifest_json: string }>();
  if (!row) return json({ error: "not found" }, 404);
  return new Response(row.manifest_json, { headers: { "content-type": "application/json" } });
}

/** `{ "sha256": [...], "arch": "x86_64" }` → the subset the index already knows for that repo arch. */
/**
 * Which of these sha256s are indexed for the architecture — and, for the
 * filenames given, which object already sits under `<arch>/<filename>` in
 * the pool. The layout holds one object per filename; an upstream that
 * rebuilds the same version with different bytes (the OPR does, per channel)
 * collides, and the publisher pins the object that is already there.
 */
export async function handleKnownPackages(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { sha256: string[]; filenames?: string[]; arch?: string };
  const repoArch = body.arch ?? "x86_64";
  if (!isRepoArch(repoArch)) return json({ error: "arch must be x86_64 or aarch64" }, 400);
  const list = (body.sha256 ?? []).filter((s) => /^[0-9a-f]{64}$/.test(s));
  const known: string[] = [];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const rows = await env.DB.prepare(
      "SELECT sha256 FROM packages WHERE repo_arch = ? AND sha256 IN (SELECT value FROM json_each(?))",
    )
      .bind(repoArch, JSON.stringify(chunk))
      .all<{ sha256: string }>();
    for (const r of rows.results) known.push(r.sha256);
  }
  // The pool holds one object per <arch>/<filename> and never overwrites
  // it, so of two rows behind one filename (an upstream rebuild of the same
  // version) the first indexed is the one whose bytes are stored.
  const byFilename: Record<string, string> = {};
  const names = (body.filenames ?? []).filter((f) => typeof f === "string" && f.length < 300);
  for (let i = 0; i < names.length; i += 500) {
    const chunk = names.slice(i, i + 500);
    const rows = await env.DB.prepare(
      "SELECT filename, sha256 FROM packages WHERE repo_arch = ? AND filename IN (SELECT value FROM json_each(?)) ORDER BY id",
    )
      .bind(repoArch, JSON.stringify(chunk))
      .all<{ filename: string; sha256: string }>();
    for (const r of rows.results) if (!(r.filename in byFilename)) byFilename[r.filename] = r.sha256;
  }
  return json({ known, by_filename: byFilename });
}
