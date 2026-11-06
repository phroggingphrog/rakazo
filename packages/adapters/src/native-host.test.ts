import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRunSandbox } from "./host-aware-sandbox.js";
import { startHostComputerServer } from "./host-computer-server.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
  runId: "native-test",
};
describe("explicit deployment native host", () => {
  it("fails closed without transport configuration", async () => {
    await expect(createRunSandbox("host", {})).rejects.toThrow("requires SANDBOX_HOST_URL");
  });
  it("shares absolute and relative paths with shell, survives reconnect and reports host failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-host-test-"));
    const outside = path.join(root, "outside.txt");
    const token = randomBytes(32).toString("hex");
    const server = await startHostComputerServer({
      root,
      token,
      hostname: "127.0.0.1",
      nativeHost: true,
    });
    server.setEnabled(true);
    const options = {
      hostComputerUrl: `http://127.0.0.1:${server.port}`,
      hostComputerToken: token,
    };
    try {
      const sandbox = await createRunSandbox("host", options);
      expect(await sandbox.provisionKind?.()).toBe("desktop");
      const computer = await sandbox.provision({ botId: "first", homePath: "ignored" }, context);
      const environment = await sandbox.environment?.(computer, context);
      expect(environment).toMatchObject({ platform: process.platform, nativeHost: true });
      await sandbox.writeFile(
        computer,
        { path: outside, content: Buffer.from("from-file") },
        context,
      );
      expect(await readFile(outside, "utf8")).toBe("from-file");
      await writeFile(outside, "from-shell");
      expect(Buffer.from(await sandbox.readFile(computer, outside, context)).toString()).toBe(
        "from-shell",
      );
      await sandbox.writeFile(
        computer,
        { path: "relative.txt", content: Buffer.from("relative") },
        context,
      );
      let output = "";
      for await (const event of sandbox.execute(
        computer,
        { argv: ["sh", "-c", "cat relative.txt; printf changed > relative.txt"], timeoutMs: 1000 },
        context,
      ))
        if (event.type === "stdout") output += event.data;
      expect(output).toBe("relative");
      const reconnected = await createRunSandbox("host", options);
      expect(
        Buffer.from(await reconnected.readFile(computer, "relative.txt", context)).toString(),
      ).toBe("changed");
      expect(await sandbox.listFiles(computer, root, context)).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: outside })]),
      );
      const second = await sandbox.provision({ botId: "second", homePath: "ignored" }, context);
      expect((await sandbox.environment?.(second, context))?.cwd).not.toBe(environment?.cwd);
    } finally {
      await server.close();
    }
    const unavailable = await createRunSandbox("host", options);
    await expect(
      unavailable.provision({ botId: "first", homePath: "ignored" }, context),
    ).rejects.toThrow();
  });
});
