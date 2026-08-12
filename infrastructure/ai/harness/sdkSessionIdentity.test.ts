import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSdkSessionIdentity, parseSdkSessionIdentity } from './sdkSessionIdentity';

test('SDK session identities preserve Codex runtime and default legacy values to sdk', () => {
  const encoded = encodeSdkSessionIdentity('thread-1', 'codex', '/bin/codex', 'app-server');
  assert.deepEqual(parseSdkSessionIdentity(encoded), {
    v: 1,
    id: 'thread-1',
    backend: 'codex',
    binPath: '/bin/codex',
    runtime: 'app-server',
  });

  const legacy = encodeSdkSessionIdentity('thread-2', 'codex', '/bin/codex');
  const payload = JSON.parse(decodeURIComponent(legacy.slice('netcatty-sdk-session:'.length)));
  delete payload.runtime;
  const legacyWithoutRuntime = `netcatty-sdk-session:${encodeURIComponent(JSON.stringify(payload))}`;
  assert.equal(parseSdkSessionIdentity(legacyWithoutRuntime)?.runtime, 'sdk');
});

test('SDK session identities preserve Cursor auth mode', () => {
  const encoded = encodeSdkSessionIdentity(
    '61668441-bfcb-4795-a575-c46d70ad01fe',
    'cursor',
    '/usr/bin/agent',
    'sdk',
    'cli-login',
    'agent',
  );
  assert.deepEqual(parseSdkSessionIdentity(encoded), {
    v: 1,
    id: '61668441-bfcb-4795-a575-c46d70ad01fe',
    backend: 'cursor',
    binPath: '/usr/bin/agent',
    runtime: 'sdk',
    authMode: 'cli-login',
    cliMode: 'agent',
  });
});

test('SDK session identities preserve Grok ACP and streaming-json runtimes', () => {
  const acp = encodeSdkSessionIdentity('sess-acp', 'grok', '/usr/bin/grok', 'acp');
  assert.deepEqual(parseSdkSessionIdentity(acp), {
    v: 1,
    id: 'sess-acp',
    backend: 'grok',
    binPath: '/usr/bin/grok',
    runtime: 'acp',
  });

  const headless = encodeSdkSessionIdentity(
    'sess-json',
    'grok',
    '/usr/bin/grok',
    'streaming-json',
  );
  assert.deepEqual(parseSdkSessionIdentity(headless), {
    v: 1,
    id: 'sess-json',
    backend: 'grok',
    binPath: '/usr/bin/grok',
    runtime: 'streaming-json',
  });

  // Aliases normalize to streaming-json.
  const alias = encodeSdkSessionIdentity('sess-cli', 'grok', '/usr/bin/grok', 'headless');
  assert.equal(parseSdkSessionIdentity(alias)?.runtime, 'streaming-json');
});
