/**
 * 跨应用重启的按主机 AI 历史：已保存主机的每个会话都从 IndexedDB 恢复，
 * 出现在该主机的任意新终端中（终端 id 在重连/重启后会变化），且绝不出现在
 * 其他主机中。已关闭终端保留的活动指针不能隐藏这些会话。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { AISession } from '../../infrastructure/ai/types';
import { STORAGE_KEY_AI_ACTIVE_SESSION_MAP, STORAGE_KEY_AI_SESSION_MESSAGE_CAP } from '../../infrastructure/config/storageKeys';
import { useAIState } from './useAIState';
import { getAISessionsSnapshot } from './aiSessionsStore';
import {
  __flushIdbWritesForTests,
  __resetAITargetHostIdsSnapshotForTests,
  __resetAiSessionsHydrationForTests,
  __resetBackupMirrorForTests,
  __resetIdbPersistenceForTests,
  setLatestAIActiveSessionMapSnapshot,
  setLatestAIDraftsByScopeSnapshot,
  setLatestAIPanelViewByScopeSnapshot,
  setLatestAISessionsSnapshot,
} from './aiStateSnapshots';
import { idbPutSessions, openAiSessionsIdb, resetAiSessionsIdbForTests } from './aiSessionIdbStorage';
import { installFakeIndexedDb } from './testSupport/fakeIndexedDb';
import { getScopedHistorySessions } from '../../components/ai/scopedHistorySessions';
import { collectSessionIdsDisplayedByOtherTerminals } from '../../components/ai/sessionScopeMatch';
import { isChatListedForRecovery } from '../../components/ai/aiChatsListing';

function chat(id: string, updatedAt: number, targetId: string, hostIds?: string[]): AISession {
  return {
    id,
    title: id,
    agentId: 'catty',
    scope: { type: 'terminal', targetId, ...(hostIds ? { hostIds } : {}) },
    messages: [{ id: `${id}-m`, role: 'user', content: `hello from ${id}`, timestamp: updatedAt }],
    externalSessionId: `native-${id}`,
    createdAt: updatedAt,
    updatedAt,
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  return dom;
}

function resetBootState() {
  __resetIdbPersistenceForTests();
  __resetAiSessionsHydrationForTests();
  __resetAITargetHostIdsSnapshotForTests();
  setLatestAISessionsSnapshot([]);
  setLatestAIActiveSessionMapSnapshot(null as unknown as Record<string, string | null>);
  setLatestAIDraftsByScopeSnapshot({});
  setLatestAIPanelViewByScopeSnapshot({});
}

async function mountAiState() {
  const holder: { ai?: ReturnType<typeof useAIState> } = {};
  function Harness() {
    holder.ai = useAIState();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Harness)); });
  return { ai: () => holder.ai!, root, container };
}

function historyFor(terminalId: string, hostIds: string[], live: Set<string>) {
  const { sessions, activeSessionIdMap } = getAISessionsSnapshot();
  const scopeKey = `terminal:${terminalId}`;
  return getScopedHistorySessions(
    sessions as AISession[],
    'terminal',
    terminalId,
    hostIds,
    collectSessionIdsDisplayedByOtherTerminals(activeSessionIdMap, scopeKey, live),
    undefined,
    activeSessionIdMap,
  ).map((session) => session.id);
}

test.beforeEach(() => {
  __resetBackupMirrorForTests();
  resetBootState();
});
test.afterEach(() => {
  __resetBackupMirrorForTests();
  __resetAITargetHostIdsSnapshotForTests();
});

test('app reload restores every chat of a host into a new terminal of that host, isolated from other hosts', async () => {
  const dom = installDom();
  const idb = installFakeIndexedDb();
  const stored = [
    chat('a-first', 1, 'old-a-1', ['host-a']),
    chat('a-last', 3, 'old-a-2', ['host-a']),
    chat('b-only', 2, 'old-b-1', ['host-b']),
    chat('legacy', 4, 'old-legacy'),
  ];
  await idbPutSessions(await openAiSessionsIdb(), stored);
  // 重启后已不存在的终端留下的活动指针。
  dom.window.localStorage.setItem(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, JSON.stringify({
    'terminal:old-a-1': 'a-first',
    'terminal:old-a-2': 'a-last',
    'terminal:old-b-1': 'b-only',
  }));
  let mounted = await mountAiState();
  try {
    const live = new Set(['new-a', 'new-b']);
    await act(async () => {
      mounted.ai().cleanupOrphanedSessions(live, new Map([['new-a', ['host-a']], ['new-b', ['host-b']]]));
    });
    await __flushIdbWritesForTests();

    // 除悬挂标记外，没有任何内容被删除或改写。
    const restored = getAISessionsSnapshot().sessions;
    assert.equal(restored.length, 4);
    for (const original of stored) {
      const current = restored.find((session) => session.id === original.id)!;
      assert.deepEqual(current.messages, original.messages);
      assert.equal(current.externalSessionId, original.externalSessionId);
      assert.deepEqual(current.scope.hostIds, original.scope.hostIds);
    }

    assert.deepEqual(historyFor('new-a', ['host-a'], live), ['a-last', 'a-first']);
    assert.deepEqual(historyFor('new-b', ['host-b'], live), ['b-only']);
    assert.deepEqual(historyFor('new-c', ['host-c'], new Set([...live, 'new-c'])), []);

    // 无主机的旧会话不会显示给任何主机，但仍可通过 /chats 恢复，不会无处可寻。
    const legacy = restored.find((session) => session.id === 'legacy')!;
    assert.equal(legacy.scopeDangling, true);
    assert.equal(isChatListedForRecovery(legacy, new Set(['host-a', 'host-b'])), true);
    const bChat = restored.find((session) => session.id === 'b-only')!;
    assert.equal(isChatListedForRecovery(bChat, new Set(['host-a', 'host-b'])), false);
    // ……除非 host-b 已从密码库删除。
    assert.equal(isChatListedForRecovery(bChat, new Set(['host-a'])), true);

    // 第二次重启后全部仍在（持久保存，无保留丢失）。
    await act(async () => { mounted.root.unmount(); });
    mounted.container.remove();
    resetBootState();
    mounted = await mountAiState();
    await __flushIdbWritesForTests();
    assert.deepEqual(
      getAISessionsSnapshot().sessions.map((session) => session.id).sort(),
      ['a-first', 'a-last', 'b-only', 'legacy'],
    );
    assert.deepEqual(historyFor('newer-a', ['host-a'], new Set(['newer-a'])), ['a-last', 'a-first']);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.container.remove();
    dom.window.close();
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('closing a terminal and reconnecting keeps the conversation available to the same host', async () => {
  const dom = installDom();
  const idb = installFakeIndexedDb();
  let mounted = await mountAiState();
  try {
    await act(async () => {
      mounted.ai().cleanupOrphanedSessions(new Set(['term-1']), new Map([['term-1', ['host-a']]]));
    });
    let created: AISession | undefined;
    await act(async () => {
      created = mounted.ai().createSession({ type: 'terminal', targetId: 'term-1', hostIds: ['host-a'] });
    });
    await act(async () => {
      mounted.ai().addMessageToSession(created!.id, { id: 'u1', role: 'user', content: 'uptime', timestamp: 10 });
    });
    // 终端关闭；重连在同一主机上打开新的终端 id。
    const live = new Set(['term-2']);
    await act(async () => {
      mounted.ai().cleanupOrphanedSessions(live, new Map([['term-2', ['host-a']]]));
    });
    assert.equal(getAISessionsSnapshot().activeSessionIdMap['terminal:term-1'], created!.id);
    assert.deepEqual(historyFor('term-2', ['host-a'], live), [created!.id]);
    // 同时打开的另一台服务器看不到它。
    assert.deepEqual(historyFor('term-b', ['host-b'], new Set([...live, 'term-b'])), []);
    // 在新终端中恢复后，仅当该终端存活时，它才对同一主机的第三个终端隐藏。
    await act(async () => { mounted.ai().setActiveSessionId('terminal:term-2', created!.id); });
    assert.deepEqual(historyFor('term-3', ['host-a'], new Set(['term-2', 'term-3'])), []);
    assert.deepEqual(historyFor('term-3', ['host-a'], new Set(['term-3'])), [created!.id]);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.container.remove();
    dom.window.close();
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('a host archive with >1000 chats and >messageCap messages survives appends and app reload intact', async () => {
  const dom = installDom();
  const idb = installFakeIndexedDb();
  // 最低的消息上限，确保任何截断都会被发现。
  dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSION_MESSAGE_CAP, '50');
  const longMessages = Array.from({ length: 2500 }, (_, index) => ({
    id: `long-${index}`, role: (index % 2 ? 'assistant' : 'user') as 'assistant' | 'user', content: `m${index}`, timestamp: index,
  }));
  const hostChats = Array.from({ length: 1100 }, (_, index) => chat(`a-${index}`, index + 1, `old-${index}`, ['host-a']));
  hostChats[1099] = { ...hostChats[1099], messages: longMessages };
  await idbPutSessions(await openAiSessionsIdb(), hostChats);
  let mounted = await mountAiState();
  try {
    await __flushIdbWritesForTests();
    assert.equal(getAISessionsSnapshot().sessions.length, 1100);
    await act(async () => {
      mounted.ai().addMessageToSession('a-1099', { id: 'appended', role: 'user', content: 'more', timestamp: 9999 });
    });
    const appended = getAISessionsSnapshot().sessions.find((session) => session.id === 'a-1099')!;
    assert.equal(appended.messages.length, 2501);
    assert.equal(appended.messages[0].id, 'long-0');

    // 卸载时刷新防抖写入，然后模拟应用重启。
    await act(async () => { mounted.root.unmount(); });
    mounted.container.remove();
    await __flushIdbWritesForTests();
    resetBootState();
    mounted = await mountAiState();
    await __flushIdbWritesForTests();
    const restored = getAISessionsSnapshot().sessions;
    assert.equal(restored.length, 1100);
    const reloaded = restored.find((session) => session.id === 'a-1099')!;
    assert.equal(reloaded.messages.length, 2501);
    assert.equal(reloaded.messages[0].id, 'long-0');
    assert.equal(reloaded.messages.at(-1)?.id, 'appended');
    assert.equal(historyFor('new-a', ['host-a'], new Set(['new-a'])).length, 1100);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.container.remove();
    dom.window.close();
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});
