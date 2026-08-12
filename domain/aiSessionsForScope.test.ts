import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aiSessionIdSetEqual,
  exactScopeAISessionsEqual,
  filterAISessionsForScope,
  retainStableAISessionsForScope,
  sessionMatchesAIScope,
} from './aiSessionsForScope.ts';

const session = (
  id: string,
  scopeType: string,
  targetId?: string,
) => ({
  id,
  scope: { type: scopeType, targetId },
});

test('filterAISessionsForScope keeps only matching scope', () => {
  const a = session('a', 'terminal', 't1');
  const b = session('b', 'terminal', 't2');
  const c = session('c', 'workspace', 'w1');
  const all = [a, b, c];
  assert.deepEqual(filterAISessionsForScope(all, 'terminal', 't1'), [a]);
  assert.deepEqual(filterAISessionsForScope(all, 'workspace', 'w1'), [c]);
  assert.equal(sessionMatchesAIScope(a, 'terminal', 't1'), true);
  assert.equal(sessionMatchesAIScope(a, 'terminal', 't2'), false);
});

test('retainStableAISessionsForScope keeps identity when session refs match', () => {
  const a = session('a', 'terminal', 't1');
  const prev = [a];
  const next = [a];
  assert.equal(retainStableAISessionsForScope(prev, next), prev);
  const replaced = [session('a', 'terminal', 't1')];
  assert.notEqual(retainStableAISessionsForScope(prev, replaced), prev);
});

test('exactScopeAISessionsEqual ignores sibling session object churn', () => {
  const a = session('a', 'terminal', 't1');
  const b1 = session('b', 'terminal', 't2');
  const b2 = session('b', 'terminal', 't2'); // new object, sibling stream
  const prev = [a, b1];
  const next = [a, b2];
  assert.equal(exactScopeAISessionsEqual(prev, next, 'terminal', 't1'), true);
  const a2 = session('a', 'terminal', 't1');
  assert.equal(exactScopeAISessionsEqual(prev, [a2, b1], 'terminal', 't1'), false);
});

test('exactScopeAISessionsEqual tracks selected cross-scope resumed session', () => {
  const exact = session('exact', 'terminal', 't-new');
  const history1 = session('hist', 'terminal', 't-old');
  const history2 = session('hist', 'terminal', 't-old'); // stream update object
  const prev = [exact, history1];
  const next = [exact, history2];
  // Without selectedSessionId, cross-scope history is ignored (sibling thrash isolation).
  assert.equal(exactScopeAISessionsEqual(prev, next, 'terminal', 't-new'), true);
  // With selectedSessionId, visible resumed history must re-render on updates.
  assert.equal(
    exactScopeAISessionsEqual(prev, next, 'terminal', 't-new', 'hist'),
    false,
  );
  assert.equal(
    exactScopeAISessionsEqual(prev, prev, 'terminal', 't-new', 'hist'),
    true,
  );
});

test('aiSessionIdSetEqual detects create/delete without object-identity thrash', () => {
  const a1 = session('a', 'terminal', 't1');
  const a2 = session('a', 'terminal', 't1');
  const b = session('b', 'terminal', 't2');
  assert.equal(aiSessionIdSetEqual([a1, b], [a2, b]), true);
  assert.equal(aiSessionIdSetEqual([a1, b], [a1]), false);
  assert.equal(aiSessionIdSetEqual([a1], [b]), false);
});

test('aiSessionIdSetEqual detects title chrome renames without message thrash', () => {
  const a1 = { ...session('a', 'terminal', 't1'), title: 'old', updatedAt: 1 };
  const a2 = { ...session('a', 'terminal', 't1'), title: 'old', updatedAt: 1 }; // new object
  const a3 = { ...session('a', 'terminal', 't1'), title: 'new', updatedAt: 1 };
  const a4 = { ...session('a', 'terminal', 't1'), title: 'old', updatedAt: 2 };
  assert.equal(aiSessionIdSetEqual([a1], [a2]), true);
  assert.equal(aiSessionIdSetEqual([a1], [a3]), false);
  assert.equal(aiSessionIdSetEqual([a1], [a4]), false);
});

test('aiSessionIdSetEqual detects updatedAt chrome without message thrash', () => {
  const a1 = { ...session('a', 'terminal', 't1'), title: 'chat', updatedAt: 1 };
  const a2 = { ...session('a', 'terminal', 't1'), title: 'chat', updatedAt: 1 }; // new object, same chrome
  const a3 = { ...session('a', 'terminal', 't1'), title: 'chat', updatedAt: 2 };
  assert.equal(aiSessionIdSetEqual([a1], [a2]), true);
  assert.equal(aiSessionIdSetEqual([a1], [a3]), false);
});
