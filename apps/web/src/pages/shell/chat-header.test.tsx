// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatHeader } from "./chat-header";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, onClick, ...props }: { children?: ReactNode; onClick?: () => void }) =>
    createElement("button", { ...props, onClick, type: "button" }, children),
  BotAvatar: () => null,
  GroupAvatar: () => null,
}));
vi.mock("../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));

it("opens routines from an active one-to-one chat and hides the link elsewhere", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const open = vi.fn();
  const props = {
    inGroup: false,
    active: { id: "bot", name: "Bot", color: "blue", archivedAt: null },
    activeGroup: undefined,
    activeSnapshot: null,
    phoneCallsEnabled: false,
    inCall: false,
    panelOpen: false,
    onOpenNavigation: vi.fn(),
    onTogglePanel: vi.fn(),
    onOpenRoutines: open,
    onCall: vi.fn(),
  } as unknown as Parameters<typeof ChatHeader>[0];
  act(() => root.render(<ChatHeader {...props} />));
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Routines"]');
  expect(button?.textContent).toBe("Routines");
  expect(button?.classList.contains("min-h-11")).toBe(true);
  act(() => button?.click());
  expect(open).toHaveBeenCalledOnce();
  act(() => root.render(<ChatHeader {...props} inGroup />));
  expect(container.querySelector('button[aria-label="Routines"]')).toBeNull();
  act(() =>
    root.render(<ChatHeader {...props} active={{ ...props.active!, archivedAt: "2026-01-01" }} />),
  );
  expect(container.querySelector('button[aria-label="Routines"]')).toBeNull();
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
