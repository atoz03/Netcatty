import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";

import { createDomRenderer, installDomEnvironment } from "./test-support/renderReactDom";

async function withDom(
  run: (fixture: {
    document: Document;
    window: Window & typeof globalThis;
    render: (node: React.ReactNode) => Promise<void>;
    modules: Awaited<ReturnType<typeof loadModules>>;
  }) => Promise<void>,
) {
  const env = installDomEnvironment();
  const renderer = await createDomRenderer(env.document);
  try {
    await run({ document: env.document, window: env.window, render: renderer.render, modules: await loadModules() });
  } finally {
    await renderer.unmount();
    env.cleanup();
  }
}

async function loadModules() {
  const { I18nProvider } = await import("../application/i18n/I18nProvider");
  const { CustomDialogContent } = await import("./ui/custom-dialog");
  const { getTopmostDialogCloseControl } = await import("../application/state/dialogStack");
  const { pressCloseTabShortcut } = await import("./test-support/dialogShortcuts");
  return { I18nProvider, CustomDialogContent, getTopmostDialogCloseControl, pressCloseTabShortcut };
}

const pressEscape = async (target: EventTarget, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
};

test("custom dialogs join the shared dialog contract used by Cmd/Ctrl+W", async () => {
  await withDom(async ({ document, render, modules: { I18nProvider, CustomDialogContent, getTopmostDialogCloseControl } }) => {
    let dismissed = 0;
    let backdropClicks = 0;
    await render(
      <I18nProvider locale="en">
        <div onClick={() => backdropClicks++}>
          <CustomDialogContent aria-label="Demo" onDismiss={() => dismissed++}>
            <p>Body</p>
          </CustomDialogContent>
        </div>
      </I18nProvider>,
    );

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("data-state"), "open");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    const control = getTopmostDialogCloseControl(document);
    assert.ok(control && dialog.contains(control), "Cmd/Ctrl+W finds the dialog's own close control");
    assert.equal(control.getAttribute("aria-hidden"), "true");
    assert.equal(control.tabIndex, -1);

    await act(async () => {
      control.click();
    });
    assert.equal(dismissed, 1);
    assert.equal(backdropClicks, 0, "the close control does not also reach a backdrop click handler");
  });
});

test("Escape dismisses only the topmost dialog, after nested layers and IME", async () => {
  await withDom(async ({ document, render, modules: { I18nProvider, CustomDialogContent } }) => {
    const dismissed: string[] = [];
    let upperEscape = true;
    let setUpperEscape: (value: boolean) => void = () => {};
    function Stack() {
      const [open, setOpen] = useState({ lower: true, upper: true });
      const [upperDismissOnEscape, setUpperDismissOnEscape] = useState(upperEscape);
      setUpperEscape = (value) => {
        upperEscape = value;
        setUpperDismissOnEscape(value);
      };
      return (
        <I18nProvider locale="en">
          {open.lower && (
            <CustomDialogContent
              aria-label="Lower"
              onDismiss={() => {
                dismissed.push("lower");
                setOpen((prev) => ({ ...prev, lower: false }));
              }}
            >
              <input id="lower-input" />
            </CustomDialogContent>
          )}
          {open.upper && (
            <CustomDialogContent
              aria-label="Upper"
              dismissOnEscape={upperDismissOnEscape}
              onDismiss={() => {
                dismissed.push("upper");
                setOpen((prev) => ({ ...prev, upper: false }));
              }}
            >
              <input id="upper-input" />
            </CustomDialogContent>
          )}
        </I18nProvider>
      );
    }
    await render(<Stack />);

    const handledByNestedLayer = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", handledByNestedLayer, true);
    await pressEscape(document.body);
    document.removeEventListener("keydown", handledByNestedLayer, true);
    assert.deepEqual(dismissed, [], "a nested layer that handled Escape keeps the dialog open");

    await pressEscape(document.getElementById("upper-input")!, { isComposing: true });
    assert.deepEqual(dismissed, [], "Escape that ends IME composition keeps the dialog open");

    await act(async () => setUpperEscape(false));
    await pressEscape(document.body);
    assert.deepEqual(dismissed, [], "a dialog that yields Escape to its own popup stays open, and so does the one below");
    await act(async () => setUpperEscape(true));

    const lock = document.createElement("div");
    lock.setAttribute("data-app-lock-overlay", "");
    document.body.appendChild(lock);
    await pressEscape(document.body);
    lock.remove();
    assert.deepEqual(dismissed, [], "Escape belongs to the app lock screen while it is shown");

    const first = await pressEscape(document.body);
    assert.deepEqual(dismissed, ["upper"]);
    assert.equal(first.defaultPrevented, true, "later Escape handlers see the key as handled");

    await pressEscape(document.getElementById("lower-input")!);
    assert.deepEqual(dismissed, ["upper", "lower"]);
  });
});

test("focus moves into the dialog and returns to the opener when it closes", async () => {
  await withDom(async ({ document, render, modules: { I18nProvider, CustomDialogContent } }) => {
    // Compare ids: asserting on unequal DOM nodes would inspect all of JSDOM.
    const focusedId = () => document.activeElement?.id;
    const opener = document.createElement("button");
    opener.id = "opener";
    document.body.appendChild(opener);
    opener.focus();
    assert.equal(focusedId(), "opener");

    let setOpen: (open: boolean) => void = () => {};
    function Toggle({ autoFocusInput }: { autoFocusInput: boolean }) {
      const [open, setOpenState] = useState(true);
      setOpen = setOpenState;
      return (
        <I18nProvider locale="en">
          {open && (
            <CustomDialogContent id="panel" aria-label="Demo" onDismiss={() => setOpenState(false)}>
              <input id="field" autoFocus={autoFocusInput} />
            </CustomDialogContent>
          )}
        </I18nProvider>
      );
    }

    await render(<Toggle autoFocusInput={false} />);
    assert.equal(focusedId(), "panel");
    await act(async () => setOpen(false));
    assert.equal(focusedId(), "opener");

    await render(<Toggle autoFocusInput key="autofocus" />);
    assert.equal(focusedId(), "field", "an autoFocus field keeps focus");
    await act(async () => setOpen(false));
    assert.equal(focusedId(), "opener");
  });
});

for (const scheme of ["mac", "pc"] as const) {
  test(`${scheme === "mac" ? "Cmd" : "Ctrl"}+W closes the topmost custom dialog instead of the active tab`, async () => {
    await withDom(async ({ document, render, modules: { I18nProvider, CustomDialogContent, pressCloseTabShortcut } }) => {
      let dismissed = 0;
      function Dialog() {
        const [open, setOpen] = useState(true);
        return (
          <I18nProvider locale="en">
            <button id="outside">Outside</button>
            {open && (
              <CustomDialogContent
                aria-label="Demo"
                onDismiss={() => {
                  dismissed++;
                  setOpen(false);
                }}
              >
                <input id="field" />
              </CustomDialogContent>
            )}
          </I18nProvider>
        );
      }
      await render(<Dialog />);

      let result: ReturnType<typeof pressCloseTabShortcut> | undefined;
      await act(async () => {
        result = pressCloseTabShortcut(document.getElementById("field")!, scheme);
      });
      assert.equal(dismissed, 1);
      assert.deepEqual(result?.actions, []);
      assert.equal(result?.defaultPrevented, true);
      assert.ok(!document.querySelector('[role="dialog"]'), "the dialog closed");

      await act(async () => {
        result = pressCloseTabShortcut(document.getElementById("outside")!, scheme);
      });
      assert.deepEqual(result?.actions, ["closeTab"], "without a dialog the shortcut closes the tab as before");
    });
  });
}
