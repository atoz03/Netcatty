import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";

import type { HostConnectionTestState } from "../application/state/useHostConnectionTest";
import type { ConflictInfo } from "../domain/sync";
import type { Host } from "../types";
import { createDomRenderer, installDomEnvironment } from "./test-support/renderReactDom";

// Overlays built on CustomDialogContent: each closes on Escape and on
// Cmd/Ctrl+W like its own Close/Cancel button, topmost dialog first.

type Scheme = "mac" | "pc";

async function withDom(
  run: (fixture: {
    document: Document;
    render: (node: React.ReactNode) => Promise<void>;
    escape: (target?: Element | null) => Promise<KeyboardEvent>;
    closeTab: (scheme: Scheme, target?: Element | null) => Promise<{ actions: string[]; defaultPrevented: boolean }>;
    click: (element: Element | null | undefined) => Promise<void>;
    buttonWithText: (text: string) => HTMLButtonElement;
    openDialogs: () => number;
  }) => Promise<void>,
) {
  const env = installDomEnvironment();
  const { window, document } = env;
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const extraGlobals: Record<string, unknown> = {
    Element: window.Element,
    HTMLInputElement: window.HTMLInputElement,
    SVGElement: window.SVGElement,
    MutationObserver: window.MutationObserver,
    ResizeObserver: ResizeObserverStub,
    localStorage: window.localStorage,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(extraGlobals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const renderer = await createDomRenderer(document);
  const { I18nProvider } = await import("../application/i18n/I18nProvider");
  const { pressCloseTabShortcut } = await import("./test-support/dialogShortcuts");
  const focusTarget = (target?: Element | null) => target ?? document.activeElement ?? document.body;
  try {
    await run({
      document,
      render: (node) => renderer.render(<I18nProvider locale="en">{node}</I18nProvider>),
      async escape(target) {
        const event = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        await act(async () => {
          focusTarget(target).dispatchEvent(event);
        });
        return event;
      },
      async closeTab(scheme, target) {
        let result: ReturnType<typeof pressCloseTabShortcut> | undefined;
        await act(async () => {
          result = pressCloseTabShortcut(focusTarget(target), scheme);
        });
        return result!;
      },
      async click(element) {
        assert.ok(element, "The element to click is present");
        await act(async () => {
          (element as HTMLElement).click();
        });
      },
      buttonWithText(text) {
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
          .find((candidate) => candidate.textContent?.includes(text));
        assert.ok(button, `Button ${text} is present`);
        return button;
      },
      openDialogs: () => document.querySelectorAll('[role="dialog"][data-state="open"]').length,
    });
  } finally {
    await renderer.unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    env.cleanup();
  }
}

for (const dialog of ["package", "rename"] as const) {
  for (const key of ["Escape", "Cmd+W", "Ctrl+W"] as const) {
    test(`${key} closes the snippet ${dialog} dialog`, async () => {
      await withDom(async (f) => {
        const { SnippetsPackageDialogs } = await import("./SnippetsPackageDialogs");
        const closed: string[] = [];
        let submitted = 0;
        function Fixture() {
          const [open, setOpen] = useState(true);
          const close = (next: boolean) => {
            if (!next) closed.push(dialog);
            setOpen(next);
          };
          return (
            <SnippetsPackageDialogs
              t={(text: string) => text}
              isPackageDialogOpen={dialog === "package" && open}
              selectedPackage=""
              newPackageName="ops"
              setNewPackageName={() => {}}
              createPackage={() => submitted++}
              setIsPackageDialogOpen={close}
              isRenameDialogOpen={dialog === "rename" && open}
              renamingPackagePath="ops"
              renamePackageName="ops"
              setRenamePackageName={() => {}}
              setRenameError={() => {}}
              renamePackage={() => submitted++}
              renameError=""
              setIsRenameDialogOpen={close}
            />
          );
        }
        await f.render(<Fixture />);
        const field = f.document.querySelector("input");
        assert.ok(field && f.document.activeElement === field, "The name field has focus");
        if (key === "Escape") await f.escape(field);
        else assert.deepEqual((await f.closeTab(key === "Cmd+W" ? "mac" : "pc", field)).actions, []);
        assert.deepEqual(closed, [dialog]);
        assert.equal(submitted, 0);
        assert.equal(f.openDialogs(), 0);
      });
    });
  }
}

test("Escape and Ctrl+W close the theme picker without selecting", async () => {
  await withDom(async (f) => {
    const { ThemeSelectModal } = await import("./settings/ThemeSelectModal");
    let closed = 0;
    const selected: string[] = [];
    const render = () => f.render(
      <ThemeSelectModal
        open
        onClose={() => closed++}
        selectedThemeId="netcatty-dark"
        onSelect={(themeId) => selected.push(themeId)}
      />,
    );
    await render();
    await f.escape();
    assert.equal(closed, 1);
    await render();
    await f.closeTab("pc");
    assert.equal(closed, 2);
    assert.deepEqual(selected, []);
  });
});

test("Escape and Cmd+W dismiss the cloud sync dialogs without resolving", async () => {
  await withDom(async (f) => {
    const { ConflictModal, GitHubDeviceFlowModal } = await import("./cloud-sync/CloudSyncControls");
    let closed = 0;
    await f.render(
      <GitHubDeviceFlowModal
        isOpen
        userCode="ABCD-1234"
        verificationUri="https://github.com/login/device"
        isPolling
        onClose={() => closed++}
      />,
    );
    await f.escape();
    assert.equal(closed, 1);

    const resolutions: string[] = [];
    const conflict: ConflictInfo = {
      provider: "github",
      localVersion: 3,
      localUpdatedAt: 1_700_000_000_000,
      remoteVersion: 4,
      remoteUpdatedAt: 1_700_000_100_000,
    };
    await f.render(
      <ConflictModal open conflict={conflict} onResolve={(resolution) => resolutions.push(resolution)} onClose={() => closed++} />,
    );
    await f.closeTab("mac");
    assert.equal(closed, 2);
    await f.escape();
    assert.equal(closed, 3);
    assert.deepEqual(resolutions, []);
  });
});

test("the custom theme editor closes before the appearance dialog under it", async () => {
  await withDom(async (f) => {
    const { ThemeCustomizeModal } = await import("./terminal/ThemeCustomizeModal");
    let closed = 0;
    function Fixture() {
      const [open, setOpen] = useState(true);
      return (
        <ThemeCustomizeModal
          open={open}
          onClose={() => {
            closed++;
            setOpen(false);
          }}
        />
      );
    }
    await f.render(<Fixture />);
    assert.equal(f.openDialogs(), 1);
    await f.click(f.buttonWithText("Custom"));
    const openEditor = async () => {
      await f.click(f.buttonWithText("New Theme"));
      assert.equal(f.openDialogs(), 2, "The editor opens on top");
    };

    await openEditor();
    await f.closeTab("pc");
    assert.equal(f.openDialogs(), 1, "Ctrl+W closed only the editor");
    assert.equal(closed, 0);

    await openEditor();
    await f.escape();
    assert.equal(f.openDialogs(), 1, "Escape closed only the editor");
    assert.equal(closed, 0);

    await f.escape();
    assert.equal(closed, 1);
    assert.equal(f.openDialogs(), 0);
  });
});

test("Escape and Cmd/Ctrl+W cancel a running host connection test like Cancel", async () => {
  await withDom(async (f) => {
    const { HostConnectionTestDialog } = await import("./host-details/HostConnectionTestDialog");
    const host: Host = { id: "host-1", label: "prod", hostname: "10.0.0.5", port: 22, username: "root" };
    let cancelled = 0;
    let closed = 0;
    const state = (status: HostConnectionTestState["status"]): HostConnectionTestState => ({
      status,
      error: null,
      needsAuth: false,
      progressValue: 20,
      chainProgress: null,
      progressLogs: [],
      hostKeyVerification: null,
      timeLeft: 20,
      isAwaitingUserInput: false,
      isCancelling: false,
    });
    const connectionTest = (status: HostConnectionTestState["status"]) => ({
      state: state(status),
      cancelTest: () => cancelled++,
      submitAuth: () => {},
      retry: async () => {},
      handleHostKeyClose: () => {},
      handleHostKeyContinue: () => {},
      handleHostKeyAddAndContinue: () => {},
    }) as unknown as React.ComponentProps<typeof HostConnectionTestDialog>["test"];
    const render = (status: HostConnectionTestState["status"]) => f.render(
      <HostConnectionTestDialog open host={host} keys={[]} test={connectionTest(status)} onClose={() => closed++} />,
    );

    await render("connecting");
    await f.escape();
    assert.equal(cancelled, 1, "Escape cancels the running test");
    assert.equal(closed, 1);

    await render("connecting");
    await f.closeTab("mac");
    assert.equal(cancelled, 2, "Cmd+W cancels the running test");
    assert.equal(closed, 2);

    await render("connected");
    await f.closeTab("pc");
    assert.equal(cancelled, 2, "A finished test has nothing to cancel");
    assert.equal(closed, 3);
  });
});
