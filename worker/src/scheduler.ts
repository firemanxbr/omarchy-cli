import type { Env } from "./index";
import { requeueExpiredLeases, pruneWorkers } from "./routes/factory";
import { snapshotMetrics } from "./metrics";
import { syncGovernance } from "./governance";
import { syncRequests } from "./requests";
import { checkUpdates } from "./updates";
import { syncProvenance } from "./provenance";
import { costGuard, dailyCost } from "./cost";

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
  /** The rule's name — a workflow file for the two GitHub still starts, otherwise the job it queues. */
  workflow: string;
  /** Run when the last run is older than this many minutes… */
  every?: number;
  /** …or once a day after this UTC time (hour, minute), when nothing ran since. */
  at?: { hour: number; minute: number; weekday?: number };
  inputs?: Record<string, string>;
  /**
   * The same work as a pulled job (kind + params) for a trusted worker.
   * Used instead of the workflow when JOB_KINDS lists the kind: the cron
   * creates the task, GitHub is not involved.
   */
  job?: { kind: string; params: Record<string, string>; arch?: string };
}

/**
 * What the sync job pulls, per source and architecture.
 */
export const SYNC_SOURCES: { source: string; arch: string; ring: string; base_url: string; db_name: string; keyring: string; defer_to?: string }[] = [
  { source: "core", arch: "x86_64", ring: "edge", base_url: "https://mirror.omarchy.org/core/os/x86_64", db_name: "core", keyring: "archlinux" },
  { source: "multilib", arch: "x86_64", ring: "edge", base_url: "https://mirror.omarchy.org/multilib/os/x86_64", db_name: "multilib", keyring: "archlinux" },
  { source: "extra", arch: "x86_64", ring: "edge", base_url: "https://mirror.omarchy.org/extra/os/x86_64", db_name: "extra", keyring: "archlinux" },
  { source: "packages", arch: "x86_64", ring: "edge", base_url: "https://pkgs.omarchy.org/edge/x86_64", db_name: "omarchy", keyring: "omarchy" },
  { source: "packages", arch: "x86_64", ring: "rc", base_url: "https://pkgs.omarchy.org/rc/x86_64", db_name: "omarchy", keyring: "omarchy" },
  { source: "packages", arch: "x86_64", ring: "stable", base_url: "https://pkgs.omarchy.org/stable/x86_64", db_name: "omarchy", keyring: "omarchy" },
  { source: "chaotic", arch: "x86_64", ring: "edge", base_url: "https://builds.garudalinux.org/repos/chaotic-aur/x86_64", db_name: "chaotic-aur", keyring: "chaotic", defer_to: "core,extra,multilib,packages,factory" },
  { source: "core", arch: "aarch64", ring: "edge", base_url: "http://os.archlinuxarm.org/aarch64/core", db_name: "core", keyring: "archlinuxarm" },
  { source: "alarm", arch: "aarch64", ring: "edge", base_url: "http://os.archlinuxarm.org/aarch64/alarm", db_name: "alarm", keyring: "archlinuxarm" },
  { source: "extra", arch: "aarch64", ring: "edge", base_url: "http://os.archlinuxarm.org/aarch64/extra", db_name: "extra", keyring: "archlinuxarm" },
  { source: "packages", arch: "aarch64", ring: "edge", base_url: "https://pkgs.omarchy.org/edge/aarch64", db_name: "omarchy", keyring: "omarchy" },
];

export const RULES: Rule[] = [
  // Every three hours, one task per architecture: a release copies the
  // ring's whole selection and D1 bills every row written, so the sources
  // of an architecture are synced together and pinned as one release per
  // ring (cost review, 2026-09-13).
  { workflow: "sync", every: 180, job: { kind: "sync", params: {} } },
  { workflow: "security", every: 180, job: { kind: "security", params: {} } },
  { workflow: "enqueue", every: 60, job: { kind: "enqueue", params: {} } },
  { workflow: "promote", at: { hour: 6, minute: 0 }, inputs: { from: "edge", to: "rc", note: "daily rc" }, job: { kind: "promote", params: { from: "edge", to: "rc", note: "daily rc" } } },
  { workflow: "promote", at: { hour: 9, minute: 0 }, inputs: { from: "rc", to: "stable", note: "daily stable" }, job: { kind: "promote", params: { from: "rc", to: "stable", note: "daily stable" } } },
  { workflow: "health", at: { hour: 8, minute: 30 }, job: { kind: "health", params: {} } },
  { workflow: "factory-update.yml", at: { hour: 5, minute: 45 } },
  { workflow: "gc", at: { hour: 4, minute: 0, weekday: 0 }, job: { kind: "gc", params: {} } },
  // Does what the pool serves verify? Every OPR object, once a week, repaired when not.
  { workflow: "verify", at: { hour: 3, minute: 0, weekday: 6 }, job: { kind: "verify", params: {} } },
];

/** The tasks a rule expands to in job mode: sync is one per architecture (all its sources), health one per ring and architecture. */
export function jobsOf(rule: Rule): { kind: string; params: Record<string, string>; arch: string }[] {
  const j = rule.job;
  if (!j) return [];
  if (j.kind === "sync") return ["x86_64", "aarch64"].map((arch) => syncJobFor(arch));
  if (j.kind === "health") {
    const out: { kind: string; params: Record<string, string>; arch: string }[] = [];
    for (const ring of ["edge", "rc", "stable"]) for (const arch of ["x86_64", "aarch64"]) out.push({ kind: "health", params: { ring, arch }, arch });
    return out;
  }
  return [{ kind: j.kind, params: j.params, arch: j.arch ?? "x86_64" }];
}

/** The sync task of one architecture: every source of it, in the order of the table, one release per ring at the end. */
export function syncJobFor(arch: string): { kind: string; params: Record<string, string>; arch: string } {
  const sources = SYNC_SOURCES.filter((s) => s.arch === arch).map((s) => ({ ...s, defer_to: s.defer_to ?? "" }));
  return { kind: "sync", params: { arch, sources: JSON.stringify(sources) }, arch };
}

function jobMode(env: Env, kind: string): boolean {
  return (env.JOB_KINDS ?? "").split(",").map((k) => k.trim()).includes(kind);
}

/** Recent tasks of a kind with these parameters, shaped like workflow runs so isDue() applies. */
async function recentJobs(env: Env, kind: string, params: Record<string, string>): Promise<RunSummary[]> {
  const rows = await env.DB.prepare("SELECT created_at, status FROM build_tasks WHERE kind = ? AND params = ? ORDER BY id DESC LIMIT 10")
    .bind(kind, JSON.stringify(params))
    .all<{ created_at: string; status: string }>();
  return rows.results.map((r) => ({ created_at: r.created_at, status: r.status === "queued" || r.status === "leased" ? "in_progress" : "completed", event: "schedule" }));
}

export async function createJob(env: Env, job: { kind: string; params: Record<string, string>; arch: string }, reason = "scheduled"): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO build_tasks (name, "group", arch, pkgbuild_ref, reason, priority, status, publish, trust, kind, params) VALUES (?, 'pool', ?, '-', ?, 50, 'queued', 1, 'project', ?, ?) RETURNING id`,
  )
    .bind(job.kind, job.arch, reason, job.kind, JSON.stringify(job.params))
    .first<{ id: number }>();
  return row?.id ?? 0;
}

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
export async function factoryDemand(env: Env, now = new Date()): Promise<{ arch: string; queued: number; alive: number; pool: number }[]> {
  // "alive" here means alive *and idle*: a worker busy with a nine-hour
  // build does not serve the queue behind it. Pool jobs (sync, promote…)
  // need project trust; community workers do not count for them.
  const rows = await env.DB.prepare(
    `SELECT arch, COUNT(*) AS queued, SUM(CASE WHEN kind != 'build' OR trust = 'project' THEN 1 ELSE 0 END) AS pool,
            (SELECT COUNT(*) FROM build_workers w WHERE w.arch = t.arch AND w.last_seen > ? AND w.current_task IS NULL AND w.trust = 'project' AND w.revoked_at IS NULL) AS alive
       FROM build_tasks t WHERE status = 'queued' AND (kind != 'build' OR trust = 'project') GROUP BY arch`,
  )
    .bind(new Date(now.getTime() - 10 * 60000).toISOString())
    .all<{ arch: string; queued: number; alive: number; pool: number }>();
  return rows.results;
}

export async function runScheduler(env: Env, now = new Date()): Promise<string[]> {
  const log: string[] = [];
  try {
    const n = await requeueExpiredLeases(env);
    if (n) log.push(`factory: ${n} expired lease(s) back in the queue`);
    const gone = await pruneWorkers(env);
    if (gone) log.push(`factory: ${gone} unregistered worker(s) forgotten`);
  } catch (e) {
    log.push(`factory requeue: ${String(e)}`);
  }
  // Governance: who maintains what, from the file on main.
  try {
    const g = await syncGovernance(env);
    if (g !== "governance: unchanged") log.push(g);
  } catch (e) {
    log.push(`governance: ${String(e)}`);
  }
  // Package requests: open issues become community build tasks.
  try {
    const r = await syncRequests(env);
    if (!r.endsWith("nothing new")) log.push(r);
  } catch (e) {
    log.push(`requests: ${String(e)}`);
  }
  // Bumps: once a day, after 05:45 UTC, the approved packages' upstreams.
  if (now.getUTCHours() * 60 + now.getUTCMinutes() >= 5 * 60 + 45) {
    try {
      const u = await checkUpdates(env, now);
      if (u !== "updates: checked today") log.push(u);
    } catch (e) {
      log.push(`updates: ${String(e)}`);
    }
  }
  // OPR provenance: once a day, after 05:15 UTC, where each OPR recipe comes from.
  if (now.getUTCHours() * 60 + now.getUTCMinutes() >= 5 * 60 + 15) {
    try {
      const p = await syncProvenance(env, now);
      if (p !== "provenance: scanned today") log.push(p);
    } catch (e) {
      log.push(`provenance: ${String(e)}`);
    }
  }
  // The metrics snapshot is the brain's own bookkeeping: no worker needed.
  if (jobMode(env, "metrics")) {
    try {
      log.push(await snapshotMetrics(env, now));
    } catch (e) {
      log.push(`metrics: ${String(e)}`);
    }
  }
  // The bill: estimated once a day after 06:30 UTC; the guard pauses the
  // jobs that write when the month heads over budget (cost.ts).
  if (now.getUTCHours() * 60 + now.getUTCMinutes() >= 6 * 60 + 30 && env.CLOUDFLARE_ANALYTICS_TOKEN) {
    try {
      const c = await dailyCost(env, now);
      if (c !== "cost: estimated today") log.push(c);
    } catch (e) {
      log.push(`cost: ${String(e)}`);
    }
  }
  const guard = await costGuard(env);
  if (guard) log.push(`cost guard up — no sync, promote, render, security or enqueue jobs: ${guard}`);
  // Rules whose kind runs as pulled jobs: the cron creates the tasks; a
  // trusted worker anywhere does the work. No GitHub in the loop.
  for (const rule of RULES) {
    if (!rule.job || !jobMode(env, rule.job.kind)) continue;
    if (guard && ["sync", "promote", "render", "security", "enqueue"].includes(rule.job.kind)) continue;
    for (const job of jobsOf(rule)) {
      try {
        const { due, why } = isDue({ ...rule, inputs: undefined }, await recentJobs(env, job.kind, job.params), now);
        const label = `${job.kind}${job.params.source ? " " + job.params.source + "/" + job.arch : job.params.to ? " → " + job.params.to : job.params.ring ? " " + job.params.ring + "/" + job.arch : ""}`;
        if (!due) {
          log.push(`job ${label}: ${why}`);
          continue;
        }
        const id = await createJob(env, job);
        log.push(`job ${label}: queued as task ${id} (${why})`);
        await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('dispatch', ?, ?, 'ok', ?, ?)")
          .bind(job.params.to ?? job.params.ring ?? null, job.params.source ?? null, `${label} queued by the pool scheduler as task ${id} — ${why}`, JSON.stringify({ task: id, job, why }))
          .run();
      } catch (e) {
        log.push(`job ${job.kind}: ${String(e)}`);
      }
    }
  }
  if (!env.GITHUB_TOKEN) {
    log.push("GITHUB_TOKEN not set; scheduler idle");
    return log;
  }
  // What still starts on GitHub by dispatch: the rules without a job (the
  // recipe bumps). A job kind left out of JOB_KINDS simply does not run —
  // the workflows that once did are gone.
  const cache = new Map<string, RunSummary[]>();
  for (const rule of RULES) {
    if (rule.job) {
      if (!jobMode(env, rule.job.kind)) log.push(`${rule.workflow}: not in JOB_KINDS; nothing runs it`);
      continue;
    }
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
        log.push(`factory ${d.arch}: ${d.queued} queued, ${d.alive} idle project worker(s)`);
        continue;
      }
      // Only pool jobs get a hosted fallback. Builds — contributors' on their
      // own workers, the project's on its trusted machines — never start a
      // GitHub runner: the project's compute is not for building packages.
      // Audits neither: they need a worker owner's agent key, which GitHub
      // never holds (SECURITY.md).
      const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE status = 'queued' AND arch = ? AND kind NOT IN ('build', 'audit') AND trust = 'project'").bind(d.arch).first<{ n: number }>();
      if (!pending?.n) {
        log.push(`factory ${d.arch}: ${d.queued} queued build(s) wait for a project worker (no hosted build workers)`);
        continue;
      }
      const runs = await recentRuns(env, "pool-worker.yml");
      const busy = runs.find((r) => (r.display_title ?? "").includes(d.arch) && ["queued", "in_progress", "waiting", "pending"].includes(r.status));
      if (busy) {
        log.push(`pool-worker.yml ${d.arch}: a hosted worker is ${busy.status}`);
        continue;
      }
      await dispatch(env, "pool-worker.yml", { arch: d.arch });
      log.push(`pool-worker.yml ${d.arch}: hosted worker dispatched for ${pending.n} queued pool job(s)`);
      await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('dispatch', NULL, 'factory', 'ok', ?, ?)")
        .bind(`hosted ${d.arch} pool worker started by the pool scheduler — ${pending.n} pool job(s) queued, no idle project worker`, JSON.stringify({ workflow: "pool-worker.yml", arch: d.arch, queued: pending.n }))
        .run();
    }
  } catch (e) {
    log.push(`factory workers: ${String(e)}`);
  }
  return log;
}
