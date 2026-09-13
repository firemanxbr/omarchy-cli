import { json, type Env } from "../index";
import { groupsOf, roleFor, GOVERNANCE_FILE } from "../governance";
import { isRepoArch } from "../r2";
import { providedBy } from "./factory";
import { cookieOf } from "./auth";

/**
 * Contributors: anyone with a GitHub identity. No permission needed to
 * register a package or run a worker for it; the project pays for nothing
 * until a maintainer approves a build.
 *
 *   POST /factory/register            {github_token}            → {login, token}   the contributor token (shown once)
 *   GET  /factory/me                  (contributor token)       → who am I, my packages, my workers
 *   POST /factory/packages            {name?, url, group?, arches?, release?, pkgbuild_path?}
 *   POST /factory/packages/:name/build {arches?, reason?}       → community tasks (results go to staging)
 *   DELETE /factory/packages/:name
 *   POST /factory/workers             {name, arch, mode: shared|dedicated, packages?, labels?} → {worker, token}
 *   DELETE /factory/workers/:id       revoke
 *   GET  /factory/packages            the registry (public)
 *
 * The GitHub token is used once, to ask api.github.com who it belongs to,
 * and never stored; a fine-grained token with no permissions is enough.
 */

const STAGING_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // per contributor
const QUEUED_QUOTA = 10; // tasks queued or building per contributor

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(prefix: string): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function bearer(request: Request): string {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export interface Contributor {
  login: string;
  name: string | null;
  avatar_url: string | null;
  role: string;
  areas: string[];
}

/**
 * The contributor behind the request — a `omc_…` bearer token (the CLI /
 * worker credential) or the sign-in cookie (a browser session, `oms_…`,
 * separate so signing in never invalidates a running worker) — or null.
 */
export async function contributorOf(request: Request, env: Env): Promise<Contributor | null> {
  const token = bearer(request);
  const session = token ? "" : (cookieOf(request, "omc") ?? "");
  let row: { login: string; name: string | null; avatar_url: string | null; role: string; areas: string | null } | null = null;
  if (token.startsWith("omc_")) {
    row = await env.DB.prepare("SELECT login, name, avatar_url, role, areas FROM contributors WHERE token_hash = ?").bind(await sha256Hex(token)).first();
  } else if (session.startsWith("oms_")) {
    row = await env.DB.prepare("SELECT login, name, avatar_url, role, areas FROM contributors WHERE session_hash = ?").bind(await sha256Hex(session)).first();
  }
  if (!row) return null;
  await env.DB.prepare("UPDATE contributors SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE login = ?").bind(row.login).run();
  return { ...row, areas: row.areas ? JSON.parse(row.areas) : [] };
}

export interface WorkerIdentity {
  id: string;
  owner: string | null;
  mode: string;
  packages: string[];
  arch: string;
  /** community: its own or shared builds · project: everything, approved by a maintainer. */
  trust: string;
}

/** The registered worker behind a `omw_…` token (not revoked), or null. */
export async function workerOf(request: Request, env: Env): Promise<WorkerIdentity | null> {
  const token = bearer(request);
  if (!token.startsWith("omw_")) return null;
  const row = await env.DB.prepare("SELECT id, owner, mode, packages, arch, trust FROM build_workers WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(token))
    .first<{ id: string; owner: string | null; mode: string; packages: string | null; arch: string; trust: string }>();
  return row ? { ...row, packages: row.packages ? JSON.parse(row.packages) : [] } : null;
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { github_token?: string };
  if (!b.github_token) return json({ error: "github_token is required (used once, to read your login; a fine-grained token with no permissions is enough)" }, 400);
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${b.github_token}`, accept: "application/vnd.github+json", "user-agent": "omarchy-pool-factory" },
  });
  if (!res.ok) return json({ error: `GitHub did not accept that token (HTTP ${res.status})` }, 401);
  const u = (await res.json()) as { login: string; name?: string; avatar_url?: string; type?: string };
  if (!u.login || u.type === "Bot") return json({ error: "a user account is required" }, 400);
  const token = newToken("omc");
  const { role, areas } = await roleFor(env, u.login);
  await env.DB.prepare(
    `INSERT INTO contributors (login, name, avatar_url, token_hash, role, areas) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (login) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url, token_hash = excluded.token_hash,
       role = excluded.role, areas = excluded.areas, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(u.login, u.name ?? null, u.avatar_url ?? null, await sha256Hex(token), role, JSON.stringify(areas))
    .run();
  return json({ login: u.login, role, areas, token, note: "Keep this token; registering again replaces it. Use it as `Authorization: Bearer …` for /factory/packages and /factory/workers." }, 201);
}

/** A signed-in contributor mints (or replaces) the CLI / worker token; the browser session stays. */
export async function handleNewToken(c: Contributor, env: Env): Promise<Response> {
  const token = newToken("omc");
  await env.DB.prepare("UPDATE contributors SET token_hash = ? WHERE login = ?").bind(await sha256Hex(token), c.login).run();
  return json({ login: c.login, token, note: "Shown once; it replaces any earlier token. Use it as `Authorization: Bearer …` on the command line and for workers." }, 201);
}

export async function handleMe(c: Contributor, env: Env): Promise<Response> {
  const packages = await env.DB.prepare("SELECT * FROM factory_packages WHERE owner = ? ORDER BY name").bind(c.login).all();
  const workers = await env.DB.prepare("SELECT id, arch, mode, packages, labels, last_seen, current_task, builds_done, builds_failed, revoked_at FROM build_workers WHERE owner = ? ORDER BY last_seen DESC").bind(c.login).all();
  const tasks = await env.DB.prepare("SELECT id, name, arch, version, status, attempts, lease_owner, duration_ms, error, staged_prefix, created_at FROM build_tasks WHERE owner = ? ORDER BY id DESC LIMIT 50").bind(c.login).all();
  const staged = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM staging_objects WHERE owner = ?").bind(c.login).first<{ bytes: number }>();
  return json({ contributor: c, packages: packages.results, workers: workers.results.map((w) => ({ ...w, packages: w.packages ? JSON.parse(w.packages as string) : null, labels: w.labels ? JSON.parse(w.labels as string) : null })), tasks: tasks.results, staging: { bytes: staged?.bytes ?? 0, quota_bytes: STAGING_QUOTA_BYTES } });
}

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** What the drafter needs to know, from the GitHub API: build system, license, latest release. */
async function detect(url: string, env: Env): Promise<Record<string, unknown>> {
  const m = url.match(GITHUB_URL);
  if (!m) return { error: "not a GitHub repository URL" };
  const [, owner, repo] = m;
  const h: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "omarchy-pool-factory" };
  // The scheduler's token raises the rate limit; public data either way.
  if (env.GITHUB_TOKEN) h.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const gh = async (path: string): Promise<Record<string, unknown> | null> => {
    const res = await fetch(`https://api.github.com${path}`, { headers: h });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  try {
    const meta = await gh(`/repos/${owner}/${repo}`);
    if (!meta) return { error: `${owner}/${repo} not found on GitHub` };
    const rel = (await gh(`/repos/${owner}/${repo}/releases/latest`)) as { tag_name?: string; assets?: { name: string }[] } | null;
    let tag = rel?.tag_name ?? null;
    if (!tag) {
      const tags = (await gh(`/repos/${owner}/${repo}/tags?per_page=1`)) as unknown as { name: string }[] | null;
      tag = tags?.[0]?.name ?? null;
    }
    const ref = tag ?? (meta.default_branch as string);
    const tree = (await gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`)) as { tree?: { path: string; type: string }[] } | null;
    const top = new Set((tree?.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path));
    const assets = rel?.assets ?? [];
    const system = top.has("Cargo.toml") ? "rust" : top.has("go.mod") ? "go" : top.has("meson.build") ? "meson" : top.has("CMakeLists.txt") ? "cmake" : top.has("configure.ac") ? "autotools" : top.has("pyproject.toml") || top.has("setup.py") ? "python" : top.has("package.json") ? "node" : top.has("Makefile") ? "make" : assets.some((a) => /linux/i.test(a.name)) ? "binary" : "unknown";
    return {
      full_name: meta.full_name, description: meta.description ?? null, language: meta.language ?? null,
      license: (meta.license as { spdx_id?: string } | null)?.spdx_id ?? null, latest_tag: tag,
      release_assets: assets.map((a) => a.name), build_system: system, has_pkgbuild: top.has("PKGBUILD"),
      default_branch: meta.default_branch, stars: meta.stargazers_count ?? 0, archived: meta.archived ?? false,
    };
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e) };
  }
}

export async function handleRegisterPackage(c: Contributor, request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { name?: string; url?: string; group?: string; arches?: unknown; release?: string; pkgbuild_path?: string };
  if (!b.url || !GITHUB_URL.test(b.url)) return json({ error: "url must be a GitHub repository (https://github.com/owner/project)" }, 400);
  const url = b.url.replace(/\.git$/, "").replace(/\/$/, "");
  const name = (b.name ?? url.split("/").pop() ?? "").toLowerCase();
  if (!/^[a-z0-9@._+-]+$/.test(name)) return json({ error: "name must be a pacman package name" }, 400);
  const arches = (Array.isArray(b.arches) ? b.arches : ["x86_64", "aarch64"]).filter((a): a is string => typeof a === "string" && isRepoArch(a));
  if (!arches.length) return json({ error: "arches must include x86_64 and/or aarch64" }, 400);
  const existing = await env.DB.prepare("SELECT owner FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string }>();
  if (existing && existing.owner !== c.login) return json({ error: `${name} is registered by ${existing.owner}` }, 409);
  const upstream = (await providedBy(env, name)).filter((p) => !["factory", "chaotic"].includes(p.source) && arches.includes(p.arch));
  if (upstream.length === arches.length) {
    return json({ error: `${upstream[0].source} already ships ${name} (${upstream.map((u) => `${u.version} for ${u.arch}`).join(", ")}); install it from the pool`, provided: upstream }, 409);
  }
  const build = arches.filter((a) => !upstream.some((u) => u.arch === a));
  const detected = await detect(url, env);
  if (detected.error) return json({ error: String(detected.error) }, 400);
  // The group decides who reviews: one of factory/MAINTAINERS.toml's.
  const groups = (await groupsOf(env)).map((g) => g.name);
  const group = b.group && groups.includes(b.group) ? b.group : groups.includes("community") ? "community" : (groups[0] ?? "community");
  const row = await env.DB.prepare(
    `INSERT INTO factory_packages (name, owner, url, "group", arches, release, pkgbuild_path, detected) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET url = excluded.url, "group" = excluded."group", arches = excluded.arches, release = excluded.release,
       pkgbuild_path = excluded.pkgbuild_path, detected = excluded.detected, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') RETURNING *`,
  )
    .bind(name, c.login, url, group, JSON.stringify(build), b.release ?? null, b.pkgbuild_path ?? (detected.has_pkgbuild ? "PKGBUILD" : null), JSON.stringify(detected))
    .first();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('request', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${name} registered by ${c.login} from ${url} (${String(detected.build_system)}, ${build.join(", ")})`, JSON.stringify({ name, owner: c.login, url, arches: build, skipped: upstream }))
    .run();
  return json({ package: row, skipped: upstream, next: `POST /api/v1/factory/packages/${name}/build queues it; a worker of yours (or a shared one) builds it into your staging workspace.` }, existing ? 200 : 201);
}

/** The owner frees the name (unless approved); a maintainer of its group frees any, an unmaintained one included. */
export async function handleDeletePackage(c: Contributor, name: string, env: Env): Promise<Response> {
  const pkg = await env.DB.prepare("SELECT owner, \"group\", status FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string; group: string; status: string }>();
  if (!pkg) return json({ error: "not registered" }, 404);
  const mine = pkg.owner === c.login && pkg.status !== "approved";
  if (!mine && !maintains(c, pkg.group)) return json({ error: "not yours, or already approved (a maintainer of the group can remove it)" }, 403);
  await env.DB.batch([
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE name = ? AND trust = 'community' AND status = 'queued'").bind(`registration removed by ${c.login}`, name),
    env.DB.prepare("DELETE FROM factory_packages WHERE name = ?").bind(name),
  ]);
  return json({ deleted: name, by: c.login });
}

/** Queue community builds of a registered package: results go to staging, never to the pool. */
export async function handleBuildPackage(c: Contributor, name: string, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { arches?: unknown; reason?: string; release?: string };
  const pkg = await env.DB.prepare("SELECT * FROM factory_packages WHERE name = ? AND owner = ?").bind(name, c.login).first<{ name: string; group: string; arches: string; url: string; release: string | null; pkgbuild_path: string | null; detected: string | null }>();
  if (!pkg) return json({ error: "register the package first (POST /factory/packages)" }, 404);
  const queued = await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE owner = ? AND status IN ('queued', 'leased')").bind(c.login).first<{ n: number }>();
  if ((queued?.n ?? 0) >= QUEUED_QUOTA) return json({ error: `you have ${queued?.n} tasks queued or building; the limit is ${QUEUED_QUOTA}` }, 429);
  const wanted = (Array.isArray(b.arches) ? b.arches : JSON.parse(pkg.arches)) as string[];
  const arches = wanted.filter((a) => isRepoArch(a) && (JSON.parse(pkg.arches) as string[]).includes(a));
  const detected = pkg.detected ? (JSON.parse(pkg.detected) as { latest_tag?: string }) : {};
  const tag = b.release ?? pkg.release ?? detected.latest_tag ?? null;
  const ref = pkg.pkgbuild_path ? `${pkg.url}@${tag ?? "HEAD"}:${pkg.pkgbuild_path}` : `draft:${pkg.url}@${tag ?? "latest"}`;
  const version = tag ? tag.replace(/^v/, "").replace(/-/g, "_") : null;
  const ids: number[] = [];
  for (const arch of arches) {
    const dup = await env.DB.prepare("SELECT id FROM build_tasks WHERE name = ? AND arch = ? AND pkgbuild_ref = ? AND status IN ('queued', 'leased') LIMIT 1").bind(name, arch, ref).first<{ id: number }>();
    if (dup) { ids.push(dup.id); continue; }
    const row = await env.DB.prepare(
      `INSERT INTO build_tasks (name, "group", arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, shared_after) VALUES (?, ?, ?, ?, ?, ?, 100, 0, 'community', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+14 days')) RETURNING id`,
    )
      .bind(name, pkg.group, arch, version, ref, b.reason ?? "contributor", c.login)
      .first<{ id: number }>();
    if (row) ids.push(row.id);
  }
  await env.DB.prepare("UPDATE factory_packages SET status = 'waiting', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`waiting for a worker (${arches.join(", ")})`, name).run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('enqueue', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${name}${version ? " " + version : ""}: ${ids.length} community build(s) queued by ${c.login} for ${arches.join(", ")} — results go to staging`, JSON.stringify({ name, owner: c.login, arches, tasks: ids, pkgbuild_ref: ref }))
    .run();
  return json({ tasks: ids, arches, pkgbuild_ref: ref, note: "A worker of yours claims these (dedicated: your packages only; shared: anyone's). Start one with the Omarchy Packaging image (factory/README.md)." }, 201);
}

export async function handleRegisterWorker(c: Contributor, request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { name?: string; arch?: string; labels?: unknown };
  if (!b.arch || !isRepoArch(b.arch)) return json({ error: "arch (x86_64|aarch64) is required" }, 400);
  // A worker builds its owner's packages. Donating it to anyone's is decided
  // where it runs (--shared / WORKER_SHARED=1), never here, so a registration
  // cannot quietly turn a laptop into everybody's build machine.
  const id = `${c.login}-${(b.name ?? b.arch).replace(/[^a-zA-Z0-9_.-]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  const token = newToken("omw");
  await env.DB.prepare(
    `INSERT INTO build_workers (id, arch, hostname, labels, owner, token_hash, mode, packages, last_seen) VALUES (?, ?, NULL, ?, ?, ?, 'dedicated', '[]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  )
    .bind(id, b.arch, b.labels ? JSON.stringify(b.labels) : null, c.login, await sha256Hex(token))
    .run();
  return json({ worker: id, token, arch: b.arch, note: "Run the Omarchy Packaging image with WORKER_ID and OMARCHY_WORKER_TOKEN set to these; the token is shown once. It builds your packages; start it with WORKER_SHARED=1 to build anyone's." }, 201);
}

export async function handleRevokeWorker(c: Contributor, id: string, env: Env): Promise<Response> {
  // Its owner, or a maintainer (any worker): a revoked worker cannot claim again.
  const res = isMaintainer(c)
    ? await env.DB.prepare("UPDATE build_workers SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND revoked_at IS NULL").bind(id).run()
    : await env.DB.prepare("UPDATE build_workers SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND owner = ? AND revoked_at IS NULL").bind(id, c.login).run();
  if (res.meta.changes) {
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('trust', NULL, 'factory', 'warn', ?, ?)")
      .bind(`worker ${id} revoked by ${c.login}`, JSON.stringify({ worker: id, by: c.login }))
      .run();
  }
  return res.meta.changes ? json({ revoked: id }) : json({ error: "not yours (or not a maintainer), or already revoked" }, 404);
}

export async function handleListPackages(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM build_tasks t WHERE t.name = p.name AND t.status = 'staged') AS staged_builds
       FROM factory_packages p ORDER BY updated_at DESC LIMIT 200`,
  ).all();
  return json({ packages: rows.results.map((r) => ({ ...r, arches: JSON.parse(r.arches as string), detected: r.detected ? JSON.parse(r.detected as string) : null })) }, 200, { "cache-control": "public, max-age=30" });
}

// ---------- staging uploads (worker token, own task only) ----------

const SINGLE_PUT_MAX = 90 * 1024 * 1024;

export function stagingKey(owner: string, name: string, task: number, filename: string): string {
  return `staging/${owner}/${name}/${task}/${filename}`;
}

/**
 * PUT /factory/tasks/:id/artifacts/:filename — the worker uploads the
 * package(s), PKGBUILD, build.log and manifest.json of a community task it
 * holds. Scope is the task: the key is derived, never given. Up to 90 MB in
 * one request; larger archives use the multipart routes below.
 */
export async function handleStagingPut(taskId: number, filename: string, request: Request, env: Env, w: WorkerIdentity): Promise<Response> {
  const task = await env.DB.prepare("SELECT id, name, owner, status, lease_owner, trust FROM build_tasks WHERE id = ?").bind(taskId).first<{ id: number; name: string; owner: string; status: string; lease_owner: string; trust: string }>();
  if (!task) return json({ error: "no such task" }, 404);
  if (task.trust !== "community") return json({ error: "project tasks publish to the pool, not to staging" }, 400);
  if (task.status !== "leased" || task.lease_owner !== w.id) return json({ error: "the lease is not yours" }, 409);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,200}$/.test(filename)) return json({ error: "bad filename" }, 400);
  const used = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM staging_objects WHERE owner = ?").bind(task.owner).first<{ bytes: number }>();
  const len = Number(request.headers.get("content-length") ?? 0);
  if ((used?.bytes ?? 0) + len > STAGING_QUOTA_BYTES) return json({ error: `staging quota of ${STAGING_QUOTA_BYTES} bytes reached for ${task.owner}; older builds expire after 30 days` }, 413);
  if (len > SINGLE_PUT_MAX) return json({ error: "above 90 MB use /multipart" }, 413);
  if (!request.body) return json({ error: "empty body" }, 400);
  const key = stagingKey(task.owner, task.name, task.id, filename);
  const obj = await env.STAGING.put(key, request.body, { httpMetadata: { contentType: filename.endsWith(".log") || filename === "PKGBUILD" ? "text/plain; charset=utf-8" : "application/octet-stream" } });
  await env.DB.prepare("INSERT OR REPLACE INTO staging_objects (key, owner, task_id, size) VALUES (?, ?, ?, ?)").bind(key, task.owner, task.id, obj?.size ?? len).run();
  return json({ key, size: obj?.size ?? len }, 201);
}

export async function handleStagingMultipart(taskId: number, filename: string, url: URL, request: Request, env: Env, w: WorkerIdentity): Promise<Response> {
  const task = await env.DB.prepare("SELECT id, name, owner, status, lease_owner, trust FROM build_tasks WHERE id = ?").bind(taskId).first<{ id: number; name: string; owner: string; status: string; lease_owner: string; trust: string }>();
  if (!task || task.trust !== "community") return json({ error: "no such community task" }, 404);
  if (task.status !== "leased" || task.lease_owner !== w.id) return json({ error: "the lease is not yours" }, 409);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,200}$/.test(filename)) return json({ error: "bad filename" }, 400);
  const key = stagingKey(task.owner, task.name, task.id, filename);
  const action = url.searchParams.get("action");
  if (action === "create") {
    const mp = await env.STAGING.createMultipartUpload(key);
    return json({ upload_id: mp.uploadId, key }, 201);
  }
  const uploadId = url.searchParams.get("upload_id");
  if (!uploadId) return json({ error: "upload_id is required" }, 400);
  const mp = env.STAGING.resumeMultipartUpload(key, uploadId);
  if (action === "part") {
    const n = Number(url.searchParams.get("part"));
    if (!n || !request.body) return json({ error: "part number and body are required" }, 400);
    const part = await mp.uploadPart(n, request.body);
    return json({ part: part.partNumber, etag: part.etag });
  }
  if (action === "complete") {
    const b = (await request.json()) as { parts: { partNumber: number; etag: string }[] };
    const obj = await mp.complete(b.parts);
    await env.DB.prepare("INSERT OR REPLACE INTO staging_objects (key, owner, task_id, size) VALUES (?, ?, ?, ?)").bind(key, task.owner, task.id, obj.size).run();
    return json({ key, size: obj.size }, 201);
  }
  if (action === "abort") {
    await mp.abort();
    return json({ aborted: key });
  }
  return json({ error: "action must be create, part, complete or abort" }, 400);
}

/** What a task has in staging (public: logs and PKGBUILDs are the evidence; packages are listed, not served). */
export async function handleStagingList(taskId: number, env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT key, size, uploaded_at FROM staging_objects WHERE task_id = ? ORDER BY key").bind(taskId).all();
  return json({ task: taskId, objects: rows.results });
}

/** Text evidence of a community build: build.log and PKGBUILD are public; packages are for maintainers. */
export async function handleStagingGet(taskId: number, filename: string, env: Env, maintainer: boolean): Promise<Response> {
  const row = await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? AND key LIKE ?").bind(taskId, `%/${filename}`).first<{ key: string }>();
  if (!row) return json({ error: "no such object" }, 404);
  const isText = filename.endsWith(".log") || filename === "PKGBUILD" || filename.endsWith(".json");
  if (!isText && !maintainer) return json({ error: "packages in staging are for maintainers; the log and the PKGBUILD are public" }, 403);
  const obj = await env.STAGING.get(row.key);
  if (!obj) return json({ error: "gone (staging objects expire after 30 days)" }, 404);
  return new Response(obj.body, { headers: { "content-type": isText ? "text/plain; charset=utf-8" : "application/octet-stream", "cache-control": "no-store" } });
}

// ---------- maintainers ----------

/** Maintainers are named by factory/MAINTAINERS.toml (governance.ts); there is no other role above contributor. */
export function isMaintainer(c: Contributor): boolean {
  return c.role === "maintainer";
}

/** May this contributor act for a group — approve its builds, review its packages? */
export function maintains(c: Contributor, group: string): boolean {
  return isMaintainer(c) && c.areas.includes(group);
}

/** A maintainer promotes a worker to project trust (or back): a recorded action, revocable. */
export async function handleTrustWorker(c: Contributor, id: string, request: Request, env: Env): Promise<Response> {
  if (!isMaintainer(c)) return json({ error: "a maintainer's token is required" }, 403);
  const b = (await request.json()) as { trust?: string };
  const trust = b.trust === "project" ? "project" : "community";
  const res = await env.DB.prepare("UPDATE build_workers SET trust = ?, trusted_by = ?, trusted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND revoked_at IS NULL")
    .bind(trust, c.login, id)
    .run();
  if (!res.meta.changes) return json({ error: "no such worker (or revoked)" }, 404);
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('trust', NULL, 'factory', 'ok', ?, ?)")
    .bind(`worker ${id} set to ${trust} trust by ${c.login}`, JSON.stringify({ worker: id, trust, by: c.login }))
    .run();
  return json({ worker: id, trust, by: c.login });
}

/** Workers the project trusts and the people who may approve: the dashboard's trust page. */
export async function handleTrustList(env: Env): Promise<Response> {
  const workers = await env.DB.prepare("SELECT id, owner, arch, mode, trust, trusted_by, trusted_at, last_seen, revoked_at FROM build_workers WHERE trust = 'project' OR owner IS NULL ORDER BY trust DESC, last_seen DESC LIMIT 100").all();
  const people = await env.DB.prepare("SELECT login, name, role, areas, last_seen FROM contributors WHERE role = 'maintainer' ORDER BY login").all();
  return json({ workers: workers.results, maintainers: people.results.map((p) => ({ ...p, areas: p.areas ? JSON.parse(p.areas as string) : [] })), groups: await groupsOf(env), source: GOVERNANCE_FILE }, 200, { "cache-control": "public, max-age=30" });
}
