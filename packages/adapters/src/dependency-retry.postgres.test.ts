import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { DependencyRetry } from "./dependency-retry.js";
const exec = promisify(execFile);
const enabled = process.env.VERIFY_CIRCUIT_CONTAINER === "rakazo-phase2-migration-test";
(enabled ? it : it.skip)("real PostgreSQL admits one probe and fences expired tokens", async () => {
  const inspected = await exec("docker", ["inspect", "rakazo-phase2-migration-test"]);
  const [container] = JSON.parse(inspected.stdout);
  expect(container.HostConfig.NetworkMode).toBe("none");
  expect(
    container.Mounts.some(
      (mount: { Type: string }) => mount.Type === "bind" || mount.Type === "volume",
    ),
  ).toBe(false);
  const literal = (v: unknown): string =>
    v == null
      ? "NULL"
      : typeof v === "number"
        ? String(v)
        : typeof v === "boolean"
          ? String(v)
          : "'" +
            String(v instanceof Date ? v.toISOString() : v).replaceAll("'", "''") +
            "'" +
            (v instanceof Date ? "::timestamp" : "");
  const query = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.reduce(
      (text, part, i) => text + part + (i < values.length ? literal(values[i]) : ""),
      "",
    );
    const { stdout } = await exec("docker", [
      "exec",
      "rakazo-phase2-migration-test",
      "psql",
      "-U",
      "postgres",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT coalesce(json_agg(t), '[]'::json) FROM (" + sql + ") t",
    ]);
    return JSON.parse(stdout.trim());
  };
  // A data-modifying CTE permits RETURNING through the same transport.
  const raw = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.reduce(
      (text, part, i) => text + part + (i < values.length ? literal(values[i]) : ""),
      "",
    );
    const { stdout } = await exec("docker", [
      "exec",
      "rakazo-phase2-migration-test",
      "psql",
      "-U",
      "postgres",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "WITH changed AS (" +
        sql +
        " RETURNING *) SELECT coalesce(json_agg(changed), '[]'::json) FROM changed",
    ]);
    return JSON.parse(stdout.trim());
  };
  const db = {
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes("INSERT INTO")) {
        const clean = [...parts];
        clean[clean.length - 1] = clean.at(-1)!.replace(/RETURNING "claimToken"\s*$/, "");
        return raw(clean as unknown as TemplateStringsArray, ...values);
      }
      return query(parts, ...values);
    },
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await raw(parts, ...values)).length,
  };
  let now = new Date();
  const identity = {
    serverId: "test-" + crypto.randomUUID(),
    spaceId: "test",
    userId: "test",
    revision: 1,
  };
  const first = new DependencyRetry(
    db as never,
    () => now,
    () => 0,
  );
  const second = new DependencyRetry(
    db as never,
    () => now,
    () => 0,
  );
  const admissions = await Promise.all([first.claim(identity), second.claim(identity)]);
  expect(admissions.filter((a) => "claim" in a)).toHaveLength(1);
  const winner = admissions.find((a) => "claim" in a)!;
  if (!("claim" in winner)) throw Error("no winner");
  now = new Date(now.getTime() + 61000);
  const replacement = await second.claim(identity);
  expect("claim" in replacement).toBe(true);
  await first.complete(winner.claim, "success");
  expect("claim" in (await first.claim(identity))).toBe(false);
  if (!("claim" in replacement)) throw Error("no replacement");
  const slowProbeStartedAt = new Date(now.getTime() - 1);
  await first.recover(identity, new Date(now.getTime() + 1));
  expect("claim" in (await first.claim(identity))).toBe(false); // Active claim cannot be erased.
  await second.complete(replacement.claim, "transient");
  await first.recover(identity, slowProbeStartedAt);
  expect("claim" in (await first.claim(identity))).toBe(false); // Newer failure survives slow success.
  await first.recover(identity, new Date(now.getTime() + 1));
  const recovered = await first.claim(identity);
  expect("claim" in recovered).toBe(true);
  if (!("claim" in recovered)) throw Error("recovery did not admit");
  await first.complete(recovered.claim, "transient");
  expect("claim" in (await new DependencyRetry(db as never, () => now).claim(identity))).toBe(
    false,
  );
  for (let failures = 1; failures < 5; failures++) {
    now = new Date(now.getTime() + 301000);
    const next = await first.claim(identity);
    if (!("claim" in next)) throw Error("budget exhausted prematurely");
    await first.complete(next.claim, "transient");
  }
  now = new Date(now.getTime() + 86400000);
  expect("claim" in (await new DependencyRetry(db as never, () => now).claim(identity))).toBe(
    false,
  );
  expect("claim" in (await first.claim({ ...identity, userId: "other" }))).toBe(true);
  expect("claim" in (await first.claim({ ...identity, revision: 2 }))).toBe(true);
});
