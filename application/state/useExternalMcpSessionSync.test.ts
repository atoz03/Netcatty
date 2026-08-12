import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createLatestPayloadSync } from './useExternalMcpSessionSync.ts';

const hookSource = readFileSync(new URL('./useExternalMcpSessionSync.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app/AppSideEffects.tsx', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../../electron/preload/api.cjs', import.meta.url), 'utf8');
const handlerSource = readFileSync(
  new URL('../../electron/bridges/aiBridge/agentProcessHandlers.cjs', import.meta.url),
  'utf8',
);

test('app live session sync stays mounted and is independent of External MCP enablement', () => {
  assert.match(appSource, /useExternalMcpSessionSync\(\{/);
  assert.match(hookSource, /bridge\.aiMcpUpdateLiveSessions\?\.\(nextPayload\)/);
  assert.match(hookSource, /liveSyncRef\.current\.push\(payload, serialized\)/);
  assert.match(hookSource, /bridge\.aiMcpUpdateSessions\?\.\(/);
  assert.match(hookSource, /externalSyncRef\.current\.push\(payload, serialized\)/);
  assert.doesNotMatch(
    hookSource,
    /if \(!enabled\)[\s\S]{0,300}aiMcpUpdateLiveSessions/,
  );
});

test('live session sync has a complete renderer to main-process IPC path', () => {
  assert.match(preloadSource, /netcatty:ai:mcp:update-live-sessions/);
  assert.match(handlerSource, /netcatty:ai:mcp:update-live-sessions/);
  assert.match(handlerSource, /mcpServerBridge\.updateLiveSessionMetadata/);
});

test('latest payload sync converges to A-B-A while B is in flight', async () => {
  let releaseB: (() => void) | undefined;
  const sent: string[] = [];
  const sync = createLatestPayloadSync(async (payload: string) => {
    sent.push(payload);
    if (payload === 'B') {
      await new Promise<void>((resolve) => {
        releaseB = resolve;
      });
    }
    return { ok: true };
  });

  await sync.push('A');
  const sendingB = sync.push('B');
  void sync.push('A');
  releaseB?.();
  await sendingB;

  assert.deepEqual(sent, ['A', 'B', 'A']);
});

test('cancelling a payload sync drops a queued update', async () => {
  let releaseA: (() => void) | undefined;
  const sent: string[] = [];
  const sync = createLatestPayloadSync(async (payload: string) => {
    sent.push(payload);
    if (payload === 'A') {
      await new Promise<void>((resolve) => {
        releaseA = resolve;
      });
    }
    return { ok: true };
  });

  const sendingA = sync.push('A');
  void sync.push('B');
  sync.cancel();
  releaseA?.();
  await sendingA;

  assert.deepEqual(sent, ['A']);
});
