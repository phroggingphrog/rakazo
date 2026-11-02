export type ToolFailureClass = "transient" | "nontransient" | "unknown";

export interface NoProgressEvidence {
  code: "repeated_equivalent_failure";
  toolName: string;
  failureClass: ToolFailureClass;
  failedAttempts: number;
  recoveryStep: string;
}

const MAX_FAILED_ATTEMPTS: Record<ToolFailureClass, number> = {
  nontransient: 1,
  transient: 2,
  unknown: 2,
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(String(value));
  }
}

/** Classify only actionable known cases. Unrecognized errors use the bounded default. */
export function toolFailureClass(message: string): ToolFailureClass {
  if (
    /\b(401|403)\b|permission denied|not authorized|forbidden|invalid (?:api )?key|missing credential|configuration error|not configured|invalid argument|validation failed|required field|token (?:expired|revoked)|oauth (?:token )?(?:expired|revoked)|unsupported (?:transport|protocol)|transport not supported|unsupported provider/i.test(
      message,
    )
  ) {
    return "nontransient";
  }
  if (
    /\b(408|425|429|500|502|503|504)\b|timeout|timed out|temporar(?:y|ily)|unavailable|connection reset|network error|try again/i.test(
      message,
    )
  ) {
    return "transient";
  }
  return "unknown";
}

/** Run-local tracking. A successful equivalent call clears prior failures. */
const MAX_TRACKED_RUNS = 1_000;
const MAX_FAILURES_PER_RUN = 256;
const RUN_RETENTION_MS = 60 * 60 * 1_000;
const toolProgressByRun = new Map<string, { guard: ToolProgressGuard; touchedAt: number }>();

export function toolProgressForRun(runId: string): ToolProgressGuard {
  const now = Date.now();
  for (const [key, value] of toolProgressByRun) {
    if (now - value.touchedAt > RUN_RETENTION_MS) toolProgressByRun.delete(key);
  }
  const existing = toolProgressByRun.get(runId);
  if (existing) {
    existing.touchedAt = now;
    toolProgressByRun.delete(runId);
    toolProgressByRun.set(runId, existing);
    return existing.guard;
  }
  while (toolProgressByRun.size >= MAX_TRACKED_RUNS) {
    const oldest = toolProgressByRun.keys().next().value;
    if (oldest === undefined) break;
    toolProgressByRun.delete(oldest);
  }
  const guard = new ToolProgressGuard();
  toolProgressByRun.set(runId, { guard, touchedAt: now });
  return guard;
}

export function releaseToolProgress(runId: string, keepForResume: boolean): void {
  if (!keepForResume) toolProgressByRun.delete(runId);
  else {
    const retained = toolProgressByRun.get(runId);
    if (retained) retained.touchedAt = Date.now();
  }
}

export class ToolProgressGuard {
  private readonly failures = new Map<string, { count: number; kind: ToolFailureClass }>();

  fingerprint(toolName: string, args: unknown): string {
    return `${toolName}\u0000${canonical(args)}`;
  }

  recordFailure(fingerprint: string, kind: ToolFailureClass): void {
    const previous = this.failures.get(fingerprint);
    if (!previous && this.failures.size >= MAX_FAILURES_PER_RUN) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    this.failures.set(fingerprint, {
      count: (previous?.count ?? 0) + 1,
      // A non-transient diagnosis must not be weakened by a later generic error.
      kind: previous?.kind === "nontransient" || kind === "nontransient" ? "nontransient" : kind,
    });
  }

  recordSuccess(fingerprint: string): void {
    this.failures.delete(fingerprint);
  }

  evidence(fingerprint: string, toolName: string): NoProgressEvidence | undefined {
    const failure = this.failures.get(fingerprint);
    if (!failure || failure.count < MAX_FAILED_ATTEMPTS[failure.kind]) return undefined;
    return {
      code: "repeated_equivalent_failure",
      toolName,
      failureClass: failure.kind,
      failedAttempts: failure.count,
      recoveryStep:
        failure.kind === "transient"
          ? "Check service availability or wait for the outage to clear, then retry in a new request."
          : "Correct the reported permission, configuration, or input problem before making a new request.",
    };
  }

  isBlocked(fingerprint: string): boolean {
    return this.evidence(fingerprint, "") !== undefined;
  }

  blockedMessage(toolName: string): string {
    return `Stopped repeating failed ${toolName} calls. Take a new recovery step: correct the reported permission, configuration, or input issue; for a transient failure, verify the service is available before trying again.`;
  }
}
