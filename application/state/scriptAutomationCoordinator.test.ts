import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectScriptOverlayRun,
  setScriptRuns,
  waitForScriptRun,
} from './scriptAutomationCoordinator.ts';
import type { ScriptRun } from '@/types/global/netcatty-bridge-script.d.ts';

test('waitForScriptRun resolves when run is already completed on subscribe', async () => {
  const runId = 'run-already-done';
  setScriptRuns([{
    runId,
    scriptId: 's1',
    sessionId: 'sess1',
    status: 'completed',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    logs: [],
  }]);

  const run = await waitForScriptRun(runId, { timeoutMs: 5000 });
  assert.equal(run.runId, runId);
  assert.equal(run.status, 'completed');
});

test('waitForScriptRun rejects when run already failed on subscribe', async () => {
  const runId = 'run-already-failed';
  setScriptRuns([{
    runId,
    sessionId: 'sess1',
    status: 'failed',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    error: 'boom',
    logs: [],
  }]);

  await assert.rejects(
    () => waitForScriptRun(runId, { timeoutMs: 5000 }),
    /boom/,
  );
});

test('selectScriptOverlayRun does not resurface older completed runs after dismissal', () => {
  const dismissedRunIds = new Set<string>();
  const completed = (runId: string, endedAt: number): ScriptRun => ({
    runId,
    sessionId: 'sess1',
    status: 'completed',
    startedAt: endedAt - 100,
    endedAt,
    logs: [],
  });
  const olderRun = completed('older-run', 1_000);
  const latestRun = completed('latest-run', 2_000);

  assert.equal(
    selectScriptOverlayRun([olderRun, latestRun], 'sess1', dismissedRunIds)?.runId,
    latestRun.runId,
  );
  assert.ok(dismissedRunIds.has(olderRun.runId));

  dismissedRunIds.add(latestRun.runId);
  assert.equal(selectScriptOverlayRun([olderRun, latestRun], 'sess1', dismissedRunIds), undefined);
});
