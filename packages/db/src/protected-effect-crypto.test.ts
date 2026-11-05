import { describe, expect, it } from "vitest";
import type { DataKey } from "./content-crypto.js";
import {
  createProtectedEffectKey,
  openProtectedEffectKey,
  openProtectedEffectPayload,
  protectedEffectIdempotencyKey,
  rewrapProtectedEffectKey,
  rewrapProtectedEffectPayload,
  sealProtectedEffectPayload,
} from "./protected-effect-crypto.js";

const identity = { spaceId: "space-1", userId: "owner-1", scopeId: "scope-1" };
const oldKey: DataKey = { id: "key-1", spaceId: "space-1", version: 1, key: Buffer.alloc(32, 1) };
const newKey: DataKey = { id: "key-2", spaceId: "space-1", version: 2, key: Buffer.alloc(32, 2) };

function ring() {
  let current = oldKey;
  const keys = new Map([
    [oldKey.id, oldKey],
    [newKey.id, newKey],
  ]);
  return {
    encryptWrites: true,
    current: async () => current,
    byId: async (id: string) => {
      const key = keys.get(id);
      if (!key) throw new Error("Unavailable key");
      return key;
    },
    rotate: () => {
      current = newKey;
    },
  };
}

describe("protected effect cryptography", () => {
  it("always encrypts complete payloads with fresh nonces and decrypts after rotation", async () => {
    const keys = ring();
    const payload = { route: "sample.read", request: { query: "private" }, result: ["mail"] };
    const first = await sealProtectedEffectPayload(keys, identity, "effect-1", payload);
    const second = await sealProtectedEffectPayload(keys, identity, "effect-1", payload);
    expect(first).not.toContain("private");
    expect(first).not.toContain("sample.read");
    expect(first).not.toEqual(second);
    keys.rotate();
    const newer = await sealProtectedEffectPayload(keys, identity, "effect-1", payload);
    expect(newer).toMatch(/^rkz1:key-2:/);
    expect(await openProtectedEffectPayload(keys, identity, "effect-1", first)).toEqual(payload);
    expect(await openProtectedEffectPayload(keys, identity, "effect-1", newer)).toEqual(payload);
  });

  it("binds payloads to space, owner, scope, effect and cryptographic purpose", async () => {
    const keys = ring();
    const sealed = await sealProtectedEffectPayload(keys, identity, "effect-1", {
      content: "secret",
    });
    for (const changed of [
      { ...identity, userId: "other-owner" },
      { ...identity, scopeId: "other-scope" },
      { ...identity, spaceId: "other-space" },
    ])
      await expect(openProtectedEffectPayload(keys, changed, "effect-1", sealed)).rejects.toThrow();
    await expect(openProtectedEffectPayload(keys, identity, "effect-2", sealed)).rejects.toThrow();
    await expect(openProtectedEffectKey(keys, identity, sealed)).rejects.toThrow();
  });

  it("rejects plaintext, malformed ciphertext, tampering and missing keys", async () => {
    const keys = ring();
    const sealed = await sealProtectedEffectPayload(keys, identity, "effect-1", {
      content: "secret",
    });
    for (const bad of [
      { content: "secret" },
      "plaintext",
      "rkz1:key-1:***",
      `${sealed}A`,
      sealed.replace("key-1", "missing"),
    ])
      await expect(openProtectedEffectPayload(keys, identity, "effect-1", bad)).rejects.toThrow();
  });

  it("refuses writes when encryption is disabled or key space is wrong", async () => {
    const keys = ring();
    await expect(
      sealProtectedEffectPayload({ ...keys, encryptWrites: false }, identity, "effect-1", {}),
    ).rejects.toThrow();
    await expect(
      createProtectedEffectKey({ ...keys, encryptWrites: false }, identity),
    ).rejects.toThrow();
    await expect(
      sealProtectedEffectPayload(keys, { ...identity, spaceId: "other" }, "effect-1", {}),
    ).rejects.toThrow();
  });

  it("persists the per-run secret only encrypted and keeps HMAC keys stable after rotation", async () => {
    const keys = ring();
    const { key, ciphertext } = await createProtectedEffectKey(keys, identity);
    expect(ciphertext).not.toContain(key.toString("base64url"));
    const input = {
      route: { server: "s", tool: "read" },
      args: { query: "private" },
      occurrence: 0,
    };
    const before = protectedEffectIdempotencyKey(key, identity, input);
    keys.rotate();
    const rewrapped = await rewrapProtectedEffectKey(keys, identity, ciphertext);
    expect(rewrapped).toMatch(/^rkz1:key-2:/);
    expect(
      protectedEffectIdempotencyKey(
        await openProtectedEffectKey(keys, identity, rewrapped),
        identity,
        input,
      ),
    ).toBe(before);
    await expect(
      openProtectedEffectKey(keys, { ...identity, userId: "other" }, ciphertext),
    ).rejects.toThrow();
  });

  it("rewraps payloads only after authentication and retains their complete content", async () => {
    const keys = ring();
    const sealed = await sealProtectedEffectPayload(keys, identity, "payload-1", {
      value: "private",
    });
    keys.rotate();
    const rewrapped = await rewrapProtectedEffectPayload(keys, identity, "payload-1", sealed);
    expect(rewrapped).toMatch(/^rkz1:key-2:/);
    expect(await openProtectedEffectPayload(keys, identity, "payload-1", rewrapped)).toEqual({
      value: "private",
    });
    await expect(
      rewrapProtectedEffectPayload(keys, identity, "payload-2", sealed),
    ).rejects.toThrow();
  });

  it("uses stable domain-separated HMAC test vectors with no plaintext scope, route or args", () => {
    const key = Buffer.alloc(32, 7);
    const input = {
      route: { server: "s", tool: "read" },
      args: { query: "test", limit: 2 },
      occurrence: 0,
    };
    const value = protectedEffectIdempotencyKey(key, identity, input);
    expect(value).toBe(
      "protected:v1:70599ec3ecc18c17bba4429839ed3d3c0cefd924752fbac247d8439eece85b79",
    );
    expect(value).not.toContain("scope-1");
    expect(value).not.toContain("read");
    expect(value).not.toContain("test");
    expect(
      protectedEffectIdempotencyKey(key, identity, { ...input, args: { limit: 2, query: "test" } }),
    ).toBe(value);
    expect(protectedEffectIdempotencyKey(key, identity, { ...input, occurrence: 1 })).not.toBe(
      value,
    );
    expect(protectedEffectIdempotencyKey(key, { ...identity, scopeId: "scope-2" }, input)).not.toBe(
      value,
    );
    expect(protectedEffectIdempotencyKey(Buffer.alloc(32, 8), identity, input)).not.toBe(value);
  });

  it("rejects invalid JSON, unsafe occurrences, large values and malformed identities", async () => {
    const keys = ring();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = Array(1);
    for (const value of [
      undefined,
      NaN,
      BigInt(1),
      new Date(),
      cyclic,
      sparse,
      "x".repeat(512 * 1024 + 1),
    ])
      await expect(sealProtectedEffectPayload(keys, identity, "effect-1", value)).rejects.toThrow();
    expect(() =>
      protectedEffectIdempotencyKey(Buffer.alloc(32), identity, {
        route: {},
        args: {},
        occurrence: -1,
      }),
    ).toThrow();
    expect(() =>
      protectedEffectIdempotencyKey(Buffer.alloc(1), identity, {
        route: {},
        args: {},
        occurrence: 0,
      }),
    ).toThrow();
    await expect(
      sealProtectedEffectPayload(keys, { ...identity, scopeId: "bad\0id" }, "effect-1", {}),
    ).rejects.toThrow();
  });
});
