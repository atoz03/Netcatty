const assert = require('node:assert/strict');
const test = require('node:test');
const { createPreloadApi } = require('./api.cjs');

test('backup write and export forward the serialized JSON payload unchanged', async () => {
  const calls = [];
  const api = createPreloadApi({
    ipcRenderer: { invoke: async (...args) => { calls.push(args); } },
    webUtils: {},
  });
  const payload = { json: '[]' };
  await api.aiSessionsBackupWrite(payload);
  await api.aiSessionsBackupExport(payload);
  assert.deepEqual(calls, [
    ['netcatty:aiSessionsBackup:write', payload],
    ['netcatty:aiSessionsBackup:export', payload],
  ]);
  for (const [, argument] of calls) assert.equal(typeof argument.json, 'string');
});

test('chunked backup writes forward each step on its own channel in call order', async () => {
  const calls = [];
  const api = createPreloadApi({
    ipcRenderer: { invoke: async (...args) => { calls.push(args); } },
    webUtils: {},
  });
  await Promise.all([
    api.aiSessionsBackupWriteBegin({ id: 'g1' }),
    api.aiSessionsBackupWriteChunk({ id: 'g1', chunk: '[' }),
    api.aiSessionsBackupWriteChunk({ id: 'g1', chunk: ']' }),
    api.aiSessionsBackupWriteCommit({ id: 'g1' }),
    api.aiSessionsBackupWriteAbort({ id: 'g2' }),
  ]);
  assert.deepEqual(calls, [
    ['netcatty:aiSessionsBackup:writeBegin', { id: 'g1' }],
    ['netcatty:aiSessionsBackup:writeChunk', { id: 'g1', chunk: '[' }],
    ['netcatty:aiSessionsBackup:writeChunk', { id: 'g1', chunk: ']' }],
    ['netcatty:aiSessionsBackup:writeCommit', { id: 'g1' }],
    ['netcatty:aiSessionsBackup:writeAbort', { id: 'g2' }],
  ]);
});
