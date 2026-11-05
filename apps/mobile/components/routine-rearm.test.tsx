// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { expect, it, vi } from "vitest";
import { RoutineRearm } from "./routine-rearm";

vi.mock("@expo/ui/community/datetime-picker", () => ({
  default: ({
    onValueChange,
    mode,
    value,
  }: {
    onValueChange: (event: unknown, at: Date) => void;
    mode: string;
    value: Date;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-mode": mode,
        "data-value": value.toISOString(),
        onClick: () => onValueChange({}, new Date("2099-11-04T10:30:00.000Z")),
      },
      "Choose date",
    ),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Modal: view,
    ScrollView: view,
    View: view,
    Text: view,
    StyleSheet: { create: (styles: unknown) => styles },
    Platform: { OS: "ios" },
  };
});

vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../lib/native", () => ({
  native: { groupedPage: "white", label: "black" },
  useThemedStyles: (styles: () => unknown) => styles(),
}));
vi.mock("./native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    busy,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, disabled: disabled || busy },
      label,
    ),
}));

it("saves the time selected in the native picker and allows cancellation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  const save = vi.fn();
  const cancel = vi.fn();
  await act(async () =>
    root.render(<RoutineRearm saving={false} onCancel={cancel} onSave={save} />),
  );
  const button = (label: string) =>
    [...element.querySelectorAll("button")].find((item) => item.textContent === label)!;
  await act(async () => button("Choose date").click());
  await act(async () => button("Save").click());
  expect(save).toHaveBeenCalledExactlyOnceWith(new Date("2099-11-04T10:30:00.000Z"));
  await act(async () => button("Cancel").click());
  expect(cancel).toHaveBeenCalledOnce();
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("shows separate date and time pickers on Android and keeps their selected value in sync", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(Platform, { OS: "android" });
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(<RoutineRearm saving={false} onCancel={() => {}} onSave={() => {}} />),
    );
    const date = element.querySelector<HTMLButtonElement>('[data-mode="date"]')!;
    const time = element.querySelector<HTMLButtonElement>('[data-mode="time"]')!;
    expect(date).toBeTruthy();
    expect(time).toBeTruthy();
    await act(async () => date.click());
    expect(time.dataset.value).toBe("2099-11-04T10:30:00.000Z");
  } finally {
    act(() => root.unmount());
    Object.assign(Platform, { OS: "ios" });
    vi.unstubAllGlobals();
  }
});
