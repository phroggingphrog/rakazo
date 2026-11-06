import { readFile } from "node:fs/promises";
import { startHostComputerServer } from "../host-computer-server.js";

// The credential stays in an operator-owned file, never in argv or logs.
const filename = process.argv[2];
if (!filename) throw new Error("Usage: host-computer-server <config.json>");
const config = JSON.parse(await readFile(filename, "utf8")) as {
  root: string;
  token: string;
  hostname: string;
  port: number;
};
const server = await startHostComputerServer({ ...config, nativeHost: true });
server.setEnabled(true);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
process.stdout.write("Native host execution service ready\n");
