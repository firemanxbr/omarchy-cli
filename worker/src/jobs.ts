/**
 * A maintainer runs a pool job by hand — a sync, a promotion, a render, a
 * health check, the security run, gc, the PKGBUILD reconcile — the way the
 * scheduler does: a task in the queue that a project worker executes with
 * a per-job token. No credential of the maintainer's touches the pool.
 */
import { json, type Env } from "./index";
import { createJob, SYNC_SOURCES, syncJobFor } from "./scheduler";
import type { Contributor } from "./routes/contributors";

const RINGS = ["edge", "rc", "stable"];
const ARCHES = ["x86_64", "aarch64"];

export async function handleQueueJob(c: Contributor, request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { kind?: string; params?: Record<string, unknown>; arch?: string };
  const p = b.params ?? {};
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  let job: { kind: string; params: Record<string, string>; arch: string };
  switch (b.kind) {
    case "sync": {
      // A whole architecture (one release per ring, like the scheduler's), or one source.
      if (!s("source")) {
        const arch = s("arch") || "x86_64";
        if (!ARCHES.includes(arch)) return json({ error: "sync needs arch (x86_64, aarch64), or a source" }, 400);
        job = syncJobFor(arch);
        break;
      }
      const src = SYNC_SOURCES.find((x) => x.source === s("source") && x.arch === (s("arch") || "x86_64") && x.ring === (s("ring") || "edge"));
      if (!src) return json({ error: "sync needs a known source, arch and ring", sources: SYNC_SOURCES.map((x) => `${x.source}/${x.arch}→${x.ring}`) }, 400);
      job = { kind: "sync", params: { ...src, defer_to: src.defer_to ?? "" }, arch: src.arch };
      break;
    }
    case "promote": {
      const from = s("from"), to = s("to");
      if (!RINGS.includes(from) || !RINGS.includes(to) || from === to) return json({ error: "promote needs from and to (edge, rc, stable)" }, 400);
      job = { kind: "promote", params: { from, to, note: s("note") || `manual ${from} → ${to} by ${c.login}` }, arch: "x86_64" };
      break;
    }
    case "render":
    case "health": {
      const ring = s("ring"), arch = s("arch") || "x86_64";
      if (!RINGS.includes(ring) || !ARCHES.includes(arch)) return json({ error: `${b.kind} needs ring (edge, rc, stable) and arch (x86_64, aarch64)` }, 400);
      job = { kind: b.kind, params: { ring, arch }, arch };
      break;
    }
    case "gc":
      job = { kind: "gc", params: s("keep") ? { keep: s("keep") } : {}, arch: "x86_64" };
      break;
    case "security":
    case "enqueue":
      job = { kind: b.kind, params: {}, arch: ARCHES.includes(b.arch ?? "") ? (b.arch as string) : "x86_64" };
      break;
    default:
      return json({ error: "kind must be one of sync, promote, render, health, security, enqueue, gc" }, 400);
  }
  const id = await createJob(env, job, `queued by ${c.login}`);
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('dispatch', ?, ?, 'ok', ?, ?)")
    .bind(job.params.to ?? job.params.ring ?? null, job.params.source ?? null, `${job.kind} queued by ${c.login} as task ${id}`, JSON.stringify({ task: id, job, by: c.login }))
    .run();
  return json({ task: id, job }, 201);
}
