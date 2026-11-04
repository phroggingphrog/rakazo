// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../RoutineSchedule", () => ({ RoutineSchedule: () => <div>Schedule controls</div> }));
vi.mock("../../lib/local-timezone", () => ({ localTimezone: () => "Australia/Melbourne" }));

const { EmailMonitorSetup } = await import("./email-monitor-setup");

const server = { id: "server-1", name: "Mail", enabled: true, transport: "http", revision: 3 };
const draft = {
  kind: "email_monitor",
  purpose: "Find appointment updates",
  botId: "bot-1",
  source: { serverId: "server-1", revision: 3, toolName: "read_mail" },
  schedule: { cron: "0 9 * * *", timezone: "Australia/Melbourne" },
  notify: true,
};
const plan = {
  id: "plan-1",
  revision: 1,
  status: "draft",
  routineId: null,
  draft,
  sourceAccess: "not_verified",
  botAssignment: "not_checked",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const prerequisites = {
  planRevision: 1,
  bot: "available",
  source: "available",
  assignment: "configured",
  selectedTool: "allowed",
  operation: "not_verified",
  sourceAccess: "not_verified",
};
const catalog = {
  status: "ok",
  revision: 3,
  tools: [{ name: "read_mail", description: "Read", inputSchema: {} }],
};
const candidates = {
  planRevision: 1,
  sourceRevision: 3,
  status: "ok",
  selectedOperation: "declared_read",
  tools: catalog.tools,
  sourceAccess: "not_verified",
  read: "not_performed",
};
let container: HTMLDivElement;
let root: Root;
const onOpenIntegrations = vi.fn();
const rpc = {
  me: vi.fn(),
  mcp: { servers: { list: vi.fn(), monitorTools: vi.fn() } },
  setupPlans: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    prerequisites: vi.fn(),
    discoverCandidates: vi.fn(),
    propose: vi.fn(),
    configure: vi.fn(),
    preparedTest: vi.fn(),
    prepareTest: vi.fn(),
  },
  routines: { testRun: vi.fn(), history: vi.fn(), list: vi.fn(), update: vi.fn() },
};

function button(text: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}
function change(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.clearAllMocks();
  rpc.mcp.servers.list.mockResolvedValue([server]);
  rpc.me.mockResolvedValue({ userId: "owner-1", spaceId: "space-1" });
  rpc.setupPlans.preparedTest.mockResolvedValue(null);
  rpc.routines.testRun.mockResolvedValue({ runId: "run-1" });
  rpc.routines.history.mockResolvedValue({ runs: [], nextCursor: null });
  rpc.routines.list.mockResolvedValue([{ id: "routine-1", active: false }]);
  rpc.routines.update.mockImplementation(async ({ active }) => ({ id: "routine-1", active }));
  rpc.mcp.servers.monitorTools.mockResolvedValue(catalog);
  rpc.setupPlans.list.mockResolvedValue({ plans: [], nextCursor: null });
  rpc.setupPlans.create.mockResolvedValue(plan);
  rpc.setupPlans.update.mockResolvedValue({ ...plan, revision: 2 });
  rpc.setupPlans.prerequisites.mockResolvedValue(prerequisites);
  rpc.setupPlans.discoverCandidates.mockResolvedValue(candidates);
  rpc.setupPlans.propose.mockResolvedValue({ ...plan, status: "proposed", revision: 2 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <EmailMonitorSetup
        botId="bot-1"
        botName="Scout"
        rpc={rpc as unknown as ReturnType<typeof createSpaceRpc>}
        onOpenIntegrations={onOpenIntegrations}
      />,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
});

describe("email monitor setup", () => {
  it("stops automatic retries after a minute and permits manual refresh", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    rpc.routines.history.mockRejectedValue(new Error("offline"));
    vi.useFakeTimers();
    await click("Run test");
    await act(async () => vi.advanceTimersByTimeAsync(90000));
    expect(rpc.routines.history).toHaveBeenCalledTimes(21);
    rpc.routines.history.mockResolvedValueOnce({
      runs: [{ id: "run-1", status: "completed", sourceTest: "succeeded" }],
    });
    await click("Refresh status");
    expect(container.textContent).toContain("Source test: Succeeded");
  });
  it("resumes polling a restored running test and stops on completion", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    rpc.routines.history
      .mockResolvedValueOnce({ runs: [{ id: "old", status: "running", sourceTest: "running" }] })
      .mockResolvedValueOnce({
        runs: [{ id: "old", status: "completed", sourceTest: "succeeded" }],
      });
    await click("Set up email monitor");
    vi.useFakeTimers();
    await click("Find appointment updatesConfigured");
    expect(container.textContent).toContain("Source test: Running");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("Source test: Succeeded");
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(rpc.routines.history).toHaveBeenCalledTimes(2);
    expect(rpc.routines.testRun).not.toHaveBeenCalled();
  });
  it("ignores an in-flight automatic check after switching to a new proposal", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    let resolvePoll!: (value: {
      runs: { id: string; status: string; sourceTest: string }[];
    }) => void;
    rpc.routines.history
      .mockResolvedValueOnce({ runs: [] })
      .mockImplementationOnce(() => new Promise((resolve) => (resolvePoll = resolve)));
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    vi.useFakeTimers();
    await click("Run test");
    await act(async () => vi.advanceTimersByTime(3000));
    await click("New proposal");
    await act(async () =>
      resolvePoll({ runs: [{ id: "run-1", status: "completed", sourceTest: "succeeded" }] }),
    );
    expect(container.textContent).not.toContain("Source test: Succeeded");
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(rpc.routines.history).toHaveBeenCalledTimes(2);
  });
  it("keeps a newer manual result when an automatic check returns late", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    let resolvePoll!: (value: {
      runs: { id: string; status: string; sourceTest: string }[];
    }) => void;
    rpc.routines.history
      .mockImplementationOnce(() => new Promise((resolve) => (resolvePoll = resolve)))
      .mockResolvedValueOnce({
        runs: [{ id: "run-1", status: "completed", sourceTest: "succeeded" }],
      });
    vi.useFakeTimers();
    await click("Run test");
    await act(async () => vi.advanceTimersByTime(3000));
    await click("Refresh status");
    await act(async () =>
      resolvePoll({ runs: [{ id: "run-1", status: "running", sourceTest: "running" }] }),
    );
    expect(container.textContent).toContain("Source test: Succeeded");
    expect(container.textContent).not.toContain("Source test: Running");
  });
  it("restores a flagged unbound source without claiming the source was verified", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    rpc.routines.history.mockResolvedValue({
      runs: [{ id: "old", status: "completed", sourceTest: "not_started", sourceUnbound: true }],
      nextCursor: null,
    });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    expect(container.textContent).toContain("Source test: Setup changed; source not verified");
    expect(rpc.routines.testRun).not.toHaveBeenCalled();
  });
  it("restores the latest explicit source test as historical, without starting a test", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    rpc.routines.history.mockResolvedValue({
      runs: [
        { id: "normal", status: "completed" },
        { id: "old-test", status: "completed", sourceTest: "succeeded" },
      ],
      nextCursor: null,
    });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    expect(rpc.routines.history).toHaveBeenCalledWith({ routineId: "routine-1", limit: 20 });
    expect(container.textContent).toContain("Source test: Succeeded");
    expect(container.textContent).toContain("It reflects the setup when that test ran.");
    expect(rpc.routines.testRun).not.toHaveBeenCalled();
    await click("Find appointment updatesConfigured");
    expect(container.textContent).toContain("Source test: Succeeded");
    expect(rpc.routines.history).toHaveBeenCalledTimes(2);
  });
  it("does not display an old history response after a new test starts", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    let resolve!: (value: {
      runs: { id: string; status: string; sourceTest: string }[];
      nextCursor: null;
    }) => void;
    rpc.routines.history.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    await click("Run test");
    await act(async () =>
      resolve({
        runs: [{ id: "old", status: "completed", sourceTest: "succeeded" }],
        nextCursor: null,
      }),
    );
    expect(container.textContent).toContain("Source test: Not checked");
    expect(container.textContent).not.toContain("Source test: Succeeded");
  });
  it("ignores a previous plan's history after starting a new proposal", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    let resolve!: (value: {
      runs: { id: string; status: string; sourceTest: string }[];
      nextCursor: null;
    }) => void;
    rpc.routines.history.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    await click("New proposal");
    await act(async () =>
      resolve({
        runs: [{ id: "old", status: "completed", sourceTest: "succeeded" }],
        nextCursor: null,
      }),
    );
    expect(container.textContent).not.toContain("Source test: Succeeded");
    expect(rpc.routines.testRun).not.toHaveBeenCalled();
  });
  it("offers enabled local integrations for setup", async () => {
    rpc.mcp.servers.list.mockResolvedValue([
      { ...server, id: "local-1", name: "Local mail", transport: "stdio" },
      { ...server, id: "local-2", name: "Disabled local", transport: "stdio", enabled: false },
    ]);
    await click("Set up email monitor");
    expect(container.textContent).toContain("Local mail");
    expect(container.textContent).not.toContain("Disabled local");
  });
  it("lets the owner activate and pause the routine without claiming a verified test", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    await click("Activate routine");
    expect(rpc.routines.update).toHaveBeenCalledWith({ routineId: "routine-1", active: true });
    expect(container.textContent).toContain("Active");
    expect(rpc.routines.testRun).not.toHaveBeenCalled();
    await click("Pause routine");
    expect(rpc.routines.update).toHaveBeenLastCalledWith({ routineId: "routine-1", active: false });
    expect(container.textContent).toContain("Paused");
    expect(container.textContent).toContain("This setup is saved. Its routine status");
    expect(container.textContent).not.toContain(
      "This saves a proposal. It does not start a routine",
    );
  });
  it("starts only on request and reuses the owner-scoped nonce after a lost response and remount", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    rpc.setupPlans.list.mockResolvedValue({ plans: [configured], nextCursor: null });
    rpc.routines.testRun
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({ runId: "run-1" });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    expect(rpc.routines.testRun).not.toHaveBeenCalled();
    await click("Run test");
    const first = rpc.routines.testRun.mock.calls[0]![0];
    expect(
      window.localStorage.getItem(
        `rakazo:monitor-test:${JSON.stringify(["owner-1", "space-1", "plan-1", 3])}`,
      ),
    ).toBe(first.clientNonce);
    act(() => root.unmount());
    root = createRoot(container);
    act(() =>
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          rpc={rpc as unknown as ReturnType<typeof createSpaceRpc>}
          onOpenIntegrations={onOpenIntegrations}
        />,
      ),
    );
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    await click("Run test");
    expect(rpc.routines.testRun.mock.calls[1]![0]).toEqual(first);
    expect(container.textContent).toContain("Run status:");
    expect(container.textContent).toContain("Source test: Not checked");
    expect(container.textContent).toContain("not checked");
    expect(container.textContent).toContain("A test does not confirm notification delivery");
  });

  it.each([
    ["not_started", "Not started"],
    ["pending", "Pending"],
    ["running", "Running"],
    ["succeeded", "Succeeded"],
    ["failed", "Failed"],
    ["uncertain", "Uncertain"],
    ["unbound", "Setup changed; source not verified"],
    [undefined, "Unavailable for this run"],
  ])("shows the source-test state %s separately from the run", async (sourceTest, label) => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    rpc.setupPlans.list.mockResolvedValue({ plans: [configured], nextCursor: null });
    rpc.routines.history.mockResolvedValue({
      runs: [
        {
          id: "run-1",
          status: "completed",
          sourceTest: sourceTest === "unbound" ? "not_started" : sourceTest,
          sourceUnbound: sourceTest === "unbound",
        },
      ],
      nextCursor: null,
    });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    await click("Run test");
    await click("Refresh status");
    expect(container.textContent).toContain("Run status: completed");
    expect(container.textContent).toContain(`Source test: ${label}`);
    if (sourceTest === "failed")
      expect(container.textContent).toContain(
        "If the integration changed, choose New proposal and set it up again.",
      );
    expect(container.textContent).toContain(
      "Arguments are not validated against the operation schema here",
    );
    expect(container.textContent).not.toContain("validated against the operation or tested");
    expect(container.textContent).toContain("A test does not confirm notification delivery");
  });

  it("does not offer a test when its routine no longer exists", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: null }],
      nextCursor: null,
    });
    rpc.setupPlans.preparedTest.mockResolvedValue({
      id: "attempt",
      planId: plan.id,
      planRevision: 2,
      taskId: null,
      status: "prepared",
      execution: "not_started",
      sourceAccess: "not_verified",
      createdAt: plan.createdAt,
    });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    expect(container.textContent).toContain("The routine is unavailable, so a test cannot run");
    expect(
      [...container.querySelectorAll("button")].some((node) => node.textContent === "Run test"),
    ).toBe(false);
  });

  it("does not start a test if the retry key cannot be stored", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    try {
      await click("Run test");
      expect(rpc.routines.testRun).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    } finally {
      storage.mockRestore();
    }
  });

  it("does not reuse a test nonce from another owner", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    rpc.setupPlans.list.mockResolvedValue({ plans: [configured], nextCursor: null });
    rpc.routines.testRun.mockRejectedValue(new Error("connection lost"));
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    await click("Run test");
    rpc.me.mockResolvedValue({ userId: "owner-2", spaceId: "space-1" });
    await click("Run test");
    expect(rpc.routines.testRun.mock.calls[0]![0].clientNonce).not.toBe(
      rpc.routines.testRun.mock.calls[1]![0].clientNonce,
    );
  });

  it("does not require an old prepared draft before offering a test", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", revision: 3, routineId: "routine-1" }],
      nextCursor: null,
    });
    rpc.setupPlans.preparedTest
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(null);
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    expect(button("Run test")).toBeTruthy();
    expect(rpc.setupPlans.preparedTest).not.toHaveBeenCalled();
    expect(rpc.routines.testRun).not.toHaveBeenCalled();
  });
  it("saves and checks a proposal without claiming a mailbox read or activation", async () => {
    await click("Set up email monitor");
    expect(container.textContent).toContain("does not start a routine");
    await act(async () => {
      change(container.querySelector("textarea")!, draft.purpose);
    });
    await act(async () => {
      change(container.querySelector("select")!, "server-1");
    });
    await click("Find read operations");
    expect(rpc.mcp.servers.monitorTools).toHaveBeenCalledWith({ id: "server-1", botId: "bot-1" });
    await act(async () => {
      change(container.querySelectorAll("select")[1]!, "read_mail");
    });
    await click("Save draft");
    expect(rpc.setupPlans.create).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({ purpose: draft.purpose, source: draft.source }),
        requestKey: expect.any(String),
      }),
    );
    expect(button("Save proposal").disabled).toBe(true);
    await click("Check setup");
    expect(rpc.setupPlans.discoverCandidates).toHaveBeenCalledWith({
      id: "plan-1",
      expectedRevision: 1,
    });
    expect(container.textContent).toContain(
      "Mailbox access and permissions have not been verified",
    );
    expect(container.textContent).toContain("No read was performed");
    expect(button("Save proposal").disabled).toBe(false);
    await click("Save proposal");
    expect(rpc.setupPlans.propose).toHaveBeenCalledWith({ id: "plan-1", expectedRevision: 1 });
    expect(container.textContent).toContain("Proposal saved");
    expect(container.textContent).not.toContain("Active");
  });

  it("accepts reviewed argument JSON and rejects malformed input before saving", async () => {
    rpc.mcp.servers.monitorTools.mockResolvedValue({
      ...catalog,
      tools: [
        {
          name: "read_mail",
          description: "Read",
          inputSchema: { properties: { pageToken: { type: "string" } }, required: ["pageToken"] },
        },
      ],
    });
    await click("Set up email monitor");
    await act(async () => {
      change(container.querySelector("textarea")!, draft.purpose);
    });
    await act(async () => {
      change(container.querySelector("select")!, "server-1");
    });
    await click("Find read operations");
    await act(async () => {
      change(container.querySelectorAll("select")[1]!, "read_mail");
    });
    expect(container.textContent).toContain("Declared required fields: pageToken");
    const input = container.querySelector<HTMLTextAreaElement>('textarea[id$="-arguments"]')!;
    await act(async () => {
      change(input, "[");
    });
    await click("Save draft");
    expect(rpc.setupPlans.create).not.toHaveBeenCalled();
    await act(async () => {
      change(input, '{"pageToken":"cursor"}');
    });
    await click("Save draft");
    expect(rpc.setupPlans.create).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({ arguments: { pageToken: "cursor" } }),
      }),
    );
  });

  it("does not claim readiness or discover when the integration is not assigned", async () => {
    rpc.setupPlans.list.mockResolvedValue({ plans: [plan], nextCursor: null });
    rpc.setupPlans.prerequisites.mockResolvedValue({
      ...prerequisites,
      assignment: "not_configured",
    });
    await click("Set up email monitor");
    await click("Find appointment updatesDraft");
    await click("Check setup");
    expect(container.textContent).toContain("Not configured");
    expect(rpc.setupPlans.discoverCandidates).not.toHaveBeenCalled();
    expect(button("Save proposal").disabled).toBe(true);
  });

  it("does not discover an operation denied by the bot's assignment", async () => {
    rpc.setupPlans.list.mockResolvedValue({ plans: [plan], nextCursor: null });
    rpc.setupPlans.prerequisites.mockResolvedValue({ ...prerequisites, selectedTool: "blocked" });
    await click("Set up email monitor");
    await click("Find appointment updatesDraft");
    await click("Check setup");
    expect(container.textContent).toContain("Not allowed in bot settings");
    expect(rpc.setupPlans.discoverCandidates).not.toHaveBeenCalled();
    expect(button("Save proposal").disabled).toBe(true);
  });

  it("preserves a saved notification preference when editing the draft", async () => {
    const saved = { ...plan, draft: { ...draft, notify: false } };
    rpc.setupPlans.list.mockResolvedValue({ plans: [saved], nextCursor: null });
    rpc.setupPlans.update.mockResolvedValue({ ...saved, revision: 2 });
    await click("Set up email monitor");
    await click("Find appointment updatesDraft");
    await act(async () => {
      change(container.querySelector("textarea")!, "Look for updates");
    });
    await click("Save draft");
    expect(rpc.setupPlans.update).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({ notify: false }),
      }),
    );
  });

  it("creates a paused routine only after a fresh check and reuses the key on an uncertain retry", async () => {
    const proposed = { ...plan, status: "proposed", revision: 2 };
    rpc.setupPlans.list.mockResolvedValue({ plans: [proposed], nextCursor: null });
    rpc.setupPlans.prerequisites.mockResolvedValue({ ...prerequisites, planRevision: 2 });
    rpc.setupPlans.discoverCandidates.mockResolvedValue({ ...candidates, planRevision: 2 });
    rpc.setupPlans.configure.mockRejectedValueOnce(new Error("connection lost"));
    rpc.setupPlans.configure.mockResolvedValueOnce({
      ...proposed,
      status: "configured",
      revision: 3,
      routineId: "routine-1",
    });
    await click("Set up email monitor");
    await click("Find appointment updatesProposed");
    expect(button("Create paused routine").disabled).toBe(true);
    await click("Check setup");
    expect(button("Create paused routine").disabled).toBe(false);
    await click("Create paused routine");
    await click("Create paused routine");
    expect(rpc.setupPlans.configure).toHaveBeenCalledTimes(2);
    expect(rpc.setupPlans.configure.mock.calls[0]).toEqual(rpc.setupPlans.configure.mock.calls[1]);
    expect(rpc.setupPlans.configure).toHaveBeenCalledWith({
      id: "plan-1",
      expectedRevision: 2,
      requestKey: expect.any(String),
    });
    expect(container.textContent).toContain("Paused");
    expect(container.textContent).toContain(
      "When setup matches the routine, a source check attempts the selected operation",
    );
    expect(container.textContent).not.toContain("Active");
    await click("New proposal");
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(container.textContent).toContain("This saves a proposal. It does not start a routine");
  });

  it("does not claim a linked routine exists after it was removed", async () => {
    rpc.setupPlans.list.mockResolvedValue({
      plans: [{ ...plan, status: "configured", routineId: null }],
      nextCursor: null,
    });
    await click("Set up email monitor");
    await click("Find appointment updatesConfigured");
    expect(container.textContent).toContain("Routine no longer exists");
    expect(container.textContent).not.toContain("Created paused");
    await click("Manage integrations");
    expect(onOpenIntegrations).toHaveBeenCalledOnce();
    await click("Refresh integrations");
    expect(rpc.mcp.servers.list).toHaveBeenCalledTimes(2);
  });

  it("does not repeat an uncertain create with changed content", async () => {
    rpc.setupPlans.create.mockRejectedValue(new Error("connection lost"));
    await click("Set up email monitor");
    await act(async () => {
      change(container.querySelector("textarea")!, draft.purpose);
    });
    await act(async () => {
      change(container.querySelector("select")!, "server-1");
    });
    await click("Find read operations");
    await act(async () => {
      change(container.querySelectorAll("select")[1]!, "read_mail");
    });
    await click("Save draft");
    await act(async () => {
      change(container.querySelector("textarea")!, "A different purpose");
    });
    await click("Save draft");
    expect(rpc.setupPlans.create).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("previous save may have completed");
  });

  it("keeps the creation key after a lost response and remount", async () => {
    rpc.setupPlans.create.mockRejectedValueOnce(new Error("connection lost"));
    await click("Set up email monitor");
    await act(async () => {
      change(container.querySelector("textarea")!, draft.purpose);
    });
    await act(async () => {
      change(container.querySelector("select")!, "server-1");
    });
    await click("Find read operations");
    await act(async () => {
      change(container.querySelectorAll("select")[1]!, "read_mail");
    });
    await click("Save draft");
    const firstKey = rpc.setupPlans.create.mock.calls[0]![0].requestKey;
    act(() => root.unmount());
    root = createRoot(container);
    act(() =>
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          rpc={rpc as unknown as ReturnType<typeof createSpaceRpc>}
          onOpenIntegrations={onOpenIntegrations}
        />,
      ),
    );
    await click("Set up email monitor");
    await act(async () => {
      change(container.querySelector("textarea")!, draft.purpose);
    });
    await act(async () => {
      change(container.querySelector("select")!, "server-1");
    });
    await click("Find read operations");
    await act(async () => {
      change(container.querySelectorAll("select")[1]!, "read_mail");
    });
    await click("Save draft");
    expect(rpc.setupPlans.create.mock.calls[1]![0].requestKey).toBe(firstKey);
    expect(window.sessionStorage.length).toBe(0);
  });
});
