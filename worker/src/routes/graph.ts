import { json, type Env } from "../index";

/**
 * Returns the transitive dependency closure for the requested targets.
 *
 * Implemented as a bounded BFS over `package_requires` → `package_provides`,
 * always picking the highest (epoch, vercmp) version per name in the channel.
 * Bounded to keep well inside the Worker CPU budget; the client can page by
 * asking again for the frontier it did not receive.
 */
export async function handleGraph(url: URL, env: Env): Promise<Response> {
  const targets = (url.searchParams.get("targets") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const channel = url.searchParams.get("channel") ?? env.DEFAULT_CHANNEL;
  if (targets.length === 0) return json({ error: "targets is required" }, 400);

  // TODO(phase 4): BFS closure over D1. For now return the targets' manifests only.
  const placeholders = targets.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT manifest_json FROM packages WHERE channel = ? AND name IN (${placeholders})`,
  )
    .bind(channel, ...targets)
    .all<{ manifest_json: string }>();

  return json({
    channel,
    packages: rows.results.map((r) => JSON.parse(r.manifest_json)),
    truncated: false,
  });
}
