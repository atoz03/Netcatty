import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  endDraftSend,
  endSend,
  endSendForKey,
  tryBeginDraftSend,
  tryBeginSend,
  tryBeginSendForKey,
} from "./draftSendGate.ts";

test("draft send gate allows only one in-flight draft send at a time", () => {
  const gate = { current: false };

  assert.equal(tryBeginDraftSend(gate), true);
  assert.equal(tryBeginDraftSend(gate), false);

  endDraftSend(gate);

  assert.equal(tryBeginDraftSend(gate), true);
});

test("send gate aliases cover session-mode re-entry the same way", () => {
  const gate = { current: false };
  assert.equal(tryBeginSend(gate), true);
  assert.equal(tryBeginSend(gate), false);
  endSend(gate);
  assert.equal(tryBeginSend(gate), true);
});

test("module send latch survives across independent gate objects (remount-safe)", () => {
  const key = `test-send-${Date.now()}-${Math.random()}`;
  assert.equal(tryBeginSendForKey(key), true);
  assert.equal(tryBeginSendForKey(key), false);
  endSendForKey(key);
  assert.equal(tryBeginSendForKey(key), true);
  endSendForKey(key);
});

test("AIChatSidePanel gates every send including session mode", () => {
  const source = readFileSync(new URL("../AIChatSidePanel.tsx", import.meta.url), "utf8");
  assert.match(source, /tryBeginSendForKey\(sendGateKey\)/);
  assert.match(source, /isAIChatSessionStreaming\(sessionId\)/);
  assert.doesNotMatch(
    source,
    /isDraftMode && !tryBeginDraftSend/,
    "session-mode sends must share the sync re-entry gate",
  );
  assert.doesNotMatch(
    source,
    /sendInFlightRef/,
    "component refs reset on StrictMode remount; use module key latch",
  );
});
