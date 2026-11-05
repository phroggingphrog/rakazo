// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    onPressAction,
    children,
  }: {
    onPressAction: (event: unknown) => void;
    children: ReactNode;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: () => onPressAction({ nativeEvent: { event: "choice:two" } }),
      },
      children,
    ),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("span", null, children);
  return {
    View: view,
    Text: view,
    Pressable: view,
    StyleSheet: { create: (styles: unknown) => styles },
  };
});
vi.mock("./native", () => ({
  native: { tertiaryLabel: "grey" },
  useMobileTokens: () => ({ foreground: "black" }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (styles: () => unknown) => styles(),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));

const { MenuPicker } = await import("../components/menu-picker");

it("does not accept native menu events while disabled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  const onChange = vi.fn();
  const props = {
    label: "Choice",
    value: "one",
    choices: [
      { key: "one", label: "One" },
      { key: "two", label: "Two" },
    ],
    onChange,
  };
  await act(async () => root.render(<MenuPicker {...props} disabled />));
  await act(async () => element.querySelector("button")!.click());
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => root.render(<MenuPicker {...props} disabled={false} />));
  await act(async () => element.querySelector("button")!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith("two");
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
