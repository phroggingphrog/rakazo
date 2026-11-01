import { createHash, randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { proactiveJob, runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type {
  Judge,
  PgExecutor,
  PgQueryable,
  ProactiveConfig,
  Scheduler,
  Wake,
  WakeTarget,
} from "@rakazo/proactive";
import { PgProactiveStore, ProactiveEngine } from "@rakazo/proactive";

type ModelPin = { modelProvider: string; modelId: string; thinkingLevel: string | null };

/** What the webhook route puts in `ProactiveEvent.raw`: the finished prompt, ready to send. */
export interface WebhookEventRaw {
  prompt: string;
  modelPin?: ModelPin;
}

/** Scope for everything a bot is woken for. Tenants never share a scope. */
export const botScope = (botId: string) => `bot:${botId}`;

function botIdFromScope(scope: string): string | null {
  return scope.startsWith("bot:") ? scope.slice(4) : null;
}

const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

/** Runs the store's SQL through Prisma. A throw inside `transaction` rolls it back. */
export function prismaExecutor(prisma: PrismaClient): PgExecutor {
  const run =
    (db: Pick<PrismaClient, "$queryRawUnsafe">): PgQueryable["query"] =>
    async (text, params = []) => ({
      rows: (await db.$queryRawUnsafe(text, ...params)) as Record<string, unknown>[],
    });
  return {
    query: run(prisma),
    transaction: (fn) => prisma.$transaction(async (tx) => fn({ query: run(tx) })),
  };
}

/** The proactive core's delayed jobs, carried by Rakazo's background job queue. */
export class JobScheduler implements Scheduler {
  constructor(private readonly jobs: Pick<JobPublisher, "enqueue" | "cancel">) {}

  schedule(job: Parameters<Scheduler["schedule"]>[0]): Promise<void> {
    return this.jobs.enqueue(proactiveJob(job.name, job.key, new Date(job.runAt)));
  }

  cancel(key: string): Promise<void> {
    return this.jobs.cancel(`proactive:${key}`);
  }
}

function combinePrompts(events: Wake["events"]): { prompt: string; modelPin?: ModelPin } {
  const raws = events.map((e) => e.raw as WebhookEventRaw | undefined);
  const prompts = raws.map((r, i) => r?.prompt ?? events[i]?.text ?? "");
  const modelPin = [...raws].reverse().find((r) => r?.modelPin)?.modelPin;
  const prompt =
    prompts.length === 1
      ? (prompts[0] ?? "")
      : [
          `${prompts.length} events arrived together, oldest first:`,
          ...prompts.map((p, i) => `--- event ${i + 1} ---\n${p}`),
        ].join("\n\n");
  return { prompt, ...(modelPin ? { modelPin } : {}) };
}

/** Wakes a bot by sending its thread a webhook message and starting a run, like a direct delivery. */
export class RakazoWakeTarget implements WakeTarget {
  readonly name = "rakazo-bot";

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      events: Pick<ThreadEvents, "sendUserMessage">;
      jobs: Pick<JobPublisher, "enqueue">;
    },
  ) {}

  async isWorking(): Promise<boolean> {
    return false;
  }

  async responsibilities(): Promise<string> {
    return "Act on events delivered to this bot: webhooks, timers and other sources.";
  }

  async deliver(wake: Wake): Promise<{ ref: string }> {
    const botId = botIdFromScope(wake.scope);
    const bot = botId
      ? await runAsSystem("find the bot a proactive wake is for", () =>
          this.deps.prisma.bot.findUnique({
            where: { id: botId, archivedAt: null },
            select: { id: true, spaceId: true, userId: true, thread: { select: { id: true } } },
          }),
        )
      : null;
    // A deleted or archived bot has nothing to wake; report it handed over so it stops retrying.
    if (!bot?.thread) return { ref: "bot-gone" };
    const threadId = bot.thread.id;
    const { prompt, modelPin } = combinePrompts(wake.events);
    const sent = await runAsTenant({ spaceId: bot.spaceId, userId: bot.userId }, () =>
      this.deps.events.sendUserMessage({
        spaceId: bot.spaceId,
        threadId,
        botId: bot.id,
        userId: bot.userId,
        blocks: [{ kind: "text", text: prompt }],
        prompt,
        trigger: "webhook",
        // One wake id, one message: a redelivery finds the first and starts nothing new.
        clientNonce: `proactive:${bot.id}:${hash(wake.id)}`,
        ...(modelPin ? { modelPin } : {}),
      }),
    );
    if (sent.runId) {
      await this.deps.jobs.enqueue(runContinueJob(sent.runId));
    }
    return { ref: sent.runId ?? sent.messageId };
  }
}

export interface ProactiveRuntimeDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage">;
  jobs: Pick<JobPublisher, "enqueue" | "cancel">;
  judge?: Judge;
  config?: Partial<ProactiveConfig>;
  /** Bot ids that use the proactive path; "*" means all. Empty means none. */
  enabledBots?: string;
}

/** Everything the API route and the job handlers need, built from the same parts. */
export function createProactiveRuntime(deps: ProactiveRuntimeDeps) {
  const engine = new ProactiveEngine({
    store: new PgProactiveStore(prismaExecutor(deps.prisma)),
    scheduler: new JobScheduler(deps.jobs),
    target: new RakazoWakeTarget(deps),
    ...(deps.judge ? { judge: deps.judge } : {}),
    config: deps.config,
    onError: (where, error) => getLogger().error(`proactive ${where}`, error),
    trace: (step, fields) => getLogger().info(`proactive ${step}`, fields),
  });
  const enabled = new Set(
    (deps.enabledBots ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const system = <T>(reason: string, fn: () => Promise<T>) => runAsSystem(reason, fn);

  return {
    engine,
    /** Whether this bot's webhooks go through the proactive core. */
    enabledFor: (botId: string) => enabled.has("*") || enabled.has(botId),
    /** Webhook source adapter: turn one delivery into an event. */
    async receiveWebhook(input: {
      botId: string;
      /** The sender's idempotency key. Without one every delivery is its own event. */
      deliveryKey?: string;
      prompt: string;
      modelPin?: ModelPin;
    }) {
      const id = input.deliveryKey ? hash(input.deliveryKey) : randomUUID();
      const raw: WebhookEventRaw = {
        prompt: input.prompt,
        ...(input.modelPin ? { modelPin: input.modelPin } : {}),
      };
      return system("store a proactive webhook event", () =>
        engine.receive({
          source: `webhook:${input.botId}`,
          id,
          kind: "webhook",
          at: Date.now(),
          scope: botScope(input.botId),
          text: input.prompt,
          addressed: "mention",
          raw,
        }),
      );
    },
    /** Job handlers for the four proactive job names. */
    handlers: {
      apply: (scope: string) => system("apply proactive events", () => engine.apply(scope)),
      decide: (scope: string) => system("decide a proactive group", () => engine.decide(scope)),
      redeliver: () => system("redeliver proactive wakes", () => engine.redeliver()),
      timers: () => system("fire proactive timers", () => engine.fireTimers()),
    },
    /** Reconciler pass: finish whatever a crash left half done. */
    async reconcile(): Promise<void> {
      await system("recover proactive events", async () => {
        await engine.recover();
        await engine.redeliver();
        await engine.fireTimers();
      });
    },
  };
}

export type ProactiveRuntime = ReturnType<typeof createProactiveRuntime>;
