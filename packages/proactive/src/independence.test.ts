import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("package independence", () => {
  it("imports nothing from other @rakazo packages", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /from\s+["']@rakazo\//.test(readFileSync(`${dir}${f}`, "utf8")));
    expect(offenders).toEqual([]);
  });
});
