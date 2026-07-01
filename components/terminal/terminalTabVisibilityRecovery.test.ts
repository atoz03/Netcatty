import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./useTerminalEffects.ts', import.meta.url), 'utf8');

test('clears committed layout state when a terminal pane hides', () => {
  assert.match(source, /if \(isVisible\) return;[\s\S]*lastCommittedVisibleLayoutKeyRef\.current = null/);
  assert.match(source, /lastWebglRecoveryLayoutKeyRef\.current = null/);
});

test('forces full recovery when a terminal pane becomes visible again', () => {
  assert.match(source, /const becameVisible = isVisible && !wasVisibleRef\.current/);
  assert.match(source, /recoverTerminalAfterBecomeVisible\(\)/);
  assert.match(source, /nudgeAlternateScreenRedraw\(term\)/);
  assert.match(source, /syncPtySizeAfterLayout/);
});

test('layout recovery refit also syncs PTY size for full-screen TUIs', () => {
  assert.match(source, /runImmediateRefit\(\{ force: true, repeatOnNextFrame: false \}\);\s*finishLayoutRecoveryAfterFit\(\)/);
  assert.match(source, /finishLayoutRecoveryAfterFit/);
});

test('tab-switch suppression does not consume the visible recovery pass', () => {
  assert.match(source, /const becameVisible = isVisible && !wasVisibleRef\.current/);
  assert.match(
    source,
    /if \(!isVisible\) \{\s*wasVisibleRef\.current = false;\s*return;\s*\}[\s\S]*if \(splitResizeActive\) return;[\s\S]*wasVisibleRef\.current = true;[\s\S]*recoverTerminalAfterBecomeVisible\(\)/,
  );
  assert.doesNotMatch(source, /wasVisibleRef\.current = isVisible;\s*if \(!isVisible \|\| isResizing\) return/);
});

test('immediate visibility recovery does not wait for the next animation frame', () => {
  assert.match(source, /safeFit\(\{ force, requireVisible: true, immediate: true \}\)/);
  assert.match(source, /safeFit\(\{ force: true, requireVisible: true, immediate: true \}\)/);
});

test('visible tab recovery reuses a cached fit when the container size is unchanged', () => {
  assert.match(source, /const currentContainerSizeAlreadyFit = \(\) => \{/);
  assert.match(
    source,
    /if \(currentContainerSizeAlreadyFit\(\)\) \{\s*finishLayoutRecovery\(\);\s*commitVisibleLayout\(\);\s*return;\s*\}/,
  );
});
