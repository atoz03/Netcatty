import assert from "node:assert/strict";
import test from "node:test";

import type { AISession } from "../../infrastructure/ai/types.ts";
import { resolveDisplayedPanelView } from "./aiPanelViewState.ts";
import {
  _getScopedHistoryCacheSizeForTests,
  getScopedHistorySessions,
} from "./scopedHistorySessions.ts";

function createSession(
  id: string,
  scope: AISession["scope"],
  updatedAt: number,
): AISession {
  return {
    id,
    title: id,
    agentId: "catty",
    scope,
    messages: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

test("workspace auto-resume keeps scope rank ahead of recency", () => {
  const sessions = [
    createSession("exact-older", { type: "workspace", targetId: "workspace-current" }, 1),
    createSession("member-newer", { type: "terminal", targetId: "member" }, 2),
    createSession("other-newest", { type: "workspace", targetId: "workspace-other" }, 20),
  ];
  const history = getScopedHistorySessions(
    sessions, "workspace", "workspace-current", [], new Set(), new Set(["member"]),
  );
  assert.deepEqual(history.map((session) => session.id), ["member-newer", "exact-older", "other-newest"]);
  const preferredId = history[0]?.id ?? null;
  assert.deepEqual(resolveDisplayedPanelView(undefined, false, history, undefined, "workspace", undefined, preferredId),
    { mode: "session", sessionId: "member-newer" });

  // The ranking only controls implicit fallback, never an explicit selection,
  // saved selection, anchor, or deliberate new-chat draft.
  for (const [view, persisted, anchor] of [
    [{ mode: "session", sessionId: "other-newest" }, undefined, undefined],
    [undefined, "other-newest", undefined],
    [undefined, undefined, "other-newest"],
  ] as const) {
    assert.deepEqual(resolveDisplayedPanelView(view, false, history, persisted, "workspace", anchor, preferredId),
      { mode: "session", sessionId: "other-newest" });
  }
  assert.deepEqual(resolveDisplayedPanelView({ mode: "draft" }, true, history, undefined, "workspace", undefined, preferredId),
    { mode: "draft" });
  assert.deepEqual(resolveDisplayedPanelView(undefined, false, history, undefined, "terminal", undefined, preferredId),
    { mode: "draft" });
});

test("workspace auto-resume prefers an exact match and retains history fallback when none exists", () => {
  const exact = createSession("exact", { type: "workspace", targetId: "workspace-current" }, 1);
  const others = [
    createSession("other-old", { type: "workspace", targetId: "workspace-other" }, 5),
    createSession("other-new", { type: "workspace", targetId: "workspace-other" }, 10),
  ];
  for (const [sessions, expected] of [[others, "other-new"], [[...others, exact], "exact"], [[], undefined]] as const) {
    const history = getScopedHistorySessions([...sessions], "workspace", "workspace-current", [], new Set());
    assert.deepEqual(resolveDisplayedPanelView(undefined, false, history, undefined, "workspace", undefined, history[0]?.id ?? null),
      expected ? { mode: "session", sessionId: expected } : { mode: "draft" });
  }
});

test("workspace history remains visible after the original workspace target is gone", () => {
  const staleWorkspaceSession = createSession(
    "workspace-stale",
    { type: "workspace", targetId: "workspace-before-restart" },
    2,
  );

  const sessions = [
    staleWorkspaceSession,
    createSession("terminal-session", { type: "terminal", targetId: "terminal-1" }, 3),
  ];

  assert.deepEqual(
    getScopedHistorySessions(
      sessions,
      "workspace",
      "workspace-after-restart",
      undefined,
      new Set(),
    ),
    [staleWorkspaceSession],
  );
});

test("workspace history includes member-terminal chats and ranks them above stale workspaces", () => {
  const memberTerminalSession = createSession(
    "terminal-a-chat",
    { type: "terminal", targetId: "terminal-a" },
    1,
  );
  const staleWorkspaceSession = createSession(
    "workspace-stale",
    { type: "workspace", targetId: "workspace-before-restart", hostIds: ["host-a"] },
    99,
  );

  assert.deepEqual(
    getScopedHistorySessions(
      [staleWorkspaceSession, memberTerminalSession],
      "workspace",
      "workspace-merged",
      ["host-a"],
      new Set(),
      new Set(["terminal-a", "terminal-b"]),
    ).map((session) => session.id),
    ["terminal-a-chat", "workspace-stale"],
  );
});

test("terminal history without host ids remains visible after the original terminal target is gone", () => {
  const staleLocalSession = createSession(
    "terminal-local-stale",
    { type: "terminal", targetId: "terminal-before-restart" },
    2,
  );

  assert.deepEqual(
    getScopedHistorySessions(
      [staleLocalSession],
      "terminal",
      "terminal-after-restart",
      undefined,
      new Set(),
    ),
    [staleLocalSession],
  );
});

test("scoped history orders exact then host-matched sessions and hides chats without host identity", () => {
  const staleSameScopeSession = createSession(
    "same-scope-stale",
    { type: "terminal", targetId: "terminal-closed" },
    100,
  );
  const hostMatchedSession = createSession(
    "host-match",
    { type: "terminal", targetId: "terminal-other", hostIds: ["host-a"] },
    2,
  );
  const exactSession = createSession(
    "exact",
    { type: "terminal", targetId: "terminal-current" },
    1,
  );

  assert.deepEqual(
    getScopedHistorySessions(
      [staleSameScopeSession, hostMatchedSession, exactSession],
      "terminal",
      "terminal-current",
      ["host-a"],
      new Set(),
    ).map((session) => session.id),
    // 无主机的过期会话无法确认属于 host-a，因此不在这里提供
    // （仍可通过 /chats + /rebind 恢复）。
    ["exact", "host-match"],
  );
});

test("same-scope fallback excludes sessions already displayed by another terminal", () => {
  const displayedElsewhere = createSession(
    "displayed-elsewhere",
    { type: "terminal", targetId: "terminal-before-restart" },
    2,
  );

  assert.deepEqual(
    getScopedHistorySessions(
      [displayedElsewhere],
      "terminal",
      "terminal-after-restart",
      undefined,
      new Set(["displayed-elsewhere"]),
    ),
    [],
  );
});

test("workspace cache ignores unrelated active terminal churn", () => {
  const sessions = [createSession("workspace", { type: "workspace", targetId: "workspace-1" }, 1)];
  const first = getScopedHistorySessions(
    sessions,
    "workspace",
    "workspace-1",
    undefined,
    new Set(["terminal-0"]),
  );
  for (let index = 1; index < 1_000; index += 1) {
    assert.equal(getScopedHistorySessions(
      sessions,
      "workspace",
      "workspace-1",
      undefined,
      new Set([`terminal-${index}`]),
    ), first);
  }
  assert.equal(_getScopedHistoryCacheSizeForTests(sessions), 1);
});

test("terminal scoped history cache has a hard LRU bound", () => {
  const sessions = [createSession("terminal", { type: "terminal", targetId: "terminal-current" }, 1)];
  for (let index = 0; index < 1_000; index += 1) {
    getScopedHistorySessions(
      sessions,
      "terminal",
      "terminal-current",
      undefined,
      new Set([`other-session-${index}`]),
    );
  }
  assert.ok(_getScopedHistoryCacheSizeForTests(sessions) <= 64);
});

test("workspace history retains chats resumed by members from older terminals", () => {
  const resumed = createSession("resumed", {
    type: "terminal", targetId: "closed-terminal", hostIds: ["host-a"],
  }, 1);
  const unrelated = createSession("unrelated", {
    type: "terminal", targetId: "another-closed-terminal", hostIds: ["host-a"],
  }, 2);
  const staleWorkspace = createSession("stale-workspace", {
    type: "workspace", targetId: "old-workspace", hostIds: ["host-a"],
  }, 99);
  const sessions = [staleWorkspace, unrelated, resumed];
  const members = new Set(["terminal-a", "terminal-b"]);
  const selected = {
    "terminal:terminal-a": "resumed",
    "terminal:terminal-outside": "unrelated",
  };

  assert.ok(getScopedHistorySessions(
    sessions, "terminal", "terminal-a", ["host-a"], new Set(["unrelated"]),
  ).includes(resumed));
  assert.deepEqual(getScopedHistorySessions(
    sessions, "workspace", "merged", ["host-a"], new Set(Object.values(selected)),
    members, selected,
  ), [resumed, staleWorkspace]);
  // Returning to A makes the same stored conversation available again.
  assert.ok(getScopedHistorySessions(
    sessions, "terminal", "terminal-a", ["host-a"], new Set(["unrelated"]),
  ).includes(resumed));
  assert.equal(resumed.scope.targetId, "closed-terminal");
});

test("workspace history cache tracks member selections but ignores unrelated selections", () => {
  const sessions = [createSession("resumed", { type: "terminal", targetId: "closed" }, 1)];
  const members = new Set(["terminal-a"]);
  const history = (selected: Record<string, string | null>) => getScopedHistorySessions(
    sessions, "workspace", "merged", undefined, new Set(), members, selected,
  );
  const empty = history({});
  assert.deepEqual(empty, []);
  const inherited = history({ "terminal:terminal-a": "resumed" });
  assert.deepEqual(inherited, sessions);
  assert.equal(history({
    "terminal:terminal-a": "resumed", "terminal:outside": "other",
  }), inherited);
  assert.equal(history({ "terminal:terminal-a": null }), empty);
  assert.equal(history({ "workspace:unrelated": "resumed" }), empty);
  assert.equal(_getScopedHistoryCacheSizeForTests(sessions), 2);
});

test("closed terminals' kept pointers do not hide a host's chats from a new terminal", async () => {
  const { collectSessionIdsDisplayedByOtherTerminals } = await import("./sessionScopeMatch.ts");
  const lastChat = createSession("last-chat", {
    type: "terminal", targetId: "terminal-closed", hostIds: ["host-a"],
  }, 5);
  const openElsewhere = createSession("open-elsewhere", {
    type: "terminal", targetId: "terminal-old", hostIds: ["host-a"],
  }, 6);
  const activeSessionIdMap = {
    // 终端关闭后为 /chats 恢复而保留（issue #4015 R2）。
    "terminal:terminal-closed": "last-chat",
    // 仍由同一主机的存活终端显示。
    "terminal:terminal-live": "open-elsewhere",
  };
  const live = new Set(["terminal-live", "terminal-new"]);
  const displayedElsewhere = collectSessionIdsDisplayedByOtherTerminals(
    activeSessionIdMap, "terminal:terminal-new", live,
  );
  assert.deepEqual([...displayedElsewhere], ["open-elsewhere"]);
  assert.deepEqual(
    getScopedHistorySessions(
      [lastChat, openElsewhere], "terminal", "terminal-new", ["host-a"], displayedElsewhere,
    ).map((session) => session.id),
    ["last-chat"],
  );
  // 没有存活信息时，所有指针仍按存活处理。
  assert.deepEqual(
    [...collectSessionIdsDisplayedByOtherTerminals(activeSessionIdMap, "terminal:terminal-new")].sort(),
    ["last-chat", "open-elsewhere"],
  );
});

test("every conversation of a saved host is offered after reconnect or restart, and only to that host", () => {
  const sessions = [
    createSession("a-1", { type: "terminal", targetId: "t-a-1", hostIds: ["host-a"] }, 1),
    createSession("a-2", { type: "terminal", targetId: "t-a-2", hostIds: ["host-a"] }, 2),
    createSession("a-3", { type: "terminal", targetId: "t-a-3", hostIds: ["host-a"] }, 3),
    createSession("b-1", { type: "terminal", targetId: "t-b-1", hostIds: ["host-b"] }, 4),
    createSession("legacy", { type: "terminal", targetId: "t-old" }, 5),
  ];
  const forHost = (hostId: string, terminalId: string) => getScopedHistorySessions(
    sessions, "terminal", terminalId, [hostId], new Set(),
  ).map((session) => session.id);
  // 重连 / 应用重启后的新终端 id 仍能看到该主机的会话。
  assert.deepEqual(forHost("host-a", "t-a-new"), ["a-3", "a-2", "a-1"]);
  assert.deepEqual(forHost("host-b", "t-b-new"), ["b-1"]);
  // 切换到没有会话的主机时，不显示其他主机的任何内容。
  assert.deepEqual(forHost("host-c", "t-c-new"), []);
});

test("workspace history only offers other workspaces' chats that share a host", () => {
  const sessions = [
    createSession("ws-ab", { type: "workspace", targetId: "old-1", hostIds: ["host-a", "host-b"] }, 3),
    createSession("ws-cd", { type: "workspace", targetId: "old-2", hostIds: ["host-c", "host-d"] }, 9),
    createSession("ws-legacy", { type: "workspace", targetId: "old-3" }, 10),
  ];
  const history = getScopedHistorySessions(
    sessions, "workspace", "ws-new", ["host-b"], new Set(),
  );
  assert.deepEqual(history.map((session) => session.id), ["ws-ab"]);
  // 因此自动恢复永远不会打开其他服务器的工作区会话。
  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, history, undefined, "workspace", undefined, history[0]?.id ?? null),
    { mode: "session", sessionId: "ws-ab" },
  );
});
