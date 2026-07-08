import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  getTerminalOutputPressure,
  noteTerminalOutputPressureData,
  resetTerminalOutputPressure,
  setTerminalOutputPressureVisibility,
} from "./terminalOutputPressure.ts";
import { TERMINAL_LONG_LINE_PRESSURE_BYTES } from "./terminalFlowConstants.ts";
import { XTERM_PERFORMANCE_CONFIG } from "../../../infrastructure/config/xtermPerformance.ts";

const createFakeTerm = () => ({}) as XTerm;

test("tracks long unbroken terminal output pressure until a line break arrives", () => {
  const term = createFakeTerm();

  noteTerminalOutputPressureData(term, "x".repeat(TERMINAL_LONG_LINE_PRESSURE_BYTES - 1));
  assert.equal(getTerminalOutputPressure(term).longLine, false);

  noteTerminalOutputPressureData(term, "x");
  assert.equal(getTerminalOutputPressure(term).longLine, true);
  assert.equal(getTerminalOutputPressure(term).mode, "long-line");

  noteTerminalOutputPressureData(term, "\nshort");
  assert.equal(getTerminalOutputPressure(term).longLine, false);
  assert.equal(getTerminalOutputPressure(term).mode, "normal");

  resetTerminalOutputPressure(term);
});

test("reports newline-terminated long terminal lines as long-line pressure", () => {
  const term = createFakeTerm();

  noteTerminalOutputPressureData(term, `${"x".repeat(TERMINAL_LONG_LINE_PRESSURE_BYTES)}\n`);
  assert.equal(getTerminalOutputPressure(term).longLine, true);
  assert.equal(getTerminalOutputPressure(term).mode, "long-line");
  assert.equal(getTerminalOutputPressure(term).consecutiveUnbrokenBytes, 0);

  noteTerminalOutputPressureData(term, "short\n");
  assert.equal(getTerminalOutputPressure(term).longLine, false);
  assert.equal(getTerminalOutputPressure(term).largeOutput, true);
  assert.equal(getTerminalOutputPressure(term).mode, "large-output");

  resetTerminalOutputPressure(term);
});

test("reports background pressure separately from output volume", () => {
  const term = createFakeTerm();

  setTerminalOutputPressureVisibility(term, false);
  assert.equal(getTerminalOutputPressure(term).background, true);
  assert.equal(getTerminalOutputPressure(term).mode, "background");

  setTerminalOutputPressureVisibility(term, true);
  assert.equal(getTerminalOutputPressure(term).background, false);
  assert.equal(getTerminalOutputPressure(term).mode, "normal");

  resetTerminalOutputPressure(term);
});

test("keeps large-output pressure through small input echoes until output is quiet", () => {
  const term = createFakeTerm();
  const originalNow = performance.now.bind(performance);
  let now = 1_000;

  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });

  try {
    noteTerminalOutputPressureData(term, "x\n".repeat(Math.ceil(TERMINAL_LONG_LINE_PRESSURE_BYTES / 2)));
    assert.equal(getTerminalOutputPressure(term).largeOutput, true);
    assert.equal(getTerminalOutputPressure(term).mode, "large-output");

    now += 16;
    noteTerminalOutputPressureData(term, "a");
    assert.equal(getTerminalOutputPressure(term).largeOutput, true);
    assert.equal(getTerminalOutputPressure(term).mode, "large-output");

    now += XTERM_PERFORMANCE_CONFIG.highlighting.largeOutputQuietMs + 1;
    assert.equal(getTerminalOutputPressure(term).largeOutput, false);
    assert.equal(getTerminalOutputPressure(term).mode, "normal");
  } finally {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: originalNow,
    });
    resetTerminalOutputPressure(term);
  }
});
