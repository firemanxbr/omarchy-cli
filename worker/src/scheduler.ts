import type { Env } from "./index";
import { requeueExpiredLeases } from "./routes/factory";

/**
 * The pool's own scheduler. GitHub's cron is best-effort — on 2026-09-12 it
 * delayed the hourly sync by an hour and never started the half-hourly
 * metrics — so a Cloudflare cron trigger checks every ten minutes when each
 * workflow last ran and dispatches the ones that are overdue. GitHub's own
 * schedules stay in the workflow files; whichever fires first wins, and a
 * run already queued or in progress is never doubled.
 *
 * Needs the GITHUB_TOKEN secret (fine-grained, Actions: read and write on
 * the repository). Without it the trigger logs and does nothing.
 */

const REPO = "firemanxbr/omarchy-pool";
const API = `https://api.github.com/repos/${REPO}/actions/workflows`;

interface Rule {
  workflow: string;
  /** Run when the last run is older than this many minutes… */
  every?: number;
  /** …or once a day after this UTC time (hour, minute), when nothing ran since. */
  at?: { hour: number; minute: number; weekday?: number };
  inputs?: Record<string, string>;
}

export const RULES: Rule[] = [
  { workflow: "sync.yml", every: 60 },
  { workflow: "metrics.yml", every: 30 },
  { workflow: "security.yml", every: 180 },
  { workflow: "factory-enqueue.yml", every: 60 },
  { workflow: "promote.yml", at: { hour: 6, minute: 0 }, inputs: { from: "edge", to: "rc", note: "daily rc" } },
  { workflow: "promote.yml", at: { hour: 9, minute: 0 }, inputs: { from: "rc", to: "stable", note: "daily stable" } },
  { workflow: "health.yml", at: { hour: 8, minute: 30 } },
  { workflow: "gc.yml", at: { hour: 4, minute: 0, weekday: 0 } },
];

interface RunSummary {
  created_at: string;
  status: string;
  event: string;
  display_title?: string;
}

/** Latest runs of a workflow (newest first), skipping pull-request runs. */
async function recentRuns(env: Env, workflow: string): Promise<RunSummary[]> {
  const res = await fetch(`${API}/${workflow}/runs?per_page=10&exclude_pull_requests=true`, {
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "omarchy-pool-scheduler" },
  });
  if (!res.ok) throw new Error(`runs of ${workflow}: HTTP ${res.status}`);
  return ((await res.json()) as { workflow_runs: RunSummary[] }).workflow_runs;
}

async function dispatch(env: Env, workflow: string, inputs: Record<string, string> | undefined): Promise<void> {
  const res = await fetch(`${API}/${workflow}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "omarchy-pool-scheduler" },
    body: JSON.stringify({ ref: "main", inputs: inputs ?? {} }),
  });
  if (!res.ok) throw new Error(`dispatch ${workflow}: HTTP ${res.status} ${await res.text()}`);
}

/** Does a rule with inputs match a run? (Two promote rules share a workflow.) */
function matches(rule: Rule, run: RunSummary): boolean {
  if (!rule.inputs?.to) return true;
  // The plan step titles a promotion run by its note; the schedule form runs
  // carry the same intent, so a promote run of any kind counts for the slot.
  return run.event === "schedule" || (run.display_title ?? "").includes(rule.inputs.note ?? "") || run.event === "workflow_dispatch";
}

/** Decide, pure: is the rule due at `now`, given the workflow's recent runs? */
export function isDue(rule: Rule, runs: RunSummary[], now: Date): { due: boolean; why: string } {
  const relevant = runs.filter((r) => matches(rule, r));
  if (relevant.some((r) => r.status === "queued" || r.status === "in_progress" || r.status === "waiting" || r.status === "pending")) {
    return { due: false, why: "a run is queued or in progress" };
  }
  const last = relevant[0] ? Date.parse(relevant[0].created_at) : 0;
  if (rule.every !== undefined) {
    const overdueBy = (now.getTime() - last) / 60000 - rule.every;
    return overdueBy >= 5 ? { due: true, why: `last run ${Math.round((now.getTime() - last) / 60000)} min ago, expected every ${rule.every}` } : { due: false, why: "on time" };
  }
  if (rule.at) {
    if (rule.at.weekday !== undefined && now.getUTCDay() !== rule.at.weekday) return { due: false, why: "not today" };
    const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), rule.at.hour, rule.at.minute));
    // Due from 10 minutes after the slot (GitHub's own cron gets first go) until the end of the day.
    if (now.getTime() < slot.getTime() + 10 * 60000) return { due: false, why: "slot not reached" };
    if (last >= slot.getTime()) return { due: false, why: "already ran after the slot" };
    return { due: true, why: `nothing ran since the ${rule.at.hour}:${String(rule.at.minute).padStart(2, "0")} UTC slot` };
  }
  return { due: false, why: "no rule" };
}

/**
 * The factory queue lives in D1; workers can run anywhere. GitHub's hosted
 * runners are one free, ephemeral place to run them (x86_64 and aarch64
 * natively on a public repository), so when tasks are queued for an
 * architecture and no worker of that architecture is alive, the scheduler
 * starts one there. It is a worker like any other: it claims from Cloudflare.
 */
export async function factoryDemand(env: Env, now = new Date()): Promise<{ arch: string; queued: number; alive: number }[]> {
  const rows = await env.DB.prepare(
    `SELECT arch, COUNT(*) AS queued,
            (SELECT COUNT(*) FROM build_workers w WHERE w.arch = t.arch AND w.last_seen > ?) AS alive
       FROM build_tasks t WHERE status = 'queued' GROUP BY arch`,
  )
    .bind(new Date(now.getTime() - 10 * 60000).toISOString())
    .all<{ arch: string; queued: number; alive: number }>();
  return rows.results;
}

export async function runScheduler(env: Env, now = new Date()): Promise<string[]> {
  const log: string[] = [];
  try {
    const n = await requeueExpiredLeases(env);
    if (n) log.push(`factory: ${n} expired lease(s) back in the queue`);
  } catch (e) {
    log.push(`factory requeue: ${String(e)}`);
  }
  if (!env.GITHUB_TOKEN) {
    log.push("GITHUB_TOKEN not set; scheduler idle");
    return log;
  }
  const cache = new Map<string, RunSummary[]>();
  for (const rule of RULES) {
    try {
      const runs = cache.get(rule.workflow) ?? (await recentRuns(env, rule.workflow));
      cache.set(rule.workflow, runs);
      const { due, why } = isDue(rule, runs, now);
      if (!due) {
        log.push(`${rule.workflow}${rule.inputs?.to ? " → " + rule.inputs.to : ""}: ${why}`);
        continue;
      }
      await dispatch(env, rule.workflow, rule.inputs);
      cache.delete(rule.workflow);
      log.push(`${rule.workflow}: dispatched (${why})`);
      await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('dispatch', ?, NULL, 'ok', ?, ?)")
        .bind(rule.inputs?.to ?? null, `${rule.workflow} dispatched by the pool scheduler — ${why}`, JSON.stringify({ workflow: rule.workflow, inputs: rule.inputs ?? {}, why }))
        .run();
    } catch (e) {
      log.push(`${rule.workflow}: ${String(e)}`);
    }
  }
  try {
    for (const d of await factoryDemand(env, now)) {
      if (d.alive > 0) {
        log.push(`factory ${d.arch}: ${d.queued} queued, ${d.alive} worker(s) alive`);
        continue;
      }
      const runs = await recentRuns(env, "factory-worker.yml");
      const busy = runs.find((r) => (r.display_title ?? "").includes(d.arch) && ["queued", "in_progress", "waiting", "pending"].includes(r.status));
      if (busy) {
        log.push(`factory ${d.arch}: a hosted worker is ${busy.status}`);
        continue;
      }
      await dispatch(env, "factory-worker.yml", { arch: d.arch });
      log.push(`factory ${d.arch}: hosted worker dispatched for ${d.queued} queued task(s)`);
      await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('dispatch', NULL, 'factory', 'ok', ?, ?)")
        .bind(`hosted ${d.arch} build worker started by the pool scheduler — ${d.queued} task(s) queued, no worker alive`, JSON.stringify({ workflow: "factory-worker.yml", arch: d.arch, queued: d.queued }))
        .run();
    }
  } catch (e) {
    log.push(`factory workers: ${String(e)}`);
  }
  return log;
}
