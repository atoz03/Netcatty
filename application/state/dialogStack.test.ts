import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { getTopmostDialogCloseControl, getTopmostOpenDialog } from "./dialogStack.ts";

const documentWith = (body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`).window.document;

const closeControl = '<button data-dialog-close="true"></button>';

test("no open dialog leaves Cmd+W to tabs and windows", () => {
  const doc = documentWith('<div role="dialog" data-state="closed">' + closeControl + "</div>");
  assert.equal(getTopmostOpenDialog(doc), null);
  assert.equal(getTopmostDialogCloseControl(doc), null);
});

test("the last open dialog in the document is the one on top", () => {
  const doc = documentWith(
    '<div id="below" role="dialog" data-state="open">' + closeControl + "</div>"
    + '<div id="closing" role="dialog" data-state="closed">' + closeControl + "</div>"
    + '<div id="top" role="dialog" data-state="open">' + closeControl + "</div>",
  );
  assert.equal(getTopmostOpenDialog(doc)?.id, "top");
  assert.equal(getTopmostDialogCloseControl(doc)?.parentElement?.id, "top");
});

test("an open popover inside a dialog leaves that dialog on top", () => {
  const doc = documentWith(
    '<div id="wizard" role="dialog" data-state="open">' + closeControl + "</div>"
    + '<div data-radix-popper-content-wrapper=""><div id="picker" role="dialog" data-state="open"></div></div>',
  );
  assert.equal(getTopmostOpenDialog(doc)?.id, "wizard");
  assert.equal(getTopmostDialogCloseControl(doc)?.parentElement?.id, "wizard");
});

test("an open popover alone is not a dialog", () => {
  const doc = documentWith(
    '<div data-radix-popper-content-wrapper=""><div role="dialog" data-state="open"></div></div>',
  );
  assert.equal(getTopmostOpenDialog(doc), null);
  assert.equal(getTopmostDialogCloseControl(doc), null);
});

test("a topmost dialog without a close control never closes the dialog below it", () => {
  const doc = documentWith(
    '<div role="dialog" data-state="open">' + closeControl + "</div>"
    + '<div id="lock" role="dialog" data-state="open" data-app-lock-overlay=""></div>',
  );
  assert.equal(getTopmostOpenDialog(doc)?.id, "lock");
  assert.equal(getTopmostDialogCloseControl(doc), null);
});

test("lookups without a document find nothing", () => {
  assert.equal(getTopmostOpenDialog(null), null);
  assert.equal(getTopmostDialogCloseControl(null), null);
});
