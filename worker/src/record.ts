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
  const bytes = new TextEncoder().encode(JSON.stringify(document, null, 2) + "\n");
  await env.PACKAGES.put(key, bytes, { httpMetadata: { contentType: "application/json", cacheControl: RECORD_CACHE } });
  let signed = false;
  if (signingEnabled(env)) {
    const sig = await detachedSignature(env, bytes);
    await env.PACKAGES.put(`${key}.sig`, sig, { httpMetadata: { contentType: "application/pgp-signature", cacheControl: RECORD_CACHE } });
    signed = true;
  }
  return { key, sha256: await sha256Hex(bytes), signed };
}
