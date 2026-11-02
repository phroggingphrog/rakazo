import { runConformance } from "./conformance.js";
import { MemoryProactiveStore } from "./memory-store.js";

runConformance("memory store", async () => ({
  store: new MemoryProactiveStore(),
  cleanup: async () => undefined,
}));
