type Cleanup = () => void | Promise<void>;

export async function stopApiResources(steps: {
  drain: Cleanup;
  mcp: Cleanup;
  mcpDrained: (error: unknown) => boolean;
  installed: Cleanup;
  secrets: Cleanup;
  realtime: Cleanup;
  database: Cleanup;
  pool: Cleanup;
  jobPool: Cleanup;
  analytics: Cleanup;
  logger: Cleanup;
}): Promise<void> {
  let failed = false;
  let drained = false;
  try {
    await steps.drain();
    try {
      await steps.mcp();
      drained = true;
    } catch (error) {
      failed = true;
      drained = steps.mcpDrained(error);
    }
    if (drained) {
      try {
        await steps.installed();
      } catch {
        failed = true;
        drained = false;
      }
      if (drained) {
        for (const cleanup of [
          steps.secrets,
          steps.realtime,
          steps.database,
          steps.pool,
          steps.jobPool,
        ]) {
          try {
            await cleanup();
          } catch {
            failed = true;
          }
        }
      }
    }
  } catch {
    failed = true;
  }
  for (const cleanup of [steps.analytics, steps.logger]) {
    try {
      await cleanup();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("API shutdown incomplete; resources may still be active.");
}
