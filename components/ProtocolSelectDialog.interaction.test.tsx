import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";

import type { Host, HostProtocol } from "../types";
import { createDomRenderer, installDomEnvironment } from "./test-support/renderReactDom";

const host: Host = {
  id: "host-1",
  label: "prod-db",
  hostname: "10.2.0.31",
  port: 22,
  username: "root",
  protocol: "ssh",
  moshEnabled: true,
  telnetEnabled: true,
};

async function withProtocolDialog(
  run: (fixture: {
    document: Document;
    cancelled: () => number;
    selected: Array<[HostProtocol, number]>;
    pressCloseTabShortcut: typeof import("./test-support/dialogShortcuts").pressCloseTabShortcut;
    getTopmostDialogCloseControl: typeof import("../application/state/dialogStack").getTopmostDialogCloseControl;
  }) => Promise<void>,
) {
  const env = installDomEnvironment();
  const renderer = await createDomRenderer(env.document);
  const { I18nProvider } = await import("../application/i18n/I18nProvider");
  const { default: ProtocolSelectDialog } = await import("./ProtocolSelectDialog");
  const { pressCloseTabShortcut } = await import("./test-support/dialogShortcuts");
  const { getTopmostDialogCloseControl } = await import("../application/state/dialogStack");
  // The dialog opens from the host's connect action, which has focus until then.
  const opener = env.document.createElement("button");
  opener.id = "connect-host";
  env.document.body.appendChild(opener);
  opener.focus();
  let cancelled = 0;
  const selected: Array<[HostProtocol, number]> = [];
  function Fixture() {
    const [open, setOpen] = useState(true);
    return (
      <I18nProvider locale="en">
        {open && (
          <ProtocolSelectDialog
            host={host}
            onSelect={(protocol, port) => {
              selected.push([protocol, port]);
              setOpen(false);
            }}
            onCancel={() => {
              cancelled++;
              setOpen(false);
            }}
          />
        )}
      </I18nProvider>
    );
  }
  try {
    await renderer.render(<Fixture />);
    await run({
      document: env.document,
      cancelled: () => cancelled,
      selected,
      pressCloseTabShortcut,
      getTopmostDialogCloseControl,
    });
  } finally {
    await renderer.unmount();
    env.cleanup();
  }
}

test("Escape cancels protocol selection and returns focus to the connect action", async () => {
  await withProtocolDialog(async ({ document, cancelled, selected }) => {
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog && document.activeElement === dialog, "The dialog takes focus");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      dialog.dispatchEvent(escape);
    });
    assert.equal(escape.defaultPrevented, true);
    assert.equal(cancelled(), 1);
    assert.deepEqual(selected, []);
    assert.ok(!document.querySelector('[role="dialog"]'), "The dialog closed");
    assert.equal(document.activeElement?.id, "connect-host");
  });
});

for (const scheme of ["mac", "pc"] as const) {
  test(`${scheme === "mac" ? "Cmd" : "Ctrl"}+W cancels protocol selection instead of closing the tab`, async () => {
    await withProtocolDialog(async ({ document, cancelled, selected, pressCloseTabShortcut }) => {
      const port = document.querySelector<HTMLInputElement>('input[type="number"]');
      assert.ok(port);
      let result: ReturnType<typeof pressCloseTabShortcut> | undefined;
      await act(async () => {
        result = pressCloseTabShortcut(port, scheme);
      });
      assert.deepEqual(result?.actions, [], "No tab or window action runs");
      assert.equal(result?.defaultPrevented, true);
      assert.equal(cancelled(), 1);
      assert.deepEqual(selected, []);
    });
  });
}

test("the macOS Close menu command cancels protocol selection once", async () => {
  await withProtocolDialog(async ({ cancelled, selected, getTopmostDialogCloseControl }) => {
    const control = getTopmostDialogCloseControl();
    assert.ok(control, "The protocol dialog is the topmost dialog");
    await act(async () => {
      control.click();
    });
    assert.equal(cancelled(), 1, "The backdrop does not cancel a second time");
    assert.deepEqual(selected, []);
  });
});
