/** Additive display projection; persisted legacy statuses remain compatible with older clients. */
export type TaskLifecycle = "created" | "queued" | "running" | "waiting_for_approval" | "waiting_for_external_dependency" | "retrying" | "completed" | "failed" | "cancelled";
export function taskLifecycle(run: { status: string; wakeAt?: Date | null; attemptCount?: number }, pendingApproval = false, dependencyBlocked = false): TaskLifecycle {
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run.status;
  if (pendingApproval) return "waiting_for_approval";
  if (dependencyBlocked || run.status === "waiting_takeover") return "waiting_for_external_dependency";
  // Ordinary questions are dependencies, not evidence of a pending approval.
  if (run.status === "waiting_input") return "waiting_for_external_dependency";
  if (run.status === "queued") return run.wakeAt && (run.attemptCount ?? 0) > 0 ? "retrying" : "queued";
  if (run.status === "running" || run.status === "leased") return "running";
  return "created";
}
