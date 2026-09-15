/**
 * The factory's record: every step a package takes, written once to the
 * pool bucket under factory/<name>/<request>/… with the pool's detached
 * signature beside it, and never rewritten. Public — the bucket is what
 * pool.firemanxbr.org serves — so anyone can read a request, a decision or
 * a build's evidence and verify who wrote it; nothing in it is private (a
 * GitHub login, a project URL, a licence, a log). The staging bucket stays
 * the workers' scratch space and expires; this does not.
 *
 *   factory/<name>/<request>/request.json            what the contributor asked for (record.ts, PR A)
 *   factory/<name>/<request>/build-<task>/…          a build's evidence, copied from staging when it is staged (PR C)
 *   factory/<name>/<request>/decision-<n>.json       approve / reject / block, with the maintainer's login (PR D)
 */
import type { Env } from "./index";
import { signingEnabled, detachedSignature } from "./signing";

export const RECORD_CACHE = "public, max-age=31536000, immutable";

export function recordKey(name: string, request: number, file: string): string {
  return `factory/${name}/${request}/${file}`;
}

/** The record's public URL, as the dashboard and the API hand it out. */
export function recordUrl(env: Env, key: string): string {
  return `${env.POOL_URL}/${key}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Writes one JSON document and its signature. Refuses to overwrite: a
 * record is written once, a correction is a new record.
 */
export async function putRecord(env: Env, key: string, document: Record<string, unknown>): Promise<{ key: string; sha256: string; signed: boolean }> {
  if (await env.PACKAGES.head(key)) throw new Error(`record ${key} already exists; records are written once`);
  return putRecordBytes(env, key, new TextEncoder().encode(JSON.stringify(document, null, 2) + "\n"), "application/json");
}

/** The same for bytes that are not a document of the pool's — a PKGBUILD, a log, a report — with the pool's signature beside them. */
export async function putRecordBytes(env: Env, key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; sha256: string; signed: boolean }> {
  await env.PACKAGES.put(key, bytes, { httpMetadata: { contentType, cacheControl: RECORD_CACHE } });
  let signed = false;
  if (signingEnabled(env)) {
    const sig = await detachedSignature(env, bytes);
    await env.PACKAGES.put(`${key}.sig`, sig, { httpMetadata: { contentType: "application/pgp-signature", cacheControl: RECORD_CACHE } });
    signed = true;
  }
  return { key, sha256: await sha256Hex(bytes), signed };
}

/** The evidence files a build leaves; the package itself stays in staging (the project's own build is what gets published). */
export const EVIDENCE_FILES = ["PKGBUILD", "build.log", "PKGINFO", "vet.json", "tests.log", "audit.json", "audit.md"];

/**
 * Copies a build's evidence from the workers' staging space (which
 * expires) to the record (which does not): factory/<name>/<request>/build-<task>/<file>,
 * each signed. Only the files that exist; a file already on the record
 * is left alone (a build is written once too). Returns what was copied.
 */
export async function recordEvidence(env: Env, name: string, request: number | null, task: number, stagingPrefix: string, files: string[] = EVIDENCE_FILES): Promise<string[]> {
  if (!request) return [];
  const copied: string[] = [];
  for (const file of files) {
    const key = recordKey(name, request, `build-${task}/${file}`);
    if (await env.PACKAGES.head(key)) continue;
    const obj = await env.STAGING.get(`${stagingPrefix}${file}`);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) continue; // evidence is text; a package is not evidence
    const type = file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8";
    await putRecordBytes(env, key, bytes, type);
    copied.push(file);
  }
  return copied;
}

/** The gate's verdict as the review keeps it: enough to show and to decide on, not the whole transcript. */
export function vetSummary(vet: unknown): { verdict: string; fails: number; warnings: number; failed: string[]; warned: string[] } | null {
  if (!vet || typeof vet !== "object") return null;
  const v = vet as { verdict?: string; checks?: { name?: string; status?: string }[] };
  const checks = Array.isArray(v.checks) ? v.checks : [];
  const failed = checks.filter((c) => c.status === "fail").map((c) => String(c.name ?? "?"));
  const warned = checks.filter((c) => c.status === "warn").map((c) => String(c.name ?? "?"));
  return { verdict: v.verdict === "pass" || v.verdict === "fail" ? v.verdict : "unknown", fails: failed.length, warnings: warned.length, failed, warned };
}
