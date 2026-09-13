/**
 * Package requests come in as GitHub issues (the "package-request" form)
 * and leave GitHub right there: the brain reads the open issues — public
 * API, no token — records each new one and queues a community build with a
 * drafted PKGBUILD (`draft:<url>@latest`) for the issue's author. A shared
 * community worker whose owner runs an agent takes it; the result is
 * evidence for a maintainer like any contributor's build. No agent runs on
 * GitHub, no key of the pool's is involved.
 */
import type { Env } from "./index";
import { groupsOf } from "./governance";
import { providedBy, splitByUpstream } from "./routes/factory";

const ISSUES = "https://api.github.com/repos/firemanxbr/omarchy-pool/issues?labels=package-request&state=open&per_page=50";

interface Issue {
  number: number;
  html_url: string;
  body: string | null;
  user: { login: string; type?: string };
  pull_request?: unknown;
}

/** One field of the issue form (`### Label` followed by its value). */
export function field(body: string, label: string): string {
  const lines = body.replace(/\r/g, "").split("\n");
  const at = lines.findIndex((l) => l.trim() === `### ${label}`);
  if (at < 0) return "";
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("### ")) break;
    const v = l.trim();
    if (v && v !== "_No response_") return v;
  }
  return "";
}

/** What an issue asks for, or the reason it cannot be a request. */
export function parseIssue(body: string): { url: string; name: string; group: string; hint: string } | { error: string } {
  let url = field(body, "Project URL");
  const m = url.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/#?\s]+)/);
  if (!m) return { error: `not a GitHub project URL: ${url || "(empty)"}` };
  url = `https://github.com/${m[1]}/${m[2].replace(/\.git$/, "")}`;
  let name = field(body, "Package name (optional)").toLowerCase();
  if (!name) name = m[2].replace(/\.git$/, "").toLowerCase();
  if (!/^[a-z0-9@._+-]+$/.test(name)) return { error: `not a pacman package name: ${name}` };
  return { url, name, group: field(body, "Group"), hint: field(body, "Notes for the packager (optional)") };
}

export async function syncRequests(env: Env, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(ISSUES, { headers: { accept: "application/vnd.github+json", "user-agent": "omarchy-pool" }, cf: { cacheTtl: 300 } } as RequestInit);
  if (res.status === 403 || res.status === 429) return "requests: GitHub rate limit; next tick";
  if (!res.ok) throw new Error(`issues: HTTP ${res.status}`);
  const issues = ((await res.json()) as Issue[]).filter((i) => !i.pull_request && i.user?.type !== "Bot");
  const groups = (await groupsOf(env)).map((g) => g.name);
  const log: string[] = [];
  for (const issue of issues) {
    const known = await env.DB.prepare("SELECT id, status FROM build_requests WHERE issue_url = ?").bind(issue.html_url).first<{ id: number; status: string }>();
    if (known) continue;
    const parsed = parseIssue(issue.body ?? "");
    if ("error" in parsed) {
      await env.DB.prepare("INSERT INTO build_requests (name, \"group\", arches, requested_by, reason, status, issue_url, detail) VALUES (?, 'community', '[]', ?, ?, 'rejected', ?, ?) ON CONFLICT (name) DO NOTHING")
        .bind(`issue-${issue.number}`, issue.user.login, `issue #${issue.number}`, issue.html_url, parsed.error)
        .run();
      log.push(`#${issue.number}: ${parsed.error}`);
      continue;
    }
    const group = groups.includes(parsed.group) ? parsed.group : groups.includes("community") ? "community" : (groups[0] ?? "community");
    const arches = ["x86_64", "aarch64"];
    const { build, skipped } = splitByUpstream(await providedBy(env, parsed.name), arches, false);
    if (!build.length) {
      await env.DB.prepare("INSERT INTO build_requests (name, \"group\", arches, url, requested_by, reason, status, issue_url, detail) VALUES (?, ?, '[]', ?, ?, ?, 'rejected', ?, ?) ON CONFLICT (name) DO UPDATE SET issue_url = excluded.issue_url, detail = excluded.detail, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
        .bind(parsed.name, group, parsed.url, issue.user.login, `issue #${issue.number}`, issue.html_url, `${skipped[0].source} already ships ${parsed.name} (${skipped.map((s) => `${s.version} for ${s.arch}`).join(", ")})`)
        .run();
      log.push(`#${issue.number} ${parsed.name}: shipped upstream already`);
      continue;
    }
    // The issue's author owns the package (a contributor row they take
    // over at their first sign-in); the request is in review once built.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contributors (login, token_hash, role, areas) VALUES (?, ?, 'contributor', '[]') ON CONFLICT (login) DO NOTHING").bind(issue.user.login, `unset:${crypto.randomUUID()}`),
      env.DB.prepare("INSERT INTO factory_packages (name, owner, url, \"group\", arches, status, detail) VALUES (?, ?, ?, ?, ?, 'waiting', ?) ON CONFLICT (name) DO NOTHING")
        .bind(parsed.name, issue.user.login, parsed.url, group, JSON.stringify(build), `requested in issue #${issue.number}; waiting for a shared community worker with an agent`),
      env.DB.prepare("INSERT INTO build_requests (name, \"group\", arches, url, requested_by, reason, status, issue_url, detail) VALUES (?, ?, ?, ?, ?, ?, 'drafting', ?, ?) ON CONFLICT (name) DO UPDATE SET issue_url = excluded.issue_url, status = 'drafting', detail = excluded.detail, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
        .bind(parsed.name, group, JSON.stringify(build), parsed.url, issue.user.login, parsed.hint || `issue #${issue.number}`, issue.html_url, "queued for a shared community worker to draft and build"),
      ...build.map((arch) =>
        env.DB.prepare(`INSERT INTO build_tasks (name, "group", arch, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES (?, ?, ?, ?, ?, 100, 0, 'community', ?, 'build')`)
          .bind(parsed.name, group, arch, `draft:${parsed.url}@latest`, `package-request #${issue.number}`, issue.user.login),
      ),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('request', NULL, 'factory', 'ok', ?, ?)")
        .bind(`${parsed.name} requested in issue #${issue.number} by ${issue.user.login}: ${build.join(", ")} queued for a shared community worker`, JSON.stringify({ name: parsed.name, group, arches: build, url: parsed.url, issue: issue.html_url, skipped })),
    ]);
    log.push(`#${issue.number} ${parsed.name}: ${build.join(", ")} queued`);
  }
  return log.length ? `requests: ${log.join("; ")}` : `requests: ${issues.length} open, nothing new`;
}
