// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ history: vi.fn(), push: vi.fn() }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("react-native", () => ({ ActivityIndicator: () => null }));
vi.mock("./routine-runs", () => ({
  useRoutineRuns: mocks.history,
  routineRunDestination: () => null,
}));
vi.mock("./activity", () => ({ activityStatusLabel: (status: string) => status }));
vi.mock("./native", () => ({ native: { secondaryLabel: "gray" } }));
vi.mock("./i18n", () => ({
  useI18n: () => ({ locale: "en", t: (s: string) => s }),
  dateLocaleForUi: () => "en",
}));
vi.mock("../components/run-error-sheet", () => ({
  RunErrorSheet: () => null,
  useRunError: () => null,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    detail,
    onPress,
    disabled,
  }: {
    title: string;
    detail?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    onPress ? (
      <button type="button" disabled={disabled} onClick={onPress}>
        {title}
      </button>
    ) : (
      <div>
        {title} {detail}
      </div>
    ),
}));
const { RoutineRunHistory } = await import("../components/routine-run-history");
const run = {
  id: "run-1",
  botId: "bot",
  groupId: null,
  status: "completed",
  error: null,
  createdAt: "2026-01-02T12:00:00Z",
  startedAt: null,
  completedAt: "2026-01-02T12:01:00Z",
  messageId: "reply",
};
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function mount(notification: string, notificationCanRetry: boolean) {
  const retryNotification = vi.fn().mockResolvedValue(undefined);
  const retry = vi.fn();
  mocks.history.mockReturnValue({
    runs: [{ ...run, notification, notificationCanRetry }],
    failed: false,
    hasOlder: false,
    retryNotification,
    retry,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RoutineRunHistory routineId="routine" botName="Bot" />));
  return {
    container,
    retryNotification,
    retry,
    close: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
it("offers one owner-triggered retry only for eligible unsent notifications", async () => {
  const view = await mount("undeliverable", true);
  try {
    expect(view.retryNotification).not.toHaveBeenCalled();
    const button = [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry notification",
    )!;
    await act(async () => button.click());
    expect(view.retryNotification).toHaveBeenCalledExactlyOnceWith("run-1");
  } finally {
    view.close();
  }
});

it("reports a lost retry response as unconfirmed", async () => {
  const view = await mount("undeliverable", true);
  try {
    view.retryNotification.mockRejectedValueOnce(new Error("connection lost"));
    const button = [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry notification",
    )!;
    await act(async () => button.click());
    expect(view.container.textContent).toContain(
      "Could not confirm the notification was queued. Check history before trying again.",
    );
    expect(view.retry).toHaveBeenCalledOnce();
  } finally {
    view.close();
  }
});
it.each(["uncertain", "undeliverable"])("does not retry %s without proof", async (notification) => {
  const view = await mount(notification, false);
  try {
    expect(view.container.textContent).not.toContain("Retry notification");
    expect(view.retryNotification).not.toHaveBeenCalled();
  } finally {
    view.close();
  }
});
