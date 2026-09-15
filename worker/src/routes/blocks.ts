import { json, type Env } from "../index";
import { isMaintainer, type Contributor } from "./contributors";
import { handleCreateRelease } from "./releases";
import { createJob } from "../scheduler";
import { putRecord, recordKey, recordUrl } from "../record";
import { REPO_ARCHES } from "../r2";

/**
 * Blocking — the maintainers' brake (docs/GOVERNANCE.md, *Blocking*).
 *
 *   POST /factory/contributors/:login/block   {reason}  a maintainer, not the login itself: no more requests or builds;
 *                                                       their workers revoked, their queued and staged builds cancelled,
 *                                                       their packages rejected. The record: contributors/<login>/block-<t>.json
 *   POST /factory/contributors/:login/unblock {reason}  another maintainer than the one who blocked
 *   POST /factory/packages/:name/block        {reason}  any maintainer: the package leaves every ring (a release per ring,
 *                                                       edge re-rendered), its builds cancelled, its bumps stopped, its
 *                                                       project refused to new requests. The record: factory/<name>/<request>/decision-<t>.json
 *   POST /factory/packages/:name/unblock      {reason}  another maintainer than the one who blocked (a new request or build follows)
 *   GET  /factory/blocks                                what is blocked, and by whom (public)
 */

function need(c: Contributor): Response | null {
  return isMaintainer(c) ? null : json({ error: "a maintainer is required" }, 403);
}

const stamp = (): string => new Date().toISOString().replace(/[-:.Z]/g, "");

export async function handleBlockContributor(c: Contributor, login: string, request: Request, env: Env): Promise<Response> {
  const denied = need(c);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { reason?: string };
  if (!b.reason || b.reason.trim().length < 4) return json({ error: "a reason is required; it is on the record" }, 400);
  if (login === c.login) return json({ error: "nobody blocks themselves" }, 400);
  const who = await env.DB.prepare("SELECT login, role, blocked_at FROM contributors WHERE login = ?").bind(login).first<{ login: string; role: string; blocked_at: string | null }>();
  if (!who) return json({ error: `${login} has never signed in` }, 404);
  if (who.role === "maintainer") return json({ error: `${login} is a maintainer: that is a governance pull request (factory/MAINTAINERS.toml), not a block` }, 409);
  if (who.blocked_at) return json({ error: `${login} is already blocked (since ${who.blocked_at})` }, 409);
  const at = new Date().toISOString();
  const packages = (await env.DB.prepare("SELECT name FROM factory_packages WHERE owner = ?").bind(login).all<{ name: string }>()).results.map((r) => r.name);
  const workers = (await env.DB.prepare("SELECT id FROM build_workers WHERE owner = ? AND revoked_at IS NULL").bind(login).all<{ id: string }>()).results.map((r) => r.id);
  await env.DB.batch([
    env.DB.prepare("UPDATE contributors SET blocked_at = ?, blocked_by = ?, blocked_reason = ? WHERE login = ?").bind(at, c.login, b.reason, login),
    env.DB.prepare("UPDATE build_workers SET revoked_at = ? WHERE owner = ? AND revoked_at IS NULL").bind(at, login),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE owner = ? AND trust = 'community' AND status IN ('queued', 'leased', 'staged')").bind(`${login} was blocked by ${c.login}: ${b.reason.slice(0, 200)}`, login),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build it audited was cancelled: its owner was blocked' WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.owner') = ?").bind(login),
    env.DB.prepare("UPDATE factory_packages SET status = 'rejected', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE owner = ?").bind(`owner blocked by ${c.login}: ${b.reason.slice(0, 200)}`, login),
  ]);
  const key = `contributors/${login}/block-${stamp()}.json`;
  const record = await putRecord(env, key, { schema: "omarchy-pool/block/1", kind: "contributor", login, by: c.login, at, reason: b.reason, packages, workers_revoked: workers });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('block', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${login} blocked by ${c.login}: ${b.reason.slice(0, 140)} — ${packages.length} package(s) rejected, ${workers.length} worker(s) revoked`, JSON.stringify({ login, by: c.login, reason: b.reason, packages, workers, record: recordUrl(env, record.key) }))
    .run();
  return json({ blocked: login, by: c.login, at, packages, workers_revoked: workers, record: recordUrl(env, record.key) });
}

export async function handleUnblockContributor(c: Contributor, login: string, request: Request, env: Env): Promise<Response> {
  const denied = need(c);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { reason?: string };
  if (!b.reason || b.reason.trim().length < 4) return json({ error: "a reason is required; it is on the record" }, 400);
  const who = await env.DB.prepare("SELECT blocked_at, blocked_by FROM contributors WHERE login = ?").bind(login).first<{ blocked_at: string | null; blocked_by: string | null }>();
  if (!who?.blocked_at) return json({ error: `${login} is not blocked` }, 409);
  if (who.blocked_by === c.login) return json({ error: `${c.login} blocked ${login}; another maintainer lifts it` }, 403);
  const at = new Date().toISOString();
  await env.DB.prepare("UPDATE contributors SET blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL WHERE login = ?").bind(login).run();
  const record = await putRecord(env, `contributors/${login}/unblock-${stamp()}.json`, { schema: "omarchy-pool/block/1", kind: "contributor", login, by: c.login, at, reason: b.reason, lifted: { blocked_at: who.blocked_at, blocked_by: who.blocked_by } });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('block', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${login} unblocked by ${c.login}: ${b.reason.slice(0, 140)} (blocked by ${who.blocked_by} since ${who.blocked_at}); workers and packages need registering again`, JSON.stringify({ login, by: c.login, reason: b.reason, record: recordUrl(env, record.key) }))
    .run();
  return json({ unblocked: login, by: c.login, at, record: recordUrl(env, record.key) });
}

/**
 * The package leaves every ring: one release per ring that serves it,
 * removing the name from source factory, then a render job per
 * architecture so pacman sees it gone. Nothing of the object is deleted —
 * the record and GC's retention keep the history — it is simply no longer
 * served.
 */
async function pullFromRings(env: Env, name: string, note: string): Promise<{ ring: string; release: number | null }[]> {
  const rings = (await env.DB.prepare("SELECT DISTINCT rp.ring FROM ring_packages rp JOIN packages p ON p.id = rp.package_id WHERE p.name = ? AND p.source = 'factory'").bind(name).all<{ ring: string }>()).results.map((r) => r.ring);
  const out: { ring: string; release: number | null }[] = [];
  for (const ring of rings) {
    const res = await handleCreateRelease(new Request("http://brain/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ring, remove_from: [{ source: "factory", name }], note }) }), env);
    const body = (await res.json().catch(() => ({}))) as { release?: { id: number } };
    out.push({ ring, release: res.ok ? (body.release?.id ?? null) : null });
    if (res.ok) for (const arch of REPO_ARCHES) await createJob(env, { kind: "render", params: { ring, arch }, arch }, `block: ${name} left ${ring}`);
  }
  return out;
}

export async function handleBlockPackage(c: Contributor, name: string, request: Request, env: Env): Promise<Response> {
  const denied = need(c);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { reason?: string };
  if (!b.reason || b.reason.trim().length < 4) return json({ error: "a reason is required; it is on the record" }, 400);
  const pkg = await env.DB.prepare("SELECT name, owner, request_id, blocked_at FROM factory_packages WHERE name = ?").bind(name).first<{ name: string; owner: string; request_id: number | null; blocked_at: string | null }>();
  if (!pkg) return json({ error: `${name} was never requested` }, 404);
  if (pkg.blocked_at) return json({ error: `${name} is already blocked (since ${pkg.blocked_at})` }, 409);
  const at = new Date().toISOString();
  const note = `blocked by ${c.login}: ${b.reason.slice(0, 200)}`;
  const rings = await pullFromRings(env, name, note);
  await env.DB.batch([
    env.DB.prepare("UPDATE factory_packages SET status = 'rejected', blocked_at = ?, blocked_by = ?, blocked_reason = ?, detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(at, c.login, b.reason, note, name),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE name = ? AND kind IN ('build', 'publish') AND status IN ('queued', 'leased', 'staged')").bind(note, name),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build it audited was blocked' WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.name') = ?").bind(name),
  ]);
  const key = pkg.request_id ? recordKey(name, pkg.request_id, `decision-${stamp()}.json`) : `factory/${name}/0/decision-${stamp()}.json`;
  const record = await putRecord(env, key, { schema: "omarchy-pool/decision/1", decision: "block", name, owner: pkg.owner, by: c.login, at, reason: b.reason, rings });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('block', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${name} blocked by ${c.login}: ${b.reason.slice(0, 140)}${rings.length ? " — pulled from " + rings.map((r) => r.ring).join(", ") : ""}`, JSON.stringify({ name, owner: pkg.owner, by: c.login, reason: b.reason, rings, record: recordUrl(env, record.key) }))
    .run();
  return json({ blocked: name, by: c.login, at, rings, record: recordUrl(env, record.key) });
}

export async function handleUnblockPackage(c: Contributor, name: string, request: Request, env: Env): Promise<Response> {
  const denied = need(c);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { reason?: string };
  if (!b.reason || b.reason.trim().length < 4) return json({ error: "a reason is required; it is on the record" }, 400);
  const pkg = await env.DB.prepare("SELECT owner, request_id, blocked_at, blocked_by FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string; request_id: number | null; blocked_at: string | null; blocked_by: string | null }>();
  if (!pkg?.blocked_at) return json({ error: `${name} is not blocked` }, 409);
  if (pkg.blocked_by === c.login) return json({ error: `${c.login} blocked ${name}; another maintainer lifts it` }, 403);
  const at = new Date().toISOString();
  await env.DB.prepare("UPDATE factory_packages SET blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL, detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`block lifted by ${c.login}: ${b.reason.slice(0, 200)}; a new build starts it over`, name).run();
  const key = pkg.request_id ? recordKey(name, pkg.request_id, `decision-${stamp()}.json`) : `factory/${name}/0/decision-${stamp()}.json`;
  const record = await putRecord(env, key, { schema: "omarchy-pool/decision/1", decision: "unblock", name, owner: pkg.owner, by: c.login, at, reason: b.reason, lifted: { blocked_at: pkg.blocked_at, blocked_by: pkg.blocked_by } });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('block', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${name} unblocked by ${c.login}: ${b.reason.slice(0, 140)} (blocked by ${pkg.blocked_by} since ${pkg.blocked_at})`, JSON.stringify({ name, by: c.login, reason: b.reason, record: recordUrl(env, record.key) }))
    .run();
  return json({ unblocked: name, by: c.login, at, record: recordUrl(env, record.key) });
}

export async function handleBlocks(env: Env): Promise<Response> {
  const [contributors, packages] = await Promise.all([
    env.DB.prepare("SELECT login, blocked_at, blocked_by, blocked_reason FROM contributors WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC").all(),
    env.DB.prepare("SELECT name, owner, blocked_at, blocked_by, blocked_reason FROM factory_packages WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC").all(),
  ]);
  return json({ contributors: contributors.results, packages: packages.results }, 200, { "cache-control": "no-store" });
}
