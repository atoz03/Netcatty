import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dialogSource = readFileSync(
  new URL("./PortForwardHostKeyDialog.tsx", import.meta.url),
  "utf8",
);

const trayPanelSource = readFileSync(
  new URL("../TrayPanel.tsx", import.meta.url),
  "utf8",
);

test("port-forward host-key dialog is marked so tray outside-click handling ignores it", () => {
  assert.match(dialogSource, /data-port-forward-host-key-dialog="true"/);
  assert.match(dialogSource, /overlayClassName="port-forward-host-key-dialog-layer"/);
  assert.match(trayPanelSource, /data-port-forward-host-key-dialog/);
  assert.match(trayPanelSource, /port-forward-host-key-dialog-layer/);
});
