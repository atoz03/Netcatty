import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../Terminal.tsx', import.meta.url), 'utf8');

test('safeFit skips hidden terminal panes unless explicitly allowed', () => {
  assert.match(
    source,
    /if \(!isVisibleRef\.current && !options\?\.allowHidden\) \{\s*lastFittedSizeRef\.current = null;\s*return;\s*\}/,
  );
});

test('safeFit can run synchronously for first-frame tab recovery', () => {
  assert.match(source, /immediate\?: boolean/);
  assert.match(
    source,
    /XTERM_PERFORMANCE_CONFIG\.resize\.useRAF &&\s*typeof requestAnimationFrame === "function" &&\s*!options\?\.immediate/,
  );
});
