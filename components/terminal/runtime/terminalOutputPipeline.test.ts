import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import { createOutputFlowController } from "./outputFlowController.ts";
import {
  filterTerminalInterruptDisplayOutput,
  prioritizeTerminalInput,
  releaseTerminalFlowOutputForTerm,
  shouldArmTerminalInterruptDisplayGateForProtocol,
  teardownTerminalOutputPipeline,
} from "./terminalOutputPipeline.ts";
import { FLOW_LOW_WATER_MARK } from "./terminalFlowConstants.ts";
import { enqueueTerminalWrite } from "./terminalWriteQueue.ts";
import { accumulateDeferredTerminalWriteAck } from "./terminalWriteAckDeferral.ts";
import { clearTerminalSessionFlowAck } from "./terminalFlowAckBuffer.ts";

const createFakeTerm = () => ({}) as XTerm;

test("teardownTerminalOutputPipeline resumes renderer pause and clears backlog", () => {
  const term = createFakeTerm();
  const events: string[] = [];
  const flow = createOutputFlowController({
    highWaterMark: 50,
    lowWaterMark: 10,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  flow.received(60);
  enqueueTerminalWrite(term, 20, (done) => done());
  teardownTerminalOutputPipeline(
    { terminalBackend: backend, sessionRef: { current: "sess-1" } } as never,
    term,
    "sess-1",
    flow,
  );

  assert.deepEqual(events, ["pause", "resume", "ipc-resume"]);
});

test("releaseTerminalFlowOutputForTerm resumes renderer pause without a flow controller", () => {
  const term = createFakeTerm();
  const events: string[] = [];
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  releaseTerminalFlowOutputForTerm(term, backend, "sess-1", undefined);

  assert.deepEqual(events, ["ipc-resume"]);
});

test("prioritizeTerminalInput flushes batched ack remainders after dropping bytes", () => {
  const term = createFakeTerm();
  const acked: number[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  const backend = {
    setSessionFlowPaused: () => {},
    ackSessionFlow: (_sessionId: string, bytes: number) => {
      acked.push(bytes);
    },
  };

  flow.received(FLOW_LOW_WATER_MARK + 80);
  enqueueTerminalWrite(term, 50, () => {});
  enqueueTerminalWrite(term, 30, () => {});
  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
  );

  assert.deepEqual(acked, []);
  deferred[0]!();
  assert.deepEqual(acked, [30]);
});

test("prioritizeTerminalInput flushes deferred xterm write ack bytes", () => {
  clearTerminalSessionFlowAck("sess-1");
  const term = createFakeTerm();
  const acked: number[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  const backend = {
    ackSessionFlow: (_sessionId: string, bytes: number) => {
      acked.push(bytes);
    },
    setSessionFlowPaused: () => {},
  };

  accumulateDeferredTerminalWriteAck(term, 42);
  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
  );

  assert.deepEqual(acked, []);
  deferred[0]!();
  assert.deepEqual(acked, [42]);
  assert.equal(flow.pendingBytes(), 0);
  clearTerminalSessionFlowAck("sess-1");
});

test("prioritizeTerminalInput drains backlog before user input is forwarded", () => {
  const term = createFakeTerm();
  const events: string[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  flow.received(FLOW_LOW_WATER_MARK + 1024);
  let release: (() => void) | null = null;
  enqueueTerminalWrite(term, 30, (done) => {
    release = done;
  });
  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
  );
  release?.();

  assert.equal(events.includes("ipc-resume"), false);
  events.push("input-forwarded");
  deferred[0]!();
  assert.ok(events.includes("ipc-resume"));
  assert.deepEqual(events.slice(-2), ["input-forwarded", "ipc-resume"]);
});

test("prioritizeTerminalInput does not resume while collecting dropped bytes", () => {
  const term = createFakeTerm();
  const events: string[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  flow.received(110);
  enqueueTerminalWrite(term, 10, () => {});
  enqueueTerminalWrite(term, 100, () => {});
  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
  );

  assert.deepEqual(events, ["pause"]);
  events.push("input-forwarded");
  deferred[0]!();

  assert.deepEqual(events, ["pause", "input-forwarded", "ipc-resume"]);
});

test("prioritizeTerminalInput defers source resume until after input is forwarded", () => {
  clearTerminalSessionFlowAck("sess-1");
  const term = createFakeTerm();
  const events: string[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  flow.received(FLOW_LOW_WATER_MARK + 1024);
  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
  );

  assert.equal(flow.isPaused(), false);
  assert.deepEqual(events, ["pause"]);
  assert.equal(deferred.length, 1);

  events.push("input-forwarded");
  deferred[0]!();

  assert.deepEqual(events, ["pause", "input-forwarded", "ipc-resume"]);
  clearTerminalSessionFlowAck("sess-1");
});

test("interrupt display gate is only enabled for ssh-like protocols", () => {
  assert.equal(shouldArmTerminalInterruptDisplayGateForProtocol(undefined), true);
  assert.equal(shouldArmTerminalInterruptDisplayGateForProtocol("ssh"), true);
  assert.equal(shouldArmTerminalInterruptDisplayGateForProtocol("local"), false);
  assert.equal(shouldArmTerminalInterruptDisplayGateForProtocol("telnet"), false);
  assert.equal(shouldArmTerminalInterruptDisplayGateForProtocol("serial"), false);
});

test("interrupt display gate is not armed when there is no renderer backlog", () => {
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };

  const priority = prioritizeTerminalInput(
    term,
    "sess-1",
    undefined,
    backend,
    (callback: () => void) => callback(),
    { reason: "interrupt", now: 900, quietMs: 500, promptQuietMs: 80, maxDrainMs: 1000 },
  );

  assert.equal(priority.skippedReason, "below-threshold");
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "KeyboardInterrupt\r\n$ ", { now: 901 }),
    {
      accepted: true,
      data: "KeyboardInterrupt\r\n$ ",
      droppedBytes: 0,
      reason: "inactive",
    },
  );
});

test("interrupt display gate is not armed for deferred ack-only output", () => {
  clearTerminalSessionFlowAck("sess-deferred");
  const term = createFakeTerm();
  const acked: number[] = [];
  const deferred: Array<() => void> = [];
  const backend = {
    ackSessionFlow: (_sessionId: string, bytes: number) => {
      acked.push(bytes);
    },
    setSessionFlowPaused: () => {},
  };

  accumulateDeferredTerminalWriteAck(term, 42);
  const priority = prioritizeTerminalInput(
    term,
    "sess-deferred",
    undefined,
    backend,
    (callback: () => void) => deferred.push(callback),
    { reason: "interrupt", now: 950, quietMs: 500, promptQuietMs: 80, maxDrainMs: 1000 },
  );

  assert.equal(priority.deferredAckBytes, 42);
  assert.equal(priority.scheduledBackendResume, true);
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "KeyboardInterrupt\r\n$ ", { now: 951 }),
    {
      accepted: true,
      data: "KeyboardInterrupt\r\n$ ",
      droppedBytes: 0,
      reason: "inactive",
    },
  );

  deferred[0]!();
  assert.deepEqual(acked, [42]);
  clearTerminalSessionFlowAck("sess-deferred");
});

test("interrupt display gate drops stale output until the interrupt echo", () => {
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    { reason: "interrupt", now: 1000, quietMs: 500, promptQuietMs: 80, maxDrainMs: 1000 },
  );

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "old output", { now: 1001 }),
    { accepted: false, data: "", droppedBytes: 10, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "more old^C\r\n$ ", { now: 1002 }),
    { accepted: true, data: "^C\r\n$ ", droppedBytes: 8, reason: "interrupt-echo" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "next output", { now: 1003 }),
    { accepted: true, data: "next output", droppedBytes: 0, reason: "inactive" },
  );
});

test("interrupt display gate resumes when interrupt echo is split across chunks", () => {
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    { reason: "interrupt", now: 1200, quietMs: 500, promptQuietMs: 80, maxDrainMs: 1000 },
  );

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "old output", { now: 1201 }),
    { accepted: false, data: "", droppedBytes: 10, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "^", { now: 1202 }),
    { accepted: false, data: "", droppedBytes: 1, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "C\r\n$ ", { now: 1203 }),
    {
      accepted: true,
      data: "^C\r\n$ ",
      droppedBytes: 0,
      acceptedBytes: 5,
      reason: "interrupt-echo",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "next output", { now: 1204 }),
    { accepted: true, data: "next output", droppedBytes: 0, reason: "inactive" },
  );
});

test("interrupt display gate accepts a prompt after a quiet gap and ordinary input disarms it", () => {
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    { reason: "interrupt", now: 2000, quietMs: 500, promptQuietMs: 80, maxDrainMs: 1000 },
  );

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "old output", { now: 2001 }),
    { accepted: false, data: "", droppedBytes: 10, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "$ ", { now: 2100 }),
    { accepted: true, data: "$ ", droppedBytes: 0, reason: "prompt-gap" },
  );

  flow.received(FLOW_LOW_WATER_MARK + 1);
  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    { reason: "interrupt", now: 3000, quietMs: 500, promptQuietMs: 80, maxDrainMs: 1000 },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "old output", { now: 3001 }),
    { accepted: false, data: "", droppedBytes: 10, reason: "draining" },
  );

  prioritizeTerminalInput(
    term,
    "sess-1",
    undefined,
    backend,
    (callback: () => void) => callback(),
    { reason: "input", now: 3002 },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "fresh output", { now: 3003 }),
    { accepted: true, data: "fresh output", droppedBytes: 0, reason: "inactive" },
  );
});

test("interrupt display gate falls back after quiet and max-drain limits", () => {
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    { reason: "interrupt", now: 4000, quietMs: 100, promptQuietMs: 80, maxDrainMs: 1000 },
  );

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "old output", { now: 4001 }),
    { accepted: false, data: "", droppedBytes: 10, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "fresh output", { now: 4120 }),
    { accepted: true, data: "fresh output", droppedBytes: 0, reason: "quiet-gap" },
  );

  flow.received(FLOW_LOW_WATER_MARK + 1);
  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    { reason: "interrupt", now: 5000, quietMs: 500, promptQuietMs: 80, maxDrainMs: 100 },
  );

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "old output", { now: 5001 }),
    { accepted: false, data: "", droppedBytes: 10, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "latest output", { now: 5100 }),
    { accepted: true, data: "latest output", droppedBytes: 0, reason: "max-drain" },
  );
});
