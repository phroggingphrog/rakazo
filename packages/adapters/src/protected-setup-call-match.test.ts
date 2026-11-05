import { describe, expect, it } from "vitest";
import { matchesReviewedProtectedRead } from "./protected-setup-call-match.js";

const binding = {
  spaceId: "space",
  userId: "owner",
  botId: "bot",
  routineId: "routine",
  taskId: "task",
  attemptId: "attempt",
  runId: "run",
  planId: "plan",
  planRevision: 3,
  leaseOwner: "worker",
  leaseFence: 2,
};
const source = { connectorId: "mcp", resourceId: "server", resourceRevision: 2, toolName: "read" };
const schema = {
  type: "object",
  properties: {
    query: { type: "string" },
    options: {
      type: "object",
      properties: { limit: { type: "integer" } },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  required: ["query", "options"],
  additionalProperties: false,
};
const args = { query: "synthetic", options: { limit: 5 } };
const reviewed = { binding, source, schema, arguments: args, ownerConfirmed: true };
const call = {
  binding,
  source,
  schema,
  arguments: args,
  trigger: "protected_setup_v2",
  readOnly: true,
  batch: false,
};

describe("reviewed protected source comparison", () => {
  it("accepts only the same bounded reviewed call without returning its contents", () => {
    expect(matchesReviewedProtectedRead(reviewed, call)).toBe(true);
  });
  it.each(Object.keys(binding))("rejects a changed binding field %s", (key) => {
    const value = binding[key as keyof typeof binding];
    expect(
      matchesReviewedProtectedRead(reviewed, {
        ...call,
        binding: { ...binding, [key]: typeof value === "number" ? value + 1 : `${value}-other` },
      }),
    ).toBe(false);
  });
  it.each(Object.keys(source))("rejects a changed connector route field %s", (key) => {
    const value = source[key as keyof typeof source];
    expect(
      matchesReviewedProtectedRead(reviewed, {
        ...call,
        source: { ...source, [key]: typeof value === "number" ? value + 1 : `${value}-other` },
      }),
    ).toBe(false);
  });
  it("rejects changed arguments, changed schema, batch, non-read, and absent owner confirmation", () => {
    expect(
      matchesReviewedProtectedRead(reviewed, {
        ...call,
        arguments: { ...args, options: { limit: 6 } },
      }),
    ).toBe(false);
    expect(
      matchesReviewedProtectedRead(reviewed, {
        ...call,
        schema: { ...schema, description: "changed" },
      }),
    ).toBe(false);
    expect(matchesReviewedProtectedRead(reviewed, { ...call, batch: true })).toBe(false);
    expect(matchesReviewedProtectedRead(reviewed, { ...call, readOnly: false })).toBe(false);
    expect(matchesReviewedProtectedRead(reviewed, { ...call, trigger: "routine" })).toBe(false);
    expect(matchesReviewedProtectedRead({ ...reviewed, ownerConfirmed: false }, call)).toBe(false);
  });
  it("does not treat matching but unsupported schemas or forbidden argument fields as reviewed", () => {
    const unsupported = { ...schema, $ref: "https://example.test/schema" };
    expect(
      matchesReviewedProtectedRead(
        { ...reviewed, schema: unsupported },
        { ...call, schema: unsupported },
      ),
    ).toBe(false);
    const withCredential = { ...args, password: "synthetic" };
    expect(
      matchesReviewedProtectedRead(
        { ...reviewed, arguments: withCredential },
        { ...call, arguments: withCredential },
      ),
    ).toBe(false);
    expect(
      matchesReviewedProtectedRead(
        { ...reviewed, arguments: undefined },
        { ...call, arguments: undefined },
      ),
    ).toBe(false);
  });
});
