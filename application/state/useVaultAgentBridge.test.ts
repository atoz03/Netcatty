import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  haveSameVaultAgentSnapshot,
  resolveVaultAgentEffectiveHost,
  resolveVaultAgentNotes,
} from './useVaultAgentBridge';
import type { Host } from '../../domain/models';
import { publishNotesSnapshot } from './notesStore';

type Snapshot = Parameters<typeof haveSameVaultAgentSnapshot>[0];

describe('haveSameVaultAgentSnapshot', () => {
  it('compares every snapshot field by reference', () => {
    const snapshot: Snapshot = {
      hosts: [], keys: [], notes: [], snippets: [], customGroups: [], groupConfigs: [],
      portForwardingRules: [], managedSources: [],
    };
    assert.equal(haveSameVaultAgentSnapshot(snapshot, { ...snapshot }), true);
    for (const key of Object.keys(snapshot) as Array<keyof Snapshot>) {
      assert.equal(
        haveSameVaultAgentSnapshot(snapshot, { ...snapshot, [key]: [] }),
        false,
        key,
      );
    }
  });
});

describe('resolveVaultAgentEffectiveHost', () => {
  it('uses the latest snapshotted group defaults', () => {
    const host: Host = {
      id: 'host-1', label: 'Host', hostname: 'host.test', username: 'root',
      group: 'production', tags: [], os: 'linux',
    };

    assert.equal(
      resolveVaultAgentEffectiveHost(host, [{ path: 'production', protocol: 'telnet' }], []).protocol,
      'telnet',
    );
  });
});

describe('resolveVaultAgentNotes', () => {
  it('prefers the live notes store when App omitted the notes prop', () => {
    const stale: Snapshot['notes'] = [];
    const live = [{ id: 'n1', title: 'Live', content: 'x', updatedAt: 1 }] as Snapshot['notes'];
    publishNotesSnapshot({ notes: live, noteGroups: [] });
    assert.equal(resolveVaultAgentNotes(undefined, stale as never), live);
    assert.equal(resolveVaultAgentNotes(stale as never, stale as never), stale);
  });
});
