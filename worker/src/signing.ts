/**
 * The pool signs its own objects. The OpenPGP private key is a Worker
 * secret (SIGNING_KEY, armored; SIGNING_KEY_PASSPHRASE when it has one) —
 * it never leaves Cloudflare, no worker or CI job holds it. Databases are
 * signed as they are stored; a package object is signed on request by the
 * job that published it (POST /pool/:sha256/sign). Signatures are binary
 * detached OpenPGP signatures, what pacman reads from a .sig.
 */
import * as openpgp from "openpgp";
import type { Env } from "./index";

let cached: { armored: string; key: openpgp.PrivateKey } | null = null;

export function signingEnabled(env: Env): boolean {
  return !!env.SIGNING_KEY;
}

async function signingKey(env: Env): Promise<openpgp.PrivateKey | null> {
  if (!env.SIGNING_KEY) return null;
  if (cached && cached.armored === env.SIGNING_KEY) return cached.key;
  let key = await openpgp.readPrivateKey({ armoredKey: env.SIGNING_KEY });
  if (!key.isDecrypted()) {
    if (!env.SIGNING_KEY_PASSPHRASE) throw new Error("SIGNING_KEY is encrypted and SIGNING_KEY_PASSPHRASE is not set");
    key = await openpgp.decryptKey({ privateKey: key, passphrase: env.SIGNING_KEY_PASSPHRASE });
  }
  cached = { armored: env.SIGNING_KEY, key };
  return key;
}

/** A binary detached signature over the data (a stream: the object is hashed as it is read, never held whole). */
export async function detachedSignature(env: Env, data: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  const key = await signingKey(env);
  if (!key) throw new Error("signing is not configured");
  const message = await openpgp.createMessage({ binary: data });
  const sig = await openpgp.sign({ message, signingKeys: key, detached: true, format: "binary" });
  if (sig instanceof Uint8Array) return sig;
  // A streamed input yields a streamed signature; a detached signature is small.
  const chunks: Uint8Array[] = [];
  const reader = (sig as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** The public key, armored, for /status and the get-started page. */
export async function publicKey(env: Env): Promise<{ fingerprint: string; user: string; armored: string } | null> {
  const key = await signingKey(env);
  if (!key) return null;
  const pub = key.toPublic();
  return { fingerprint: pub.getFingerprint().toUpperCase(), user: (await pub.getPrimaryUser()).user.userID?.userID ?? "", armored: pub.armor() };
}
