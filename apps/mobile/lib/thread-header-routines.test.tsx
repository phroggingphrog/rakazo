// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { threadHeaderRight } from "../components/thread-header-right";

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
    style,
  }: {
    children: ReactNode;
    accessibilityLabel: string;
    onPress: () => void;
    style?: { minHeight?: number; minWidth?: number };
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        onClick: onPress,
        "data-min-height": style?.minHeight,
        "data-min-width": style?.minWidth,
      },
      children,
    ),
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));

it("opens routines from Android bot chat and omits the control for a group or read-only chat", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const onOpenRoutines = vi.fn();
  const options = {
    inGroup: false,
    readOnly: false,
    hasBot: true,
    t: (text: string) => text,
    color: "black",
    onGroupSettings: vi.fn(),
    onBotActions: vi.fn(),
    onOpenRoutines,
    menuActions: [],
  };
  const draw = (overrides: Partial<typeof options> = {}) => {
    const header = threadHeaderRight({ ...options, ...overrides });
    act(() => root.render(header.headerRight?.({ tintColor: undefined, canGoBack: true }) ?? null));
  };
  draw();
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Routines"]');
  expect(button?.textContent).toBe("Routines");
  expect(button?.dataset.minHeight).toBe("48");
  expect(button?.dataset.minWidth).toBe("48");
  act(() => button?.click());
  expect(onOpenRoutines).toHaveBeenCalledOnce();
  draw({ inGroup: true });
  expect(container.querySelector('button[aria-label="Routines"]')).toBeNull();
  draw({ readOnly: true });
  expect(container.querySelector('button[aria-label="Routines"]')).toBeNull();
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
