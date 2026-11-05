import { describe, expect, it } from "vitest";
import { setupArgumentFields, updateSetupArgumentText } from "./setup-argument-fields.js";

describe("guided setup arguments", () => {
  it("extracts simple declared fields without inventing defaults", () => {
    const fields = setupArgumentFields({
      type: "object",
      required: ["start"],
      properties: {
        start: { type: "string", description: " Earliest event " },
        calendar: { type: "string", enum: ["", "primary"] },
        includeCancelled: { type: "boolean" },
        limit: { type: "integer" },
        filter: { type: "object" },
        password: { type: "string", format: "password" },
        ambiguous: { anyOf: [{ type: "string" }, { type: "boolean" }] },
      },
    });
    expect(fields).toEqual([
      { name: "start", required: true, kind: "string", description: "Earliest event" },
      { name: "calendar", required: false, kind: "choice", choices: ["", "primary"] },
      { name: "includeCancelled", required: false, kind: "boolean" },
    ]);
  });

  it("leaves complex, malformed, duplicate and unsafe fields to the JSON editor", () => {
    expect(setupArgumentFields({ oneOf: [], properties: { name: { type: "string" } } })).toEqual(
      [],
    );
    expect(
      setupArgumentFields({
        properties: {
          constructor: { type: "string" },
          multi: { type: "string", enum: ["a", "a"] },
          mixed: { type: "string", enum: ["a", 1] },
        },
      }),
    ).toEqual([]);
    expect(setupArgumentFields(null)).toEqual([]);
  });

  it("updates and removes one field while preserving nested and unknown arguments", () => {
    const initial = JSON.stringify({
      query: "appointments",
      options: { limit: 5 },
      enabled: false,
    });
    const changed = updateSetupArgumentText(initial, "query", "mental health");
    expect(JSON.parse(changed!)).toEqual({
      query: "mental health",
      options: { limit: 5 },
      enabled: false,
    });
    const removed = updateSetupArgumentText(changed!, "enabled", undefined);
    expect(JSON.parse(removed!)).toEqual({ query: "mental health", options: { limit: 5 } });
    expect(updateSetupArgumentText("", "enabled", false)).toContain("false");
    expect(updateSetupArgumentText("{broken", "query", "x")).toBeUndefined();
    expect(updateSetupArgumentText("{}", "__proto__", "x")).toBeUndefined();
  });
});
