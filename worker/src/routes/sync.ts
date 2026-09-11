import { json, type Env } from "../index";

interface SyncRequest {
  channel?: string;
  installed: Record<string, string>; // name → full version
}

/** Returns the packages in `installed` that have a newer version available. */
export async function handleSyncDiff(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as SyncRequest;
  const channel = body.channel ?? env.DEFAULT_CHANNEL;
  const names = Object.keys(body.installed ?? {});
  if (names.length === 0) return json({ channel, updates: [] });

  // TODO(phase 4): compare with vercmp semantics server-side; for now return the
  // latest manifest for every installed name and let the client decide.
  const placeholders = names.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT manifest_json FROM packages WHERE channel = ? AND name IN (${placeholders})`,
  )
    .bind(channel, ...names)
    .all<{ manifest_json: string }>();

  return json({ channel, updates: rows.results.map((r) => JSON.parse(r.manifest_json)) });
}
