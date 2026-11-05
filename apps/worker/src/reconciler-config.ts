import { mcpContinuationScanEnabledFromEnv } from "@rakazo/adapters";

export function workerReconcilerOptions(env: NodeJS.ProcessEnv) {
  return { mcpContinuationScanEnabled: mcpContinuationScanEnabledFromEnv(env) };
}
