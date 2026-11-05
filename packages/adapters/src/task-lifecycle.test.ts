import { describe, expect, it } from "vitest";
import { taskLifecycle } from "./task-lifecycle.js";
describe("compatible task lifecycle", () => {
  it("distinguishes pending approval from ordinary user input", () => {
    expect(taskLifecycle({status:"waiting_input"})).toBe("waiting_for_external_dependency");
    expect(taskLifecycle({status:"waiting_input"}, true)).toBe("waiting_for_approval");
  });
  it("projects durable delayed retries without changing persisted status", () => {
    expect(taskLifecycle({status:"queued",wakeAt:new Date(), attemptCount: 1})).toBe("retrying");
    expect(taskLifecycle({status:"queued",wakeAt:new Date(), attemptCount: 0})).toBe("queued");
    expect(taskLifecycle({status:"queued",wakeAt:new Date()})).toBe("queued");
    expect(taskLifecycle({status:"queued"})).toBe("queued");
  });
  it.each(["completed","failed","cancelled"])("terminal %s overrides stale flags", (status) => {
    expect(taskLifecycle({status},true,true)).toBe(status);
  });
});
