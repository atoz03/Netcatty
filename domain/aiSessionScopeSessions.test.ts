import test from "node:test";
import assert from "node:assert/strict";

import { resolveAgentScopeSessions } from "./aiSessionScopeSessions";

const session = (sessionId: string, label = sessionId) => ({ sessionId, label });

test("current mode only exposes the chat's own scope", () => {
  const scoped = [session("a")];
  const all = [session("a"), session("b")];
  assert.deepEqual(resolveAgentScopeSessions({ mode: "current", scopedSessions: scoped, allOpenSessions: all }), scoped);
});

test("all-open mode merges app-wide sessions after the scoped ones", () => {
  const scoped = [session("a")];
  const all = [session("b"), session("a")];
  const merged = resolveAgentScopeSessions({ mode: "all-open", scopedSessions: scoped, allOpenSessions: all });
  assert.deepEqual(merged.map((entry) => entry.sessionId), ["a", "b"]);
});

test("all-open mode keeps scoped entries authoritative on duplicate sessionIds", () => {
  const scoped = [session("a", "scoped-label")];
  const all = [session("a", "stale-label")];
  const merged = resolveAgentScopeSessions({ mode: "all-open", scopedSessions: scoped, allOpenSessions: all });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].label, "scoped-label");
});

test("all-open mode without an app-wide list falls back to the scope", () => {
  const scoped = [session("a")];
  assert.deepEqual(
    resolveAgentScopeSessions({ mode: "all-open", scopedSessions: scoped, allOpenSessions: [] }),
    scoped,
  );
  assert.deepEqual(
    resolveAgentScopeSessions({ mode: "all-open", scopedSessions: scoped }),
    scoped,
  );
});

test("sessions without a sessionId are forwarded once each", () => {
  type Anonymous = { sessionId?: string; label: string };
  const scoped: Anonymous[] = [{ label: "anonymous" }];
  const all: Anonymous[] = [{ label: "other" }];
  const merged = resolveAgentScopeSessions<Anonymous>({ mode: "all-open", scopedSessions: scoped, allOpenSessions: all });
  assert.deepEqual(merged.map((entry) => entry.label), ["anonymous", "other"]);
});
