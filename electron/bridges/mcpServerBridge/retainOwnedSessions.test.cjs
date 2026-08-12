"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { retainOwnedSessions, mergeRetentionMeta } = require("./retainOwnedSessions.cjs");

test("retainOwnedSessions keeps host_open-owned sessions dropped by a full scope replace", () => {
  const previousById = new Map([
    ["sess-original", {
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    }],
    ["sess-opened", {
      hostname: "10.0.0.2",
      label: "server-b",
      protocol: "ssh",
      connected: false,
      hostId: "host-b",
    }],
  ]);

  const retained = retainOwnedSessions({
    incomingSessions: [{
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    }],
    ownedSessionIds: ["sess-opened"],
    previousById,
  });

  const ids = retained.map((entry) => entry.sessionId).sort();
  assert.deepEqual(ids, ["sess-opened", "sess-original"]);
  const opened = retained.find((entry) => entry.sessionId === "sess-opened");
  assert.equal(opened.label, "server-b");
  assert.equal(opened.hostId, "host-b");
  assert.equal(opened.connected, false);
});

test("retainOwnedSessions does not alter authoritative empty replaces", () => {
  const retained = retainOwnedSessions({
    incomingSessions: [],
    ownedSessionIds: ["sess-opened"],
    previousById: new Map([
      ["sess-opened", { hostname: "10.0.0.2", label: "server-b" }],
    ]),
  });
  assert.deepEqual(retained, []);
});

test("retainOwnedSessions falls back to cross-scope metadata when needed", () => {
  const retained = retainOwnedSessions({
    incomingSessions: [{ sessionId: "sess-original", label: "server-a" }],
    ownedSessionIds: ["sess-opened"],
    previousById: new Map(),
    findFallbackMeta: (sessionId) => (
      sessionId === "sess-opened"
        ? { hostname: "10.0.0.2", label: "server-b", hostId: "host-b" }
        : null
    ),
  });
  assert.equal(retained.length, 2);
  assert.equal(
    retained.find((entry) => entry.sessionId === "sess-opened")?.label,
    "server-b",
  );
});

test("retainOwnedSessions ignores owned ids with no recoverable metadata", () => {
  const retained = retainOwnedSessions({
    incomingSessions: [{ sessionId: "sess-original", label: "server-a" }],
    ownedSessionIds: ["sess-ghost"],
    previousById: new Map(),
  });
  assert.deepEqual(retained.map((entry) => entry.sessionId), ["sess-original"]);
});

test("retainOwnedSessions refreshes connected from fallback even when previous exists", () => {
  const retained = retainOwnedSessions({
    incomingSessions: [{
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
    }],
    ownedSessionIds: ["sess-opened"],
    previousById: new Map([
      ["sess-opened", {
        hostname: "10.0.0.2",
        label: "server-b",
        connected: false,
        hostId: "host-b",
      }],
    ]),
    findFallbackMeta: (sessionId) => (
      sessionId === "sess-opened"
        ? {
          hostname: "10.0.0.2",
          label: "server-b",
          connected: true,
          hostId: "host-b",
          username: "root",
        }
        : null
    ),
  });

  const opened = retained.find((entry) => entry.sessionId === "sess-opened");
  assert.ok(opened);
  assert.equal(opened.connected, true);
  assert.equal(opened.username, "root");
  assert.equal(opened.hostId, "host-b");
});

test("mergeRetentionMeta lets a later disconnected fallback replace connected:true", () => {
  const merged = mergeRetentionMeta(
    {
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
    },
    {
      hostname: "10.0.0.2",
      label: "server-b",
      connected: false,
      hostId: "host-b",
    },
  );
  assert.equal(merged.connected, false);
});

test("retainOwnedSessions applies a later disconnect from fallback metadata", () => {
  const retained = retainOwnedSessions({
    incomingSessions: [{
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
    }],
    ownedSessionIds: ["sess-opened"],
    previousById: new Map([
      ["sess-opened", {
        hostname: "10.0.0.2",
        label: "server-b",
        connected: true,
        hostId: "host-b",
      }],
    ]),
    findFallbackMeta: (sessionId) => (
      sessionId === "sess-opened"
        ? {
          hostname: "10.0.0.2",
          label: "server-b",
          connected: false,
          hostId: "host-b",
        }
        : null
    ),
  });

  const opened = retained.find((entry) => entry.sessionId === "sess-opened");
  assert.ok(opened);
  assert.equal(opened.connected, false);
});

test("mergeRetentionMeta clears activePortForwards when fallback reports an empty array", () => {
  const merged = mergeRetentionMeta(
    {
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      activePortForwards: [{ ruleId: "fwd-1", localPort: 8080, status: "active" }],
    },
    {
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      activePortForwards: [],
    },
  );
  assert.deepEqual(merged.activePortForwards, []);
});

test("mergeRetentionMeta keeps prior activePortForwards when fallback omits them", () => {
  const prior = [{ ruleId: "fwd-1", localPort: 8080, status: "active" }];
  const merged = mergeRetentionMeta(
    {
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      activePortForwards: prior,
    },
    {
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
    },
  );
  assert.deepEqual(merged.activePortForwards, prior);
});

test("retainOwnedSessions applies empty activePortForwards from fallback metadata", () => {
  const retained = retainOwnedSessions({
    incomingSessions: [{
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
    }],
    ownedSessionIds: ["sess-opened"],
    previousById: new Map([
      ["sess-opened", {
        hostname: "10.0.0.2",
        label: "server-b",
        connected: false,
        hostId: "host-b",
        activePortForwards: [{ ruleId: "fwd-1", localPort: 8080, status: "active" }],
      }],
    ]),
    findFallbackMeta: (sessionId) => (
      sessionId === "sess-opened"
        ? {
          hostname: "10.0.0.2",
          label: "server-b",
          connected: true,
          hostId: "host-b",
          activePortForwards: [],
        }
        : null
    ),
  });

  const opened = retained.find((entry) => entry.sessionId === "sess-opened");
  assert.ok(opened);
  assert.deepEqual(opened.activePortForwards, []);
  assert.equal(opened.connected, true);
});

test("mergeRetentionMeta keeps the higher metadata revision in either argument", () => {
  const oldConnected = {
    connected: true,
    username: "old-user",
    activePortForwards: [{ ruleId: "old-forward" }],
    _revision: 4,
  };
  const newDisconnected = {
    connected: false,
    username: "new-user",
    activePortForwards: [],
    _revision: 7,
  };

  for (const merged of [
    mergeRetentionMeta(oldConnected, newDisconnected),
    mergeRetentionMeta(newDisconnected, oldConnected),
  ]) {
    assert.equal(merged.connected, false);
    assert.equal(merged.username, "new-user");
    assert.deepEqual(merged.activePortForwards, []);
    assert.equal(merged._revision, 7);
  }
});
