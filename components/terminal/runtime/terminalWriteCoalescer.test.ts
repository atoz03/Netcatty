import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  enqueueCoalescedTerminalWrite,
  resetTerminalWriteCoalescer,
  setTerminalWriteCoalescerByteCapResolver,
} from "./terminalWriteCoalescer.ts";

const createFakeTerm = () => ({}) as XTerm;

test("splits a single flood-sized terminal batch before it reaches xterm", () => {
  const term = createFakeTerm();
  const writes: Array<{ data: string; ingressBytes: number }> = [];

  setTerminalWriteCoalescerByteCapResolver(term, () => 8);
  enqueueCoalescedTerminalWrite(
    term,
    "x".repeat(20),
    (data, ingressBytes) => {
      writes.push({ data, ingressBytes });
    },
    30,
  );

  assert.deepEqual(
    writes.map((write) => write.data.length),
    [8, 8, 4],
  );
  assert.deepEqual(
    writes.map((write) => write.ingressBytes),
    [12, 12, 6],
  );

  resetTerminalWriteCoalescer(term);
});
