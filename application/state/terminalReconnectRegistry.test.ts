import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalReconnectRegistry } from './terminalReconnectRegistry';

test('a registered terminal session can be reconnected on request', () => {
  const registry = createTerminalReconnectRegistry();
  const requestedSessionIds: string[] = [];

  registry.register('session-1', () => requestedSessionIds.push('session-1'));

  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requestedSessionIds, ['session-1']);
});

test('requesting a terminal session before its handler mounts reconnects after registration', () => {
  const registry = createTerminalReconnectRegistry();
  const requests: string[] = [];

  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requests, []);

  registry.register('session-1', () => requests.push('session-1'));

  assert.deepEqual(requests, ['session-1']);
});

test('cleanup only removes the handler that created it', () => {
  const registry = createTerminalReconnectRegistry();
  const requests: string[] = [];
  const unregisterOldHandler = registry.register('session-1', () => requests.push('old'));

  registry.register('session-1', () => requests.push('current'));
  unregisterOldHandler();

  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requests, ['current']);
});
