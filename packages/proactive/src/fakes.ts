import type { ProactiveEngine } from "./engine.js";
import type { Clock, EffectSink, Judge, ScheduledJobName, Scheduler, WakeTarget } from "./ports.js";
import type { DeliveryRef, EffectResult, JudgeInput, JudgeResult, Millis, Wake } from "./types.js";

/** Time only moves when a test moves it. `sleep` advances the clock instead of waiting. */
export class FakeClock implements Clock {
  constructor(public t: Millis = 1_000_000) {}
  now(): Millis {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

interface FakeJob {
  name: ScheduledJobName;
  key: string;
  runAt: Millis;
}

/** Keyed delayed jobs with replace-on-repeat, like Graphile Worker's `jobKey`. */
export class FakeScheduler implements Scheduler {
  readonly jobs = new Map<string, FakeJob>();
  /** Set to make `schedule` fail, as a database blip would. */
  failNext = 0;
  constructor(private readonly clock: FakeClock) {}

  async schedule(job: FakeJob): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("scheduler unavailable");
    }
    this.jobs.set(job.key, { ...job });
  }

  async cancel(key: string): Promise<void> {
    this.jobs.delete(key);
  }

  /** Run the earliest job, moving the clock to its time. False when none is left. */
  async runNext(engine: ProactiveEngine): Promise<boolean> {
    const next = [...this.jobs.values()].sort((a, b) => a.runAt - b.runAt)[0];
    if (!next) return false;
    this.jobs.delete(next.key);
    if (next.runAt > this.clock.t) this.clock.t = next.runAt;
    const scope = next.key.slice(next.key.indexOf(":") + 1);
    if (next.name === "apply") await engine.apply(scope);
    else if (next.name === "decide") await engine.decide(scope);
    else if (next.name === "timers") await engine.fireTimers();
    else await engine.redeliver();
    return true;
  }

  /** Run jobs until none is due by `until`. */
  async runUntil(engine: ProactiveEngine, until: Millis, maxSteps = 500): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      const next = [...this.jobs.values()].sort((a, b) => a.runAt - b.runAt)[0];
      if (!next || next.runAt > until) break;
      await this.runNext(engine);
    }
    if (this.clock.t < until) this.clock.t = until;
  }
}

export class FakeTarget implements WakeTarget {
  readonly name = "fake";
  readonly working = new Set<string>();
  /** Every deliver call, including repeats. */
  readonly calls: Wake[] = [];
  /** Distinct wake ids the target counted, like a requestId. */
  readonly accepted = new Map<string, Wake>();
  failNext = 0;
  /** Throw after counting the wake, as a crash between hand-over and confirmation does. */
  crashAfterAcceptNext = 0;

  async isWorking(scope: string): Promise<boolean> {
    return this.working.has(scope);
  }
  async responsibilities(): Promise<string> {
    return "test target";
  }
  async deliver(wake: Wake): Promise<DeliveryRef> {
    this.calls.push(wake);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("target down");
    }
    if (!this.accepted.has(wake.id)) this.accepted.set(wake.id, wake);
    if (this.crashAfterAcceptNext > 0) {
      this.crashAfterAcceptNext--;
      throw new Error("crash after accept");
    }
    return { ref: wake.id };
  }
}

export class FakeJudge implements Judge {
  readonly version = "fake-1";
  calls = 0;
  constructor(private readonly answer: (input: JudgeInput) => number | Error) {}
  async judge(input: JudgeInput): Promise<JudgeResult> {
    this.calls++;
    const r = this.answer(input);
    if (r instanceof Error) throw r;
    return { probability: r };
  }
}

/** A platform that records what it was sent and can find a send by id. */
export class FakeSink implements EffectSink {
  readonly name = "fake-sink";
  /** What actually reached the outside, keyed by send id. */
  readonly delivered: string[] = [];
  /** Crash after the platform has the message but before the engine records it. */
  crashAfterSendNext = 0;
  private n = 0;

  async send(sendId: string, _to: string, _payload: unknown): Promise<EffectResult> {
    const externalId = `m${++this.n}`;
    this.delivered.push(sendId);
    if (this.crashAfterSendNext > 0) {
      this.crashAfterSendNext--;
      throw new Error("crash after send");
    }
    return { externalId };
  }
  async findSent(_to: string, sendId: string): Promise<EffectResult | undefined> {
    const i = this.delivered.indexOf(sendId);
    return i === -1 ? undefined : { externalId: `found-${i}` };
  }
}
