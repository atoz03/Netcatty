import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolResultDedup } from './toolResultDedup';

test('completed write replay is ordered, one-shot, and scoped to the current turn', () => {
  const dedup = new ToolResultDedup();
  dedup.beginTurn();
  dedup.rememberCompletedWrite('same-command', 'first');
  dedup.rememberCompletedWrite('same-command', 'second');
  dedup.enableWriteReplay();

  assert.equal(dedup.replayCompletedWrite('same-command'), 'first');
  assert.equal(dedup.replayCompletedWrite('same-command'), 'second');
  assert.equal(dedup.replayCompletedWrite('same-command'), undefined);

  dedup.rememberCompletedWrite('later-command', 'later');
  assert.equal(dedup.replayCompletedWrite('later-command'), undefined);

  dedup.beginTurn();
  dedup.enableWriteReplay();
  assert.equal(dedup.replayCompletedWrite('same-command'), undefined);
  assert.equal(dedup.replayCompletedWrite('later-command'), undefined);
});

test('completed writes already present in retry history are not replayed', () => {
  const dedup = new ToolResultDedup();
  dedup.beginTurn();
  dedup.rememberCompletedWrite('preserved-command', 'old result');
  dedup.enableWriteReplay(['preserved-command']);

  assert.equal(dedup.replayCompletedWrite('preserved-command'), undefined);
});
