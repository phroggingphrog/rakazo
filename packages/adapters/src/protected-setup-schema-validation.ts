import { isDeepStrictEqual } from "node:util";
import { SetupOperationArgumentsSchema } from "@rakazo/contracts";
import * as z from "zod";

type Validation = "valid" | "invalid_arguments" | "unsupported_schema";
type Schema = Record<string, unknown>;

function plainObject(value: unknown): value is Schema {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** This deliberately supports only a closed, bounded subset of MCP JSON Schema. */
function supportedSchema(value: unknown): value is Schema {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (schema: unknown, depth: number): boolean => {
    if (++nodes > 128 || depth > 5 || !plainObject(schema) || seen.has(schema)) return false;
    seen.add(schema);
    const type = schema.type;
    if (
      typeof type !== "string" ||
      !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type)
    )
      return false;
    const allowed = new Set(["type", "title", "description"]);
    if (type === "object") {
      for (const key of ["properties", "required", "additionalProperties"]) allowed.add(key);
    }
    if (type === "array") allowed.add("items");
    if (type === "string") allowed.add("enum");
    if (Object.keys(schema).some((key) => !allowed.has(key))) return false;
    for (const key of ["title", "description"]) {
      if (
        schema[key] !== undefined &&
        (typeof schema[key] !== "string" || schema[key].length > 1024)
      )
        return false;
    }
    if (type === "object") {
      if (schema.additionalProperties !== false || !plainObject(schema.properties)) return false;
      const properties = schema.properties;
      const keys = Object.keys(properties);
      if (
        keys.length > 64 ||
        keys.some(
          (key) => !key || key.length > 100 || /^(?:__proto__|prototype|constructor)$/i.test(key),
        )
      )
        return false;
      if (
        schema.required !== undefined &&
        (!Array.isArray(schema.required) ||
          schema.required.length > 64 ||
          schema.required.some(
            (key) => typeof key !== "string" || !Object.hasOwn(properties, key),
          ) ||
          new Set(schema.required).size !== schema.required.length)
      )
        return false;
      return keys.every((key) => visit(properties[key], depth + 1));
    }
    if (type === "array") return visit(schema.items, depth + 1);
    if (type === "string" && schema.enum !== undefined) {
      return (
        Array.isArray(schema.enum) &&
        schema.enum.length > 0 &&
        schema.enum.length <= 50 &&
        schema.enum.every((entry) => typeof entry === "string" && entry.length <= 128) &&
        new Set(schema.enum).size === schema.enum.length
      );
    }
    return true;
  };
  return plainObject(value) && visit(value, 0) && value.type === "object";
}

/** Zod's converter does not enforce all object closure cases; check them independently. */
function closedObjects(schema: Schema, value: unknown): boolean {
  if (schema.type === "object") {
    if (!plainObject(value)) return false;
    const properties = schema.properties as Schema;
    if (Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    return Object.entries(value).every(([key, entry]) =>
      closedObjects(properties[key] as Schema, entry),
    );
  }
  if (schema.type === "array")
    return (
      Array.isArray(value) && value.every((entry) => closedObjects(schema.items as Schema, entry))
    );
  return true;
}

/** No provider access, argument values, schema details or validation errors leave this helper. */
export function validateProtectedSetupArguments(schema: unknown, args: unknown): Validation {
  try {
    if (!supportedSchema(schema)) return "unsupported_schema";
    if (!SetupOperationArgumentsSchema.safeParse(args).success || !closedObjects(schema, args))
      return "invalid_arguments";
    const parsed = z.fromJSONSchema(schema as never).safeParse(args);
    return parsed.success && isDeepStrictEqual(parsed.data, args) ? "valid" : "invalid_arguments";
  } catch {
    return "unsupported_schema";
  }
}
