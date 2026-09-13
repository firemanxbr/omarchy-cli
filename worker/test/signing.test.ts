import { describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import { detachedSignature, publicKey, signingEnabled } from "../src/signing";
import type { Env } from "../src/index";

async function envWithKey(passphrase?: string): Promise<Env> {
  const { privateKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Pool Test", email: "test@omarchy.invalid" }], passphrase, format: "armored" });
  return { SIGNING_KEY: privateKey, SIGNING_KEY_PASSPHRASE: passphrase } as unknown as Env;
}

async function verifies(env: Env, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const pub = await publicKey(env);
  const key = await openpgp.readKey({ armoredKey: pub!.armored });
  const r = await openpgp.verify({ message: await openpgp.createMessage({ binary: data }), signature: await openpgp.readSignature({ binarySignature: sig }), verificationKeys: key, format: "binary" });
  return r.signatures[0].verified.then(() => true, () => false);
}

describe("signing inside the Worker", () => {
  it("is off without a key", () => {
    expect(signingEnabled({} as Env)).toBe(false);
  });

  it("makes a binary detached signature the public key verifies", async () => {
    const env = await envWithKey();
    const data = new TextEncoder().encode("omarchy-factory-edge.db");
    const sig = await detachedSignature(env, data);
    expect(sig[0] & 0x80).toBe(0x80); // an OpenPGP packet, not armor
    expect(await verifies(env, data, sig)).toBe(true);
    expect(await verifies(env, new TextEncoder().encode("tampered"), sig)).toBe(false);
  });

  it("signs a stream (how package objects are read from R2)", async () => {
    const env = await envWithKey("hunter2");
    const parts = [new Uint8Array(70000).fill(1), new Uint8Array(3).fill(2)];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    });
    const sig = await detachedSignature(env, stream);
    const whole = new Uint8Array(70003);
    whole.set(parts[0], 0);
    whole.set(parts[1], 70000);
    expect(await verifies(env, whole, sig)).toBe(true);
  });

  it("refuses an encrypted key without its passphrase", async () => {
    const env = await envWithKey("hunter2");
    env.SIGNING_KEY_PASSPHRASE = undefined;
    await expect(detachedSignature(env, new Uint8Array(1))).rejects.toThrow(/PASSPHRASE/);
  });

  it("reports the public key", async () => {
    const env = await envWithKey();
    const k = await publicKey(env);
    expect(k?.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(k?.user).toBe("Pool Test <test@omarchy.invalid>");
    expect(k?.armored).toContain("BEGIN PGP PUBLIC KEY BLOCK");
  });
});
