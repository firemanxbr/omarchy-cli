/**
 * The seal: what the pool can say, and prove, about how an object came to
 * be. Every package has one — a synced object came from a named upstream
 * repository, its upstream signature verified against that project's
 * keyring before it entered the pool; a factory build has the whole
 * chain: the contributor's build that was the evidence, the second
 * agent's audit, the maintainer's approval, the project's rebuild on a
 * trusted worker, the pool's signature. For factory builds the chain is
 * also written next to the object as an attestation (an in-toto
 * Statement, `<filename>.provenance.json`) with the pool's detached
 * signature beside it, so anyone can check it without trusting this API.
 *
 *   GET /api/v1/packages/:sha256/provenance      the seal as JSON
 *   pool/factory/<arch>/<filename>.provenance.json(.sig) the attestation, factory builds
 */
import { json, type Env } from "../index";
import { version } from "../meta";
import { detachedSignature, publicKey, signingEnabled } from "../signing";

const REPO_URL = "https://github.com/firemanxbr/omarchy-pool";
const PREDICATE_TYPE = "https://omarchy-pool.firemanxbr.org/provenance/v1";

/** Which project's keyring the sync verified a source's packages against (crates/pkg-repo, tests/fetch-keyrings.sh). */
function upstreamOf(source: string, repoArch: string): { project: string; keyring: string } {
  if (source === "packages") return { project: "Omarchy Package Repository", keyring: "omarchy" };
  if (source === "chaotic") return { project: "Chaotic-AUR", keyring: "chaotic" };
  if (source === "alarm" || repoArch === "aarch64") return { project: "Arch Linux ARM", keyring: "archlinuxarm" };
  return { project: "Arch Linux", keyring: "archlinux" };
}

interface PackageRow { id: number; sha256: string; name: string; version: string; arch: string; repo_arch: string; filename: string; source: string; has_signature: number; created_at: string; r2_key: string }
interface TaskRow { id: number; name: string; arch: string; version: string | null; pkgbuild_ref: string; owner: string | null; trust: string; started_at: string | null; finished_at: string | null; duration_ms: number | null; attempts: number; result: string | null }

async function builderOf(env: Env, task: number): Promise<{ worker: string | null; agent: string | null }> {
  const ev = await env.DB.prepare("SELECT payload FROM events WHERE kind = 'build' AND status = 'ok' AND json_extract(payload, '$.task') = ? ORDER BY id DESC LIMIT 1").bind(task).first<{ payload: string }>();
  const worker = ev ? ((JSON.parse(ev.payload) as { worker?: string }).worker ?? null) : null;
  const w = worker ? await env.DB.prepare("SELECT agent FROM build_workers WHERE id = ?").bind(worker).first<{ agent: string | null }>() : null;
  return { worker, agent: w?.agent ?? null };
}

/**
 * The predicate of a factory build: recipe, the contributor's build,
 * the audit, the approval, the rebuild. Null when the object is not a
 * factory build the pool knows the task of.
 */
/** The gate's summary a build's completion kept on the task (build_tasks.result → {vet}); null before the gate. */
function vetOf(result: string | null): unknown {
  if (!result) return null;
  try {
    return (JSON.parse(result) as { vet?: unknown }).vet ?? null;
  } catch {
    return null;
  }
}

export async function factoryChain(env: Env, sha256: string): Promise<Record<string, unknown> | null> {
  const build = await env.DB.prepare("SELECT * FROM build_tasks WHERE kind = 'build' AND trust = 'project' AND result_sha256 = ? AND status = 'done' ORDER BY id DESC LIMIT 1")
    .bind(sha256)
    .first<TaskRow>();
  if (!build) return null;
  const builder = await builderOf(env, build.id);
  const ref = build.pkgbuild_ref;
  // Before 2026-09-15 an approval queued a rebuild of the staged PKGBUILD
  // itself (`staging:<task>`); since then the project builds the recipe a
  // maintainer wrote and merged, and the approval it answers is linked to
  // the build when it lands (handleComplete). Both chains read the same way.
  const staged = ref.startsWith("staging:") ? Number(ref.slice(8)) : null;
  // Since the project builds again from the evidence (review:<task>, PR C2), the recipe is the
  // project's agent's own; the contributor's build is what it learned from.
  const review = ref.startsWith("review:") ? Number(ref.slice(7)) : null;
  const recipe: Record<string, unknown> = { ref };
  const approval = await env.DB.prepare("SELECT by, note, created_at, task_id FROM approvals WHERE decision = 'approved' AND (rebuild_task = ?1 OR task_id = ?2) ORDER BY id DESC LIMIT 1")
    .bind(build.id, staged ?? -1)
    .first<{ by: string; note: string | null; created_at: string; task_id: number }>();
  let sourceBuild: Record<string, unknown> | null = null;
  let audit: Record<string, unknown> | null = null;
  const learned = staged ?? review ?? (approval && approval.task_id !== build.id ? approval.task_id : null);
  const auditOf = async (task: number): Promise<Record<string, unknown> | null> => {
    const a = await env.DB.prepare("SELECT status, result FROM build_tasks WHERE kind = 'audit' AND json_extract(params, '$.task') = ? ORDER BY id DESC LIMIT 1").bind(task).first<{ status: string; result: string | null }>();
    if (!a) return null;
    if (a.status === "done" && a.result) {
      try {
        const r = JSON.parse(a.result) as { verdict?: string; summary?: string; model?: string; findings?: unknown[] };
        return { of_task: task, verdict: r.verdict ?? null, summary: r.summary ?? null, agent: r.model ?? null, findings: Array.isArray(r.findings) ? r.findings.length : null, report: `/api/v1/factory/tasks/${task}/artifacts/audit.md` };
      } catch {
        return { of_task: task, verdict: null, error: "unreadable report" };
      }
    }
    return { of_task: task, verdict: null, status: a.status };
  };
  if (review) {
    // The project's own build: its recipe, its gate, its audit, in the project's staging space.
    recipe.by = "the project's agent, from the evidence";
    recipe.pkgbuild = `/api/v1/factory/tasks/${build.id}/artifacts/PKGBUILD`;
    recipe.learned_from = `/api/v1/factory/tasks/${review}/artifacts/PKGBUILD`;
    audit = await auditOf(build.id);
  }
  if (learned) {
    const src = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(learned).first<TaskRow>();
    if (src) {
      const b = await builderOf(env, src.id);
      sourceBuild = { task: src.id, owner: src.owner, worker: b.worker, agent: b.agent, recipe: src.pkgbuild_ref, staged_at: src.finished_at, evidence: { pkgbuild: `/api/v1/factory/tasks/${src.id}/artifacts/PKGBUILD`, log: `/api/v1/factory/tasks/${src.id}/artifacts/build.log`, pkginfo: `/api/v1/factory/tasks/${src.id}/artifacts/PKGINFO`, tests: `/api/v1/factory/tasks/${src.id}/artifacts/tests.log`, vet: `/api/v1/factory/tasks/${src.id}/artifacts/vet.json` }, gate: vetOf(src.result) };
      if (staged) {
        recipe.from = src.pkgbuild_ref;
        recipe.pkgbuild = `/api/v1/factory/tasks/${src.id}/artifacts/PKGBUILD`;
      } else if (!review) recipe.learned_from = `/api/v1/factory/tasks/${src.id}/artifacts/PKGBUILD`;
      if (!audit) audit = await auditOf(src.id);
    }
  }
  if (!staged && !review) {
    recipe.repository = REPO_URL;
    recipe.path = `factory/pkgbuilds/${build.name}/PKGBUILD`;
    recipe.commit = ref;
    recipe.pkgbuild = `${REPO_URL}/blob/${ref}/factory/pkgbuilds/${build.name}/PKGBUILD`;
  }
  return {
    builder: { worker: builder.worker, trust: "project" },
    buildType: "makepkg in a fresh Arch Linux container (factory/worker/omarchy-build-worker.sh --inside)",
    build: { task: build.id, arch: build.arch, version: build.version, started_at: build.started_at, finished_at: build.finished_at, duration_ms: build.duration_ms, attempts: build.attempts, log: review ? `/api/v1/factory/tasks/${build.id}/artifacts/build.log` : `/api/v1/factory/tasks/${build.id}`, gate: vetOf(build.result) },
    recipe,
    source_build: sourceBuild,
    audit,
    approval: approval ? { by: approval.by, at: approval.created_at, note: approval.note, of_task: approval.task_id } : null,
    // The category a maintainer settled (categories.ts) — what the package is about, for people; never who reviewed it.
    category: (await env.DB.prepare("SELECT category FROM factory_packages WHERE name = ?").bind(build.name).first<{ category: string | null }>())?.category ?? null,
    pool: { release: version(env).version, repository: REPO_URL },
  };
}

/** The seal of any object the pool stores. */
export async function sealOf(env: Env, sha256: string): Promise<Record<string, unknown> | null> {
  const p = await env.DB.prepare("SELECT id, sha256, name, version, arch, repo_arch, filename, source, has_signature, created_at, COALESCE(r2_key, repo_arch || '/' || filename) AS r2_key FROM packages WHERE sha256 = ? ORDER BY id LIMIT 1")
    .bind(sha256)
    .first<PackageRow>();
  if (!p) return null;
  const key = await publicKey(env);
  const base = { sha256: p.sha256, name: p.name, version: p.version, arch: p.arch, repo_arch: p.repo_arch, filename: p.filename, source: p.source, indexed_at: p.created_at, object: `${env.POOL_URL}/${p.r2_key}` };
  if (p.source === "factory") {
    const chain = await factoryChain(env, sha256);
    const att = `${p.r2_key}.provenance.json`;
    const attested = await env.PACKAGES.head(att);
    return {
      ...base,
      origin: "factory",
      seal: "built by the Omarchy Pool",
      summary: chain
        ? `built by the project on ${chain && (chain.builder as { worker: string | null }).worker ? (chain.builder as { worker: string }).worker : "a trusted worker"}${(chain.audit as { verdict?: string } | null)?.verdict ? `, audited (${(chain.audit as { verdict: string }).verdict})` : ""}${(chain.approval as { by?: string } | null)?.by ? `, approved by ${(chain.approval as { by: string }).by}` : ""}, signed by the pool`
        : "built by the project, signed by the pool",
      signature: key ? { by: "the pool", fingerprint: key.fingerprint, object: `${env.POOL_URL}/${p.r2_key}.sig` } : null,
      chain,
      attestation: attested ? { statement: `${env.POOL_URL}/${att}`, signature: key ? `${env.POOL_URL}/${att}.sig` : null } : null,
    };
  }
  const up = upstreamOf(p.source, p.repo_arch);
  return {
    ...base,
    origin: p.source === "packages" ? "opr" : p.source === "chaotic" ? "chaotic" : p.repo_arch === "aarch64" ? "archlinuxarm" : "archlinux",
    seal: `imported from ${up.project}`,
    summary: `imported from ${up.project} (${p.source})${p.has_signature ? `, upstream signature verified against the ${up.keyring} keyring at import and served beside the object` : ""}`,
    upstream: { project: up.project, repository: p.source, keyring: up.keyring, signature: p.has_signature ? `${env.POOL_URL}/${p.r2_key}.sig` : null, verified: p.has_signature === 1 },
    signature: null,
    chain: null,
    attestation: null,
  };
}

/**
 * Writes the attestation of a factory build next to its object — an
 * in-toto Statement with the chain as predicate — and the pool's detached
 * signature of it when the pool signs. Called once, when the project's
 * build completes; a rerun overwrites with the same facts.
 */
export async function writeAttestation(env: Env, sha256: string): Promise<boolean> {
  const p = await env.DB.prepare("SELECT filename, COALESCE(r2_key, repo_arch || '/' || filename) AS r2_key FROM packages WHERE sha256 = ? ORDER BY id LIMIT 1").bind(sha256).first<{ filename: string; r2_key: string }>();
  const chain = await factoryChain(env, sha256);
  if (!p || !chain) return false;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: p.filename, digest: { sha256 } }],
    predicateType: PREDICATE_TYPE,
    predicate: { ...chain, attested_at: new Date().toISOString() },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(statement, null, 2) + "\n");
  const key = `${p.r2_key}.provenance.json`;
  await env.PACKAGES.put(key, bytes, { httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=300" } });
  if (signingEnabled(env)) {
    const sig = await detachedSignature(env, bytes);
    await env.PACKAGES.put(`${key}.sig`, sig, { httpMetadata: { cacheControl: "public, max-age=300" } });
  }
  return true;
}

export async function handleProvenance(sha256: string, env: Env): Promise<Response> {
  const seal = await sealOf(env, sha256);
  if (!seal) return json({ error: "not found" }, 404);
  return json(seal, 200, { "cache-control": "public, max-age=60" });
}
