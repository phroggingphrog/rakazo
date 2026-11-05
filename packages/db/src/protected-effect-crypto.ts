import { createHmac, randomBytes } from "node:crypto";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import {
  type ContentLocation,
  ciphertextKeyId,
  type DataKey,
  decryptText,
  encryptText,
} from "./content-crypto.js";

/** Cryptography only: callers must separately establish authoritative owner and run bindings. */
export interface ProtectedEffectIdentity {
  spaceId: string;
  userId: string;
  scopeId: string;
}

type ProtectedRing = {
  readonly encryptWrites: boolean;
  current(spaceId: string): Promise<DataKey>;
  byId(id: string): Promise<DataKey>;
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
const MAX_BYTES = 512 * 1024;
const KEY_BYTES = 32;

function location(identity: ProtectedEffectIdentity, kind: "scope" | "effect", id: string) {
  if (![identity.spaceId, identity.userId, identity.scopeId, id].every((part) => ID.test(part)))
    throw new Error("Invalid protected effect identity");
  return {
    table: kind === "scope" ? "protected_effect_scopes" : "protected_effect_payloads",
    column: kind === "scope" ? "idempotencyKey" : "payload",
    rowId: id,
    owner: JSON.stringify([identity.userId, identity.scopeId]),
  } satisfies ContentLocation;
}

/** Reject values whose JSON encoding would silently lose data or exhaust recursion. */
function canonical(value: unknown): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("Invalid protected JSON");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      if (Buffer.byteLength(item, "utf8") > MAX_BYTES)
        throw new Error("Protected JSON is too large");
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || ancestors.has(item)) throw new Error("Invalid protected JSON");
    const proto = Object.getPrototypeOf(item);
    if (
      Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null
    )
      throw new Error("Invalid protected JSON");
    if (Object.getOwnPropertySymbols(item).length) throw new Error("Invalid protected JSON");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) throw new Error("Invalid protected JSON");
        if (Object.keys(descriptors).length !== item.length + 1)
          throw new Error("Invalid protected JSON");
        for (let index = 0; index < item.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor?.enumerable || !("value" in descriptor))
            throw new Error("Invalid protected JSON");
          visit(descriptor.value, depth + 1);
        }
      } else {
        for (const descriptor of Object.values(descriptors)) {
          if (!descriptor.enumerable || !("value" in descriptor))
            throw new Error("Invalid protected JSON");
          visit(descriptor.value, depth + 1);
        }
      }
    } finally {
      ancestors.delete(item);
    }
  };
  visit(value, 0);
  const encoded = stableJsonValue(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES)
    throw new Error("Protected JSON is too large");
  return encoded;
}

function ciphertextId(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_BYTES * 2)
    throw new Error("Invalid protected ciphertext");
  const match = /^rkz1:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]+)$/.exec(value);
  if (!match || ciphertextKeyId(value) !== match[1])
    throw new Error("Invalid protected ciphertext");
  const encoded = match[2]!;
  if (Buffer.from(encoded, "base64url").toString("base64url") !== encoded)
    throw new Error("Invalid protected ciphertext");
  return match[1]!;
}

async function seal(
  ring: ProtectedRing,
  identity: ProtectedEffectIdentity,
  at: ContentLocation,
  text: string,
) {
  if (!ring.encryptWrites) throw new Error("Protected effect encryption is unavailable");
  const key = await ring.current(identity.spaceId);
  if (key.spaceId !== identity.spaceId) throw new Error("Protected effect space mismatch");
  return encryptText(key, at, text);
}

async function open(
  ring: ProtectedRing,
  identity: ProtectedEffectIdentity,
  at: ContentLocation,
  value: unknown,
) {
  const key = await ring.byId(ciphertextId(value));
  if (key.spaceId !== identity.spaceId) throw new Error("Protected effect space mismatch");
  return decryptText(key, at, value as string);
}

/** Generate once per protected run; persist only the ciphertext atomically with its scope. */
export async function createProtectedEffectKey(
  ring: ProtectedRing,
  identity: ProtectedEffectIdentity,
) {
  const at = location(identity, "scope", identity.scopeId);
  const key = randomBytes(KEY_BYTES);
  const ciphertext = await seal(ring, identity, at, key.toString("base64url"));
  return { key, ciphertext };
}

export async function openProtectedEffectKey(
  ring: ProtectedRing,
  identity: ProtectedEffectIdentity,
  value: unknown,
) {
  const encoded = await open(ring, identity, location(identity, "scope", identity.scopeId), value);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("Invalid protected effect key");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== KEY_BYTES || key.toString("base64url") !== encoded)
    throw new Error("Invalid protected effect key");
  return key;
}

/** Callers must CAS the old ciphertext when persisting the result. */
export async function rewrapProtectedEffectKey(
  ring: ProtectedRing,
  identity: ProtectedEffectIdentity,
  value: unknown,
) {
  const key = await openProtectedEffectKey(ring, identity, value);
  return seal(
    ring,
    identity,
    location(identity, "scope", identity.scopeId),
    key.toString("base64url"),
  );
}

/** payloadId is immutable even if an effect's database ID is updated by cascade. */
export async function sealProtectedEffectPayload(
  ring: ProtectedRing,
  identity: ProtectedEffectIdentity,
  payloadId: string,
  payload: unknown,
) {
  const at = location(identity, "effect", payloadId);
  return seal(ring, identity, at, canonical({ version: 1, payload }));
}

/** Plaintext, malformed and unauthenticated values are always rejected. */
export async function openProtectedEffectPayload(
  ring: ProtectedRing,
  identity: ProtectedEffectIdentity,
  payloadId: string,
  value: unknown,
): Promise<unknown> {
  const plaintext = await open(ring, identity, location(identity, "effect", payloadId), value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Invalid protected effect payload");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "payload,version" ||
    (parsed as { version?: unknown }).version !== 1
  )
    throw new Error("Invalid protected effect payload");
  canonical(parsed);
  return (parsed as { payload: unknown }).payload;
}

/** Callers must CAS the old ciphertext when persisting the result. */
export async function rewrapProtectedEffectPayload(
  ring: ProtectedRing,
  identity: ProtectedEffectIdentity,
  payloadId: string,
  value: unknown,
) {
  const payload = await openProtectedEffectPayload(ring, identity, payloadId, value);
  return sealProtectedEffectPayload(ring, identity, payloadId, payload);
}

/** Opaque and stable for one run, route, exact arguments and occurrence across retries. */
export function protectedEffectIdempotencyKey(
  key: Uint8Array,
  identity: ProtectedEffectIdentity,
  input: { route: unknown; args: unknown; occurrence: number },
): string {
  location(identity, "scope", identity.scopeId);
  if (key.length !== KEY_BYTES || !Number.isSafeInteger(input.occurrence) || input.occurrence < 0)
    throw new Error("Invalid protected effect key input");
  const value = canonical({
    version: 1,
    scopeId: identity.scopeId,
    spaceId: identity.spaceId,
    userId: identity.userId,
    route: input.route,
    args: input.args,
    occurrence: input.occurrence,
  });
  return `protected:v1:${createHmac("sha256", key).update("rakazo/protected-effect/v1\0").update(value).digest("hex")}`;
}
