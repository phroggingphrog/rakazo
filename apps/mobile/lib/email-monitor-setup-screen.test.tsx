// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn(), alert: vi.fn() }));
vi.mock("./email-monitor-setup", () => ({ openMonitorSetup: mocks.open }));
vi.mock("./routine", () => ({ deviceTimeZone: () => "Australia/Melbourne" }));
vi.mock("./user-error", () => ({ errorText: (_error: unknown, fallback: string) => fallback }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (value: string, vars: Record<string, string> = {}) =>
      value.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match),
  }),
}));
vi.mock("./native", () => ({
  native: new Proxy({}, { get: (_, key) => String(key) }),
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("@expo/ui/community/datetime-picker", () => ({
  default: ({ onValueChange }: { onValueChange: (_event: unknown, value: Date) => void }) =>
    createElement(
      "button",
      { type: "button", onClick: () => onValueChange({}, new Date(2026, 0, 1, 14, 35)) },
      "Choose time",
    ),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Modal: view,
    View: view,
    ScrollView: view,
    KeyboardAvoidingView: view,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      editable,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      accessibilityLabel: string;
      editable: boolean;
    }) =>
      createElement("textarea", {
        value,
        "aria-label": accessibilityLabel,
        disabled: !editable,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
    Alert: { alert: mocks.alert },
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  };
});
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    value,
    choices,
    onChange,
    disabled,
  }: {
    label: string;
    value: string;
    choices: { key: string; label: string }[];
    onChange: (value: string) => void;
    disabled?: boolean;
  }) =>
    createElement(
      "select",
      {
        "aria-label": label,
        value,
        disabled,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      },
      choices.map((choice) =>
        createElement("option", { key: choice.key, value: choice.key }, choice.label),
      ),
    ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    busy,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    busy?: boolean;
    onPress: () => void;
  }) =>
    createElement(
      "button",
      { type: "button", disabled: disabled || busy, onClick: onPress },
      label,
    ),
}));

const { EmailMonitorSetup } = await import("../components/email-monitor-setup");
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
const checks = {
  planRevision: 1,
  bot: "available",
  source: "available",
  assignment: "configured",
  selectedTool: "allowed",
  operation: "not_verified",
  sourceAccess: "not_verified",
};
const candidates = {
  planRevision: 1,
  sourceRevision: 3,
  status: "ok",
  selectedOperation: "declared_read",
  tools: [],
  sourceAccess: "not_verified",
  read: "not_performed",
};
const session = {
  current: vi.fn(),
  load: vi.fn(),
  discover: vi.fn(),
  grantRead: vi.fn(),
  save: vi.fn(),
  prerequisites: vi.fn(),
  candidates: vi.fn(),
  propose: vi.fn(),
  configure: vi.fn(),
  preparedTest: vi.fn(),
  prepareTest: vi.fn(),
  runTest: vi.fn(),
  testStatus: vi.fn(),
  latestSourceTest: vi.fn(),
  routineState: vi.fn(),
  setRoutineActive: vi.fn(),
};
let root: Root;
let container: HTMLDivElement;
const close = vi.fn();
const openIntegrations = vi.fn();

function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
function input(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}
async function select(label: string, value: string) {
  await act(async () => {
    input(container.querySelector(`select[aria-label="${label}"]`)!, value);
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  session.current.mockReturnValue(true);
  session.preparedTest.mockResolvedValue(null);
  session.runTest.mockResolvedValue({ runId: "run-1" });
  session.testStatus.mockResolvedValue({ runStatus: "completed", sourceTest: "unavailable" });
  session.latestSourceTest.mockResolvedValue(null);
  session.routineState.mockResolvedValue(false);
  session.setRoutineActive.mockImplementation(async (_plan, active) => active);
  session.load.mockResolvedValue({
    servers: [{ id: "server-1", revision: 3, name: "Mail" }],
    plans: [],
    nextCursor: null,
  });
  session.discover.mockResolvedValue({ status: "ok", revision: 3, tools: [{ name: "read_mail" }] });
  session.grantRead.mockResolvedValue({ status: "allowed" });
  session.save.mockResolvedValue(plan);
  session.prerequisites.mockResolvedValue(checks);
  session.candidates.mockResolvedValue(candidates);
  session.propose.mockResolvedValue({ ...plan, status: "proposed", revision: 2 });
  session.configure.mockResolvedValue({
    ...plan,
    status: "configured",
    revision: 3,
    routineId: "routine-1",
  });
  mocks.open.mockResolvedValue(session);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <EmailMonitorSetup
        botId="bot-1"
        botName="Scout"
        onClose={close}
        onOpenIntegrations={openIntegrations}
      />,
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
  vi.unstubAllGlobals();
});

describe("native email monitor proposal", () => {
  it("lets the owner grant only the selected read after preview", async () => {
    await select("Integration", "server-1");
    await click("Find read operations");
    await select("Read operation", "read_mail");
    expect(session.grantRead).not.toHaveBeenCalled();
    await click("Allow selected read");
    expect(session.grantRead).toHaveBeenCalledWith("server-1", 3, "read_mail");
    expect(container.textContent).toContain("Selected read is allowed in bot settings.");
  });
  it("resumes polling a restored running test without starting another", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    session.load.mockResolvedValue({ servers: [], plans: [configured], nextCursor: null });
    session.latestSourceTest.mockResolvedValue({
      runId: "old",
      runStatus: "running",
      sourceTest: "running",
    });
    session.testStatus.mockResolvedValue({ runStatus: "completed", sourceTest: "succeeded" });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    vi.useFakeTimers();
    await select("Saved proposals", "plan-1");
    expect(container.textContent).toContain("Source test: Running");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("Source test: Succeeded");
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(session.testStatus).toHaveBeenCalledTimes(1);
    expect(session.runTest).not.toHaveBeenCalled();
  });
  it("ignores an in-flight automatic check after switching proposals", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    session.load.mockResolvedValue({ servers: [], plans: [configured], nextCursor: null });
    let resolvePoll!: (value: { runStatus: string; sourceTest: string }) => void;
    session.testStatus.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePoll = resolve)),
    );
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    vi.useFakeTimers();
    await click("Run test");
    await act(async () => vi.advanceTimersByTime(3000));
    await click("New proposal");
    await act(async () => resolvePoll({ runStatus: "completed", sourceTest: "succeeded" }));
    expect(container.textContent).not.toContain("Source test: Succeeded");
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(session.testStatus).toHaveBeenCalledTimes(1);
  });
  it("shows a previous source test as historical and ignores a stale session", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    session.load.mockResolvedValue({ servers: [], plans: [configured], nextCursor: null });
    session.latestSourceTest.mockResolvedValue({
      runId: "old",
      runStatus: "completed",
      sourceTest: "succeeded",
    });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    expect(container.textContent).toContain("Source test: Succeeded");
    expect(container.textContent).toContain("It reflects the setup when that test ran.");
    expect(session.runTest).not.toHaveBeenCalled();
    let resolve!: (value: { runId: string; runStatus: string; sourceTest: string }) => void;
    session.latestSourceTest.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await click("New proposal");
    await select("Saved proposals", "plan-1");
    session.current.mockReturnValue(false);
    await act(async () =>
      resolve({ runId: "stale", runStatus: "completed", sourceTest: "succeeded" }),
    );
    expect(container.textContent).not.toContain("Source test: Succeeded");
  });
  it("lets the owner activate and pause without requiring a test", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    session.load.mockResolvedValue({ servers: [], plans: [configured], nextCursor: null });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    await click("Activate routine");
    expect(session.setRoutineActive).toHaveBeenCalledWith(configured, true);
    expect(session.runTest).not.toHaveBeenCalled();
    await click("Pause routine");
    expect(session.setRoutineActive).toHaveBeenLastCalledWith(configured, false);
  });
  it("validates and saves reviewed argument JSON", async () => {
    session.discover.mockResolvedValue({
      status: "ok",
      revision: 3,
      tools: [
        {
          name: "read_mail",
          inputSchema: { properties: { pageToken: { type: "string" } }, required: ["pageToken"] },
        },
      ],
    });
    await act(async () => {
      input(container.querySelector("textarea")!, "Find updates");
    });
    await select("Integration", "server-1");
    await click("Find read operations");
    await select("Read operation", "read_mail");
    expect(container.textContent).toContain("Declared required fields: pageToken");
    const args = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Operation arguments (JSON object)"]',
    )!;
    await act(async () => {
      input(args, "[");
    });
    await click("Save draft");
    expect(session.save).not.toHaveBeenCalled();
    await act(async () => {
      input(args, '{"pageToken":"cursor"}');
    });
    await click("Save draft");
    expect(session.save).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: { pageToken: "cursor" } }),
      null,
    );
  });
  it("starts a test only on request and reports its status", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    session.load.mockResolvedValue({
      servers: [{ id: "server-1", revision: 3, name: "Mail" }],
      plans: [configured],
      nextCursor: null,
    });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    expect(session.runTest).not.toHaveBeenCalled();
    await click("Run test");
    expect(session.runTest).toHaveBeenCalledWith(configured);
    expect(container.textContent).toContain("not checked");
    await click("Refresh status");
    expect(session.testStatus).toHaveBeenCalledWith(configured, "run-1");
    expect(container.textContent).toContain("completed");
    expect(container.textContent).toContain("Source test: Unavailable for this run");
    expect(container.textContent).toContain("A test does not confirm notification delivery");
  });

  it("updates a requested test until it finishes and stops polling", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    session.load.mockResolvedValue({ servers: [], plans: [configured], nextCursor: null });
    session.testStatus
      .mockResolvedValueOnce({ runStatus: "running", sourceTest: "running" })
      .mockResolvedValueOnce({ runStatus: "completed", sourceTest: "succeeded" });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    vi.useFakeTimers();
    await click("Run test");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("Source test: Running");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("Source test: Succeeded");
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(session.testStatus).toHaveBeenCalledTimes(2);
    expect(session.runTest).toHaveBeenCalledTimes(1);
  });

  it("bounds failed automatic checks and leaves manual refresh available", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    session.load.mockResolvedValue({ servers: [], plans: [configured], nextCursor: null });
    session.testStatus.mockRejectedValue(new Error("offline"));
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    vi.useFakeTimers();
    await click("Run test");
    await act(async () => vi.advanceTimersByTimeAsync(90000));
    expect(session.testStatus).toHaveBeenCalledTimes(20);
    session.testStatus.mockResolvedValueOnce({ runStatus: "completed", sourceTest: "succeeded" });
    await click("Refresh status");
    expect(container.textContent).toContain("Source test: Succeeded");
  });

  it("does not replace a newer manual status with a late automatic response", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    session.load.mockResolvedValue({ servers: [], plans: [configured], nextCursor: null });
    let resolvePoll!: (value: { runStatus: string; sourceTest: string }) => void;
    session.testStatus
      .mockImplementationOnce(() => new Promise((resolve) => (resolvePoll = resolve)))
      .mockResolvedValueOnce({ runStatus: "completed", sourceTest: "succeeded" });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    vi.useFakeTimers();
    await click("Run test");
    await act(async () => vi.advanceTimersByTime(3000));
    await click("Refresh status");
    await act(async () => resolvePoll({ runStatus: "running", sourceTest: "running" }));
    expect(container.textContent).toContain("Source test: Succeeded");
    expect(container.textContent).not.toContain("Source test: Running");
  });

  it.each([
    ["not_started", "Not started"],
    ["pending", "Pending"],
    ["running", "Running"],
    ["succeeded", "Succeeded"],
    ["failed", "Failed"],
    ["uncertain", "Uncertain"],
    ["unbound", "Setup changed; source not verified"],
  ])("shows source-test state %s separately from the run", async (sourceTest, label) => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: "routine-1" };
    session.load.mockResolvedValue({
      servers: [{ id: "server-1", revision: 3, name: "Mail" }],
      plans: [configured],
      nextCursor: null,
    });
    session.testStatus.mockResolvedValue({ runStatus: "completed", sourceTest });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
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

  it("does not offer a test when the routine no longer exists", async () => {
    const configured = { ...plan, status: "configured", revision: 3, routineId: null };
    session.load.mockResolvedValue({
      servers: [{ id: "server-1", revision: 3, name: "Mail" }],
      plans: [configured],
      nextCursor: null,
    });
    session.preparedTest.mockResolvedValue({
      id: "attempt",
      planId: plan.id,
      planRevision: 2,
      taskId: null,
      status: "prepared",
      execution: "not_started",
      sourceAccess: "not_verified",
      createdAt: plan.createdAt,
    });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    expect(container.textContent).toContain("The routine is unavailable, so a test cannot run");
    expect(
      [...container.querySelectorAll("button")].some((node) => node.textContent === "Run test"),
    ).toBe(false);
  });
  it("saves and checks a proposal without claiming a mailbox read or activation", async () => {
    expect(container.textContent).toContain("does not start a routine or check your mailbox");
    await act(async () => {
      input(container.querySelector("textarea")!, draft.purpose);
    });
    await select("Integration", "server-1");
    await click("Find read operations");
    await select("Read operation", "read_mail");
    await click("Save draft");
    expect(session.save).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: draft.purpose, source: draft.source }),
      null,
    );
    expect(button("Save proposal").disabled).toBe(true);
    await click("Check setup");
    expect(session.candidates).toHaveBeenCalledWith(plan);
    expect(container.textContent).toContain("No read was performed");
    await click("Save proposal");
    expect(container.textContent).toContain("Proposal saved");
    expect(button("Create paused routine").disabled).toBe(true);
    expect(session.configure).not.toHaveBeenCalled();
  });

  it("does not discover when the selected operation is denied", async () => {
    session.load.mockResolvedValue({
      servers: [{ id: "server-1", revision: 3, name: "Mail" }],
      plans: [plan],
      nextCursor: null,
    });
    session.prerequisites.mockResolvedValue({ ...checks, selectedTool: "blocked" });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    await click("Check setup");
    expect(container.textContent).toContain("Not allowed in bot settings");
    expect(session.candidates).not.toHaveBeenCalled();
    expect(button("Save proposal").disabled).toBe(true);
  });

  it("uses the selected native time in the saved schedule", async () => {
    await act(async () => {
      input(container.querySelector("textarea")!, draft.purpose);
    });
    await select("Integration", "server-1");
    await click("Find read operations");
    await select("Read operation", "read_mail");
    await click("Choose time");
    await click("Save draft");
    expect(session.save).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: { cron: "35 14 * * *", timezone: "Australia/Melbourne" },
      }),
      null,
    );
  });

  it("preserves an existing custom schedule while changing the purpose", async () => {
    const custom = {
      ...plan,
      draft: { ...draft, schedule: { cron: "17 4 * * 3", timezone: "UTC" } },
    };
    session.load.mockResolvedValue({
      servers: [{ id: "server-1", revision: 3, name: "Mail" }],
      plans: [custom],
      nextCursor: null,
    });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    expect(container.textContent).toContain("Custom schedule is preserved");
    await act(async () => {
      input(container.querySelector("textarea")!, "Look for updates");
    });
    await click("Save draft");
    expect(session.save).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: { cron: "17 4 * * 3", timezone: "UTC" },
      }),
      custom,
    );
  });

  it("creates only a paused routine after an explicit fresh proposal check", async () => {
    const proposed = { ...plan, status: "proposed", revision: 2 };
    session.load.mockResolvedValue({
      servers: [{ id: "server-1", revision: 3, name: "Mail" }],
      plans: [proposed],
      nextCursor: null,
    });
    session.prerequisites.mockResolvedValue({ ...checks, planRevision: 2 });
    session.candidates.mockResolvedValue({ ...candidates, planRevision: 2 });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <EmailMonitorSetup
          botId="bot-1"
          botName="Scout"
          onClose={close}
          onOpenIntegrations={openIntegrations}
        />,
      );
    });
    await select("Saved proposals", "plan-1");
    expect(button("Create paused routine").disabled).toBe(true);
    await click("Check setup");
    expect(button("Create paused routine").disabled).toBe(false);
    await click("Create paused routine");
    expect(session.configure).toHaveBeenCalledWith(proposed);
    expect(container.textContent).toContain("Paused");
    expect(container.textContent).toContain("This setup is saved. Its routine status");
    expect(container.textContent).not.toContain(
      "This saves a proposal. It does not start a routine",
    );
    expect(container.textContent).toContain(
      "When setup matches the routine, a source check attempts the selected operation",
    );
    expect(container.textContent).not.toContain("Active");
  });

  it("requires confirmation before closing an unsaved purpose", async () => {
    await act(async () => {
      input(container.querySelector("textarea")!, "Watch mail");
    });
    await click("Close");
    expect(mocks.alert).toHaveBeenCalledWith(
      "Discard unsaved changes?",
      expect.any(String),
      expect.any(Array),
    );
    expect(close).not.toHaveBeenCalled();
  });
});
