import { SetupOperationArgumentsSchema } from "./setup-plan.js";

export type SetupArgumentField = {
  name: string;
  required: boolean;
  description?: string;
} & ({ kind: "string" } | { kind: "boolean" } | { kind: "choice"; choices: string[] });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract simple fields as editing aids, not a claim of full JSON Schema validation. */
export function setupArgumentFields(schema: unknown): SetupArgumentField[] {
  if (!record(schema) || !record(schema.properties)) return [];
  if (["oneOf", "anyOf", "allOf", "$ref"].some((key) => key in schema)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields: SetupArgumentField[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (fields.length >= 20) break;
    if (!name || name.length > 100 || /^(?:__proto__|prototype|constructor)$/i.test(name)) continue;
    if (
      !record(property) ||
      property.writeOnly === true ||
      property.format === "password" ||
      ["oneOf", "anyOf", "allOf", "$ref", "const"].some((key) => key in property)
    )
      continue;
    const common = {
      name,
      required: required.has(name),
      ...(typeof property.description === "string" && property.description.trim()
        ? { description: property.description.trim().slice(0, 300) }
        : {}),
    };
    if (property.type === "string" && Array.isArray(property.enum)) {
      if (
        !property.enum.length ||
        property.enum.length > 20 ||
        property.enum.some((choice) => typeof choice !== "string" || choice.length > 2048)
      )
        continue;
      const choices = property.enum as string[];
      if (new Set(choices).size !== choices.length) continue;
      fields.push({ ...common, kind: "choice", choices });
    } else if (property.type === "string" && !("enum" in property)) {
      fields.push({ ...common, kind: "string" });
    } else if (property.type === "boolean" && !("enum" in property)) {
      fields.push({ ...common, kind: "boolean" });
    }
  }
  return fields;
}

/** Change one top-level argument without dropping complex or unrecognized values. */
export function updateSetupArgumentText(
  text: string,
  name: string,
  value: string | boolean | undefined,
): string | undefined {
  if (!name || name.length > 100 || /^(?:__proto__|prototype|constructor)$/i.test(name)) return;
  try {
    const parsed = SetupOperationArgumentsSchema.safeParse(text.trim() ? JSON.parse(text) : {});
    if (!parsed.success) return;
    const next = { ...parsed.data };
    if (value === undefined) delete next[name];
    else next[name] = value;
    return Object.keys(next).length ? JSON.stringify(next, null, 2) : "";
  } catch {
    return;
  }
}
