import { json, type Env } from "../index";

interface EventIn {
  kind: string;
  ring?: string | null;
  source?: string | null;
  status?: "ok" | "warn" | "error";
  summary: string;
  payload?: unknown;
  duration_ms?: number | null;
}

export async function handlePostEvent(request: Request, env: Env): Promise<Response> {
  const e = (await request.json()) as EventIn;
  if (!e?.kind || !e.summary) return json({ error: "kind and summary are required" }, 400);
  const status = e.status ?? "ok";
  if (!["ok", "warn", "error"].includes(status)) return json({ error: "bad status" }, 400);
  const row = await env.DB.prepare(
    "INSERT INTO events (kind, ring, source, status, summary, payload, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at",
  )
    .bind(e.kind, e.ring ?? null, e.source ?? null, status, e.summary, e.payload === undefined ? null : JSON.stringify(e.payload), e.duration_ms ?? null)
    .first<{ id: number; created_at: string }>();
  return json(row, 201);
}

export async function handleGetEvents(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const kind = url.searchParams.get("kind");
  const rows = kind
    ? await env.DB.prepare("SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT ?").bind(kind, limit).all()
    : await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").bind(limit).all();
  return json({
    events: rows.results.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload as string) : null })),
  });
}
