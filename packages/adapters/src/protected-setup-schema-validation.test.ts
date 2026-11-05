import { describe, expect, it } from "vitest";
import { validateProtectedSetupArguments } from "./protected-setup-schema-validation.js";

const schema = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "integer" },
    direction: { type: "string", enum: ["new", "old"] },
    options: {
      type: "object",
      properties: { flags: { type: "array", items: { type: "boolean" } } },
      required: ["flags"],
      additionalProperties: false,
    },
  },
  required: ["query", "options"],
  additionalProperties: false,
};

describe("protected setup schema subset", () => {
  it("accepts bounded closed schemas and returns no argument content", () => {
    expect(
      validateProtectedSetupArguments(schema, {
        query: "synthetic query",
        limit: 5,
        direction: "new",
        options: { flags: [true, false] },
      }),
    ).toBe("valid");
  });
  it.each([
    { options: { flags: [] } },
    { query: "x", options: {} },
    { query: "x", options: { flags: [] }, extra: true },
    { query: "x", options: { flags: [], extra: true } },
    { query: "x", options: { flags: [1] } },
    { query: "x", options: { flags: [] }, limit: 1.5 },
    { query: "x", options: { flags: [] }, direction: "other" },
    { query: "x", options: { flags: [] }, password: "synthetic" },
  ])("rejects missing, extra, invalid, or credential inputs %#", (args) => {
    expect(validateProtectedSetupArguments(schema, args)).toBe("invalid_arguments");
  });
  it.each([
    { ...schema, additionalProperties: true },
    { ...schema, additionalProperties: undefined },
    { ...schema, $ref: "https://example.test/schema" },
    { ...schema, patternProperties: { ".*": { type: "string" } } },
    { ...schema, properties: { query: { type: "string", pattern: "(a+)+$" } } },
    { ...schema, properties: { query: { type: "string", format: "email" } } },
    { ...schema, properties: { query: { type: "string", default: "x" } } },
    { ...schema, properties: { query: { anyOf: [{ type: "string" }, { type: "null" }] } } },
    { ...schema, required: ["missing"] },
    {
      ...schema,
      properties: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`p${i}`, { type: "string" }]),
      ),
    },
  ])("rejects unsupported schemas without returning their content %#", (candidate) => {
    expect(validateProtectedSetupArguments(candidate, { query: "synthetic" })).toBe(
      "unsupported_schema",
    );
  });
  it("rejects recursive or deeply nested schemas without traversing indefinitely", () => {
    const recursive: Record<string, unknown> = { type: "array" };
    recursive.items = recursive;
    expect(
      validateProtectedSetupArguments(
        { type: "object", properties: { x: recursive }, additionalProperties: false },
        {},
      ),
    ).toBe("unsupported_schema");
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 7; i++) deep = { type: "array", items: deep };
    expect(
      validateProtectedSetupArguments(
        { type: "object", properties: { x: deep }, additionalProperties: false },
        {},
      ),
    ).toBe("unsupported_schema");
  });
});
