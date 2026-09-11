import { json, type Env } from "../index";

export async function handlePackage(name: string, url: URL, env: Env): Promise<Response> {
  const channel = url.searchParams.get("channel") ?? env.DEFAULT_CHANNEL;
  const rows = await env.DB.prepare(
    "SELECT manifest_json FROM packages WHERE name = ? AND channel = ? ORDER BY epoch DESC, created_at DESC",
  )
    .bind(decodeURIComponent(name), channel)
    .all<{ manifest_json: string }>();
  if (rows.results.length === 0) return json({ error: "package not found" }, 404);
  return json({ channel, versions: rows.results.map((r) => JSON.parse(r.manifest_json)) });
}
