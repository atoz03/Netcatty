import assert from 'node:assert/strict';
import test from 'node:test';
import { isStreamingMonitorCommand, TerminalMonitorGuard } from './terminalMonitorGuard';
import { applyMonitorStopResult } from './capabilityTools';

test('TerminalMonitorGuard bounds lines and batches', () => {
  const guard = new TerminalMonitorGuard();
  const result = guard.process('chat:job', `${'x'.repeat(800)}\n${'line\n'.repeat(1_000)}`);

  assert.equal(result.action, 'deliver');
  assert.ok((result.content?.length ?? Infinity) <= 3_000);
  assert.ok((result.content?.split('\n')[0].length ?? Infinity) <= 500);
});

test('TerminalMonitorGuard suppresses bursts and stops a sustained overload', () => {
  let now = 0;
  const guard = new TerminalMonitorGuard({ now: () => now });
  for (let index = 0; index < 10; index += 1) {
    assert.equal(guard.process('chat:job', `line ${index}`).action, 'deliver');
  }
  assert.equal(guard.process('chat:job', 'burst').action, 'suppress');
  let action = guard.process('chat:job', 'still flooding').action;
  for (now = 1_000; now <= 31_000 && action !== 'stop'; now += 1_000) {
    action = guard.process('chat:job', 'still flooding').action;
  }
  assert.equal(action, 'stop');
});

test('monitor stop result does not claim success when the backend stop failed', () => {
  const failed = applyMonitorStopResult(
    { jobId: 'job-1', status: 'running' },
    { ok: false, error: 'lost worker' },
    12,
  );
  assert.equal(failed.status, 'running');
  assert.match(String(failed.output), /stop failed/);
  assert.match(String(failed.output), /may still be running/);

  const accepted = applyMonitorStopResult(
    { jobId: 'job-1', status: 'running' },
    { ok: true },
    12,
  );
  assert.equal(accepted.status, 'stopping');
  assert.match(String(accepted.output), /stop requested/);
});

test('isStreamingMonitorCommand requires an actual follow option', () => {
  assert.equal(isStreamingMonitorCommand('tail app-file.log'), false);
  assert.equal(isStreamingMonitorCommand('tail -n 10 foo.log'), false);
  assert.equal(isStreamingMonitorCommand('journalctl --since 5m foo'), false);
  assert.equal(isStreamingMonitorCommand('tail -f app.log'), true);
  assert.equal(isStreamingMonitorCommand('tail -n0F app.log'), true);
  assert.equal(isStreamingMonitorCommand('journalctl --follow -u nginx'), true);
  assert.equal(isStreamingMonitorCommand('docker logs -f api'), true);
  assert.equal(isStreamingMonitorCommand('kubectl logs --follow pod/api'), true);
  assert.equal(isStreamingMonitorCommand('cd /srv && watch npm test'), true);
});

test('isStreamingMonitorCommand recognizes common wrappers and compose logs', () => {
  assert.equal(isStreamingMonitorCommand('sudo journalctl -f -u nginx'), true);
  assert.equal(isStreamingMonitorCommand('sudo -u root tail -f /var/log/syslog'), true);
  assert.equal(isStreamingMonitorCommand('env LANG=C tail --follow app.log'), true);
  assert.equal(isStreamingMonitorCommand('stdbuf -oL kubectl logs -f pod/api'), true);
  assert.equal(isStreamingMonitorCommand('timeout 60s tail -f app.log'), true);
  assert.equal(isStreamingMonitorCommand('docker compose logs -f api'), true);
  assert.equal(isStreamingMonitorCommand('sudo -H journalctl -f -u nginx'), true);
  assert.equal(isStreamingMonitorCommand('kubectl -n production logs -f pod/api'), true);
  assert.equal(isStreamingMonitorCommand('kubectl --context prod logs --follow pod/api'), true);
  assert.equal(isStreamingMonitorCommand('docker --context prod logs -f api'), true);
  assert.equal(isStreamingMonitorCommand('docker compose -f compose.prod.yml logs -f api'), true);
  assert.equal(isStreamingMonitorCommand('docker compose -p demo logs -f api'), true);
  assert.equal(isStreamingMonitorCommand('sudo tail -n 10 app.log'), false);
  assert.equal(isStreamingMonitorCommand('timeout 60s journalctl --since 5m'), false);
});
