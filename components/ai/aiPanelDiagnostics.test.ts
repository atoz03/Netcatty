import assert from 'node:assert/strict';
import test from 'node:test';

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorageStub,
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    localStorage: localStorageStub,
  },
});

const {
  AI_PANEL_FORCE_HIDE_ALL_CONTENT,
  AI_PANEL_FORCE_HIDE_SHELL,
  AI_PANEL_DIAGNOSTIC_HIDE_KEY,
  AI_PANEL_DIAGNOSTIC_PROFILE_KEY,
  getAIPanelDiagnosticHiddenParts,
  isAIPanelDiagnosticPartHidden,
  isAIPanelDiagnosticsProfilingEnabled,
} = await import('./aiPanelDiagnostics.ts');

test('AI panel diagnostics does not hide content by default', () => {
  window.localStorage.removeItem(AI_PANEL_DIAGNOSTIC_HIDE_KEY);

  assert.equal(AI_PANEL_FORCE_HIDE_ALL_CONTENT, false);
  assert.equal(isAIPanelDiagnosticPartHidden('header'), false);
  assert.equal(isAIPanelDiagnosticPartHidden('input'), false);
});

test('AI panel diagnostics does not hide the side panel shell by default', () => {
  assert.equal(AI_PANEL_FORCE_HIDE_SHELL, false);
});

test('AI panel diagnostics parses hidden parts from local storage', () => {
  window.localStorage.setItem(AI_PANEL_DIAGNOSTIC_HIDE_KEY, ' messages, input ,markdown ');

  const hiddenParts = getAIPanelDiagnosticHiddenParts();
  assert.equal(hiddenParts.has('messages'), true);
  assert.equal(hiddenParts.has('input'), true);
  assert.equal(hiddenParts.has('markdown'), true);
  assert.equal(isAIPanelDiagnosticPartHidden('messages', hiddenParts), true);
  assert.equal(isAIPanelDiagnosticPartHidden('toolcalls', hiddenParts), false);
});

test('AI panel diagnostics supports hiding everything at once', () => {
  window.localStorage.setItem(AI_PANEL_DIAGNOSTIC_HIDE_KEY, 'all');
  const hiddenParts = getAIPanelDiagnosticHiddenParts();

  assert.equal(isAIPanelDiagnosticPartHidden('header', hiddenParts), true);
  assert.equal(isAIPanelDiagnosticPartHidden('input', hiddenParts), true);
});

test('AI panel profiling accepts common enabled values', () => {
  window.localStorage.setItem(AI_PANEL_DIAGNOSTIC_PROFILE_KEY, 'on');
  assert.equal(isAIPanelDiagnosticsProfilingEnabled(), true);

  window.localStorage.setItem(AI_PANEL_DIAGNOSTIC_PROFILE_KEY, '0');
  assert.equal(isAIPanelDiagnosticsProfilingEnabled(), false);
});
