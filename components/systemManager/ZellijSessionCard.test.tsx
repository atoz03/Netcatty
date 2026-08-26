import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

// The card mounts a tooltip and a dropdown, both of which reach for
// window/document in their effects, so this needs real DOM globals even though
// react-test-renderer itself does not render into one.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const globals = globalThis as unknown as Record<string, unknown>;
for (const name of [
  "window", "document", "navigator", "HTMLElement", "Element", "Node",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver",
  "ResizeObserver", "DOMRect",
]) {
  const value = (dom.window as unknown as Record<string, unknown>)[name];
  if (value === undefined) continue;
  Object.defineProperty(globals, name, { value, configurable: true, writable: true });
}
globals.IS_REACT_ACT_ENVIRONMENT = true;

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import type { ZellijSessionInfo } from "../../domain/systemManager/types.ts";
import type { TerminalSession } from "../../types.ts";
import { ZellijSessionCard } from "./ZellijSessionCard.tsx";

const parentSession: TerminalSession = {
  id: "parent-1",
  hostId: "host-1",
  hostLabel: "Demo",
  username: "root",
  hostname: "demo.local",
  status: "connected",
  protocol: "ssh",
};

type AttachCall = {
  sessionId: string;
  title: string;
  startupCommand: string;
  mode?: string;
};

function renderCard(
  session: ZellijSessionInfo,
  onOpenManagedTerminal?: (
    sessionId: string,
    title: string,
    startupCommand: string,
    options?: { mode?: "tab" | "verticalSplit" },
  ) => boolean,
) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <I18nProvider locale="en">
        <TooltipProvider>
          <ZellijSessionCard
            session={session}
            sessionId="ssh-1"
            parentSession={parentSession}
            backend={{ zellijAction: async () => ({ success: true }) } as never}
            onLoadDetails={async () => undefined}
            onRefreshDetails={async () => undefined}
            onSessionsChanged={async () => undefined}
            onOpenManagedTerminal={onOpenManagedTerminal}
          />
        </TooltipProvider>
      </I18nProvider>,
    );
  });
  return renderer;
}

function clickByLabel(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === label,
  )[0];
  assert.ok(button, `no button labelled ${label}`);
  act(() => {
    button.props.onClick({ stopPropagation: () => {} });
  });
}

test("Attach hands the terminal layer a zellij attach command for a new tab", () => {
  const calls: AttachCall[] = [];
  const renderer = renderCard(
    { name: "dev", current: false, exited: false },
    (sessionId, title, startupCommand, options) => {
      calls.push({ sessionId, title, startupCommand, mode: options?.mode });
      return true;
    },
  );

  clickByLabel(renderer, "Attach");
  act(() => { renderer.unmount(); });

  assert.equal(calls.length, 1);
  // The panel's own ssh session is the one that gets cloned — not the zellij
  // session id, which is only a name on the remote host.
  assert.equal(calls[0].sessionId, "parent-1");
  assert.equal(calls[0].title, "zellij: dev");
  assert.match(calls[0].startupCommand, /exec zellij attach 'dev'$/);
  assert.equal(calls[0].mode, "tab");
});

test("an exited session offers Resurrect instead of Attach", () => {
  const calls: AttachCall[] = [];
  const renderer = renderCard(
    { name: "old", current: false, exited: true },
    (sessionId, title, startupCommand, options) => {
      calls.push({ sessionId, title, startupCommand, mode: options?.mode });
      return true;
    },
  );

  clickByLabel(renderer, "Resurrect");
  act(() => { renderer.unmount(); });

  assert.equal(calls.length, 1);
  assert.match(calls[0].startupCommand, /exec zellij attach 'old'$/);
});

test("Attach surfaces an inline error when the terminal layer cannot open a tab", () => {
  // The regression this pins: `onOpenManagedTerminal` was never wired up, the
  // card fell back to a window event nothing listened to, and the click did
  // nothing at all — no tab, no error.
  const renderer = renderCard({ name: "dev", current: false, exited: false }, undefined);

  clickByLabel(renderer, "Attach");
  const text = JSON.stringify(renderer.toJSON());
  act(() => { renderer.unmount(); });

  assert.match(text, /Unable to open terminal in a new tab/);
});
