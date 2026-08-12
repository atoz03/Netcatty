import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runConnectScriptsSequential,
  selectScriptOverlayRun,
  setScriptRuns,
  waitForScriptRun,
} from './scriptAutomationCoordinator.ts';
import type { ScriptRun } from '@/types/global/netcatty-bridge-script.d.ts';
import type { Snippet } from '@/domain/models';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';

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

test('runConnectScriptsSequential cancels only its own queued run and waits for stop', async () => {
  const originalGet = netcattyBridge.get;
  const sessionId = 'sess-connect-abort';
  let queuedRunId: string | undefined;
  let releaseStop: (() => void) | undefined;
  const scriptStopCalls: string[] = [];
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => { storage.clear(); },
    },
  });

  setScriptRuns([{
    runId: 'unrelated-active-run',
    scriptId: 'manual-script',
    sessionId,
    status: 'running',
    startedAt: Date.now(),
    logs: [],
  }]);

  netcattyBridge.get = () => ({
    scriptRun: async (params) => {
      queuedRunId = params.runId;
      assert.equal(params.returnWhenQueued, true);
      return { runId: params.runId!, runIds: [params.runId!] };
    },
    scriptStop: (id: string) => new Promise((resolve) => {
      scriptStopCalls.push(id);
      releaseStop = () => resolve({ ok: true });
    }),
  }) as ReturnType<typeof netcattyBridge.get>;

  const controller = new AbortController();
  let stopCurrentRun: (() => Promise<void>) | null = null;
  const snippet: Snippet = {
    id: 'connect-script',
    label: 'Connect',
    command: 'nct.session.sleep(60)',
    kind: 'script',
  };

  try {
    const running = runConnectScriptsSequential({
      scripts: [snippet],
      sessionId,
      signal: controller.signal,
      onCancelableRunChange: (stop) => { stopCurrentRun = stop; },
    });
    void running.catch(() => {});
    await Promise.resolve();
    controller.abort();
    for (let attempt = 0; attempt < 10 && scriptStopCalls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(scriptStopCalls, [queuedRunId]);
    assert.notEqual(queuedRunId, 'unrelated-active-run');
    assert.equal(typeof stopCurrentRun, 'function');

    let settled = false;
    void running.finally(() => { settled = true; }).catch(() => {});
    await Promise.resolve();
    assert.equal(settled, false);

    releaseStop?.();
    await assert.rejects(
      () => running,
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
  } finally {
    netcattyBridge.get = originalGet;
    setScriptRuns([]);
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('runConnectScriptsSequential retries the exact stop after a transient failure', async () => {
  const originalGet = netcattyBridge.get;
  const storage = new Map<string, string>();
  const stopCalls: string[] = [];
  let stopCurrentRun: (() => Promise<void>) | null = null;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => { storage.clear(); },
    },
  });

  netcattyBridge.get = () => ({
    scriptRun: async (params) => ({ runId: params.runId!, runIds: [params.runId!] }),
    scriptStop: async (id: string) => {
      stopCalls.push(id);
      return { ok: stopCalls.length > 1 };
    },
  }) as ReturnType<typeof netcattyBridge.get>;

  const controller = new AbortController();
  try {
    const running = runConnectScriptsSequential({
      scripts: [{ id: 'retry-stop', label: 'Retry stop', command: 'await nct.sleep(60)', kind: 'script' }],
      sessionId: 'sess-retry-stop',
      signal: controller.signal,
      onCancelableRunChange: (stop) => { stopCurrentRun = stop; },
    });
    void running.catch(() => {});
    for (let attempt = 0; attempt < 10 && !stopCurrentRun; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort();
    await assert.rejects(() => running, /could not be stopped/);
    assert.equal(typeof stopCurrentRun, 'function');
    await stopCurrentRun!();
    assert.equal(stopCalls.length, 2);
  } finally {
    netcattyBridge.get = originalGet;
    setScriptRuns([]);
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('runConnectScriptsSequential does not treat a script error named Aborted as cancellation', async () => {
  const originalGet = netcattyBridge.get;
  const storage = new Map<string, string>();
  const scriptStopCalls: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => { storage.clear(); },
    },
  });

  netcattyBridge.get = () => ({
    scriptRun: async (params) => {
      setScriptRuns([{
        runId: params.runId!,
        scriptId: params.scriptId,
        sessionId: params.sessionId!,
        status: 'failed',
        startedAt: Date.now() - 10,
        endedAt: Date.now(),
        error: 'Aborted',
        logs: [],
      }]);
      return { runId: params.runId!, runIds: [params.runId!] };
    },
    scriptStop: async (id: string) => {
      scriptStopCalls.push(id);
      return { ok: true };
    },
  }) as ReturnType<typeof netcattyBridge.get>;

  try {
    await assert.rejects(
      () => runConnectScriptsSequential({
        scripts: [{ id: 'fails', label: 'Fails', command: "throw new Error('Aborted')", kind: 'script' }],
        sessionId: 'sess-real-error',
        signal: new AbortController().signal,
      }),
      /Aborted/,
    );
    assert.deepEqual(scriptStopCalls, []);
  } finally {
    netcattyBridge.get = originalGet;
    setScriptRuns([]);
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
