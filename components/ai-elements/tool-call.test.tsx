import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  approvalArgsHaveExtraContext,
  approvalCommandWasUnwrapped,
  extractApprovalExecutionContext,
  extractDisplayCommand,
  isNestedInteractiveApprovalTarget,
  MAX_TOOL_COMMAND_TOOLTIP_CHARS,
  truncateToolCommandTooltip,
} from './tool-call';

const toolCallSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'tool-call.tsx'),
  'utf8',
);

// Codex (SDK) emits command_execution.command as a STRING that wraps the real
// command in `<shell> -lc '<full>'`. Under Skills + CLI the real command is a
// netcatty-tool-cli call. The title must unwrap the shell layer first, else the
// outer quote leaks (the "netcatty: \"" / "netcatty: …md\"" garbage titles).

test('unwraps a /bin/zsh -lc string wrapper (codex SDK shape)', () => {
  assert.equal(
    extractDisplayCommand({ command: `/bin/zsh -lc 'echo "hi"'` }),
    'echo "hi"',
  );
});

test('codex Skills+CLI exec: unwrap shell + netcatty-cli -> remote command', () => {
  assert.equal(
    extractDisplayCommand({
      command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" exec --session X -- "uptime"'`,
    }),
    'uptime',
  );
});

test('codex Skills+CLI session subcommand -> friendly title', () => {
  assert.equal(
    extractDisplayCommand({
      command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" session --session X'`,
    }),
    'netcatty: inspect session',
  );
});

test('raw (unwrapped) netcatty-tool-cli exec still works', () => {
  assert.equal(
    extractDisplayCommand({ command: `"/abs/netcatty-tool-cli" exec --session X -- "uptime"` }),
    'uptime',
  );
});

test('netcatty-tool-cli.cjs wrapper still unwraps to remote command', () => {
  assert.equal(
    extractDisplayCommand({
      command: `/bin/zsh -lc '"/abs/netcatty-tool-cli.cjs" exec --session X -- "uptime"'`,
    }),
    'uptime',
  );
  assert.equal(
    extractDisplayCommand({
      command: `"/Resources/netcatty-tool-cli.cjs" exec --session X -- "df -h"`,
    }),
    'df -h',
  );
});

test('netcatty-tool-cli.cmd wrapper still unwraps to remote command', () => {
  assert.equal(
    extractDisplayCommand({
      command: `"C:\\\\App\\\\netcatty-tool-cli.cmd" exec --session X -- "whoami"`,
    }),
    'whoami',
  );
});

test('netcatty-tool-cli env -> list sessions', () => {
  assert.equal(extractDisplayCommand({ command: 'netcatty-tool-cli env' }), 'netcatty: list sessions');
});

test('array shell-wrap shape still unwraps (regression)', () => {
  assert.equal(
    extractDisplayCommand({ command: ['zsh', '-lc', 'ls -la /tmp'] }),
    'ls -la /tmp',
  );
});

test('plain command passes through unchanged', () => {
  assert.equal(extractDisplayCommand({ command: 'ls -la /tmp' }), 'ls -la /tmp');
});

test('limits long command tooltips to a compact single-line preview', () => {
  const tooltip = truncateToolCommandTooltip(`  echo first\n${'x'.repeat(300)}  `);
  assert.equal(tooltip.length, MAX_TOOL_COMMAND_TOOLTIP_CHARS);
  assert.equal(tooltip.endsWith('…'), true);
  assert.equal(tooltip.includes('\n'), false);
});

test('empty / missing args -> null', () => {
  assert.equal(extractDisplayCommand(undefined), null);
  assert.equal(extractDisplayCommand({ command: '' }), null);
});

test('extractApprovalExecutionContext surfaces session/cwd/shell without rewriting command', () => {
  assert.deepEqual(
    extractApprovalExecutionContext({
      sessionId: 'term-1',
      cwd: '/var/log',
      command: ['zsh', '-lc', 'df -h | sort'],
    }),
    { sessionId: 'term-1', cwd: '/var/log', shell: 'zsh', reason: undefined },
  );
  assert.deepEqual(
    extractApprovalExecutionContext({
      command: `/bin/bash -lc 'uptime'`,
    }),
    { sessionId: undefined, cwd: undefined, shell: 'bash', reason: undefined },
  );
  assert.equal(extractApprovalExecutionContext({ path: '/tmp' }), null);
});

test('extractApprovalExecutionContext reads --session from netcatty-tool-cli wrappers', () => {
  assert.deepEqual(
    extractApprovalExecutionContext({
      command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" exec --session term-9 --chat-session chat-1 -- "uptime"'`,
    }),
    { sessionId: 'term-9', cwd: undefined, shell: 'zsh', reason: undefined },
  );
});

test('extractApprovalExecutionContext surfaces Codex reason for approval review', () => {
  assert.deepEqual(
    extractApprovalExecutionContext({
      command: 'rm -rf /tmp/x',
      cwd: '/tmp',
      reason: 'Clean stale build artifacts',
      commandActions: [{ type: 'delete' }],
    }),
    {
      sessionId: undefined,
      cwd: '/tmp',
      shell: undefined,
      reason: 'Clean stale build artifacts',
    },
  );
});

test('approvalCommandWasUnwrapped detects Skills+CLI display unwrap', () => {
  const args = {
    command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" exec --session X -- "uptime"'`,
  };
  const display = extractDisplayCommand(args);
  assert.equal(display, 'uptime');
  assert.equal(approvalCommandWasUnwrapped(args, display), true);
  assert.equal(approvalCommandWasUnwrapped({ command: 'uptime' }, 'uptime'), false);
});

test('approvalArgsHaveExtraContext keeps commandActions visible beside the command block', () => {
  assert.equal(
    approvalArgsHaveExtraContext({
      command: 'echo hi',
      reason: 'demo',
      commandActions: [{ type: 'read' }],
    }),
    true,
  );
  assert.equal(
    approvalArgsHaveExtraContext({ command: 'echo hi', cwd: '/tmp', reason: 'demo' }),
    false,
  );
});

test('isNestedInteractiveApprovalTarget ignores Enter on Copy/Expand review controls', () => {
  const card = { id: 'card' };
  const copyBtn = {
    closest: (selector: string) => (selector.includes('button') ? copyBtn : null),
  };
  const plainSpan = {
    closest: () => null,
  };

  assert.equal(isNestedInteractiveApprovalTarget(copyBtn, card), true);
  assert.equal(isNestedInteractiveApprovalTarget(plainSpan, card), false);
  assert.equal(isNestedInteractiveApprovalTarget(card, card), false);
  assert.equal(isNestedInteractiveApprovalTarget(null, card), false);
});

// Pending approvals with no display command (Codex file-change/permissions,
// write tools with JSON-only args) only render the overflow args <pre>. Wheel /
// trackpad scroll must re-arm idle the same way the command block does.
test('args overflow block re-arms review timers on scroll/wheel while pending', () => {
  assert.match(
    toolCallSource,
    /JSON\.stringify\(args,\s*null,\s*2\)[\s\S]{0,200}?<\/pre>/,
  );
  // Both review surfaces (command + args) wire markReviewing for continuous scroll.
  const markReviewingScrollBindings = toolCallSource.match(
    /onScroll=\{(?:isPendingApproval \? markReviewing : undefined|markReviewing)\}/g,
  );
  const markReviewingWheelBindings = toolCallSource.match(
    /onWheel=\{(?:isPendingApproval \? markReviewing : undefined|markReviewing)\}/g,
  );
  assert.ok(
    markReviewingScrollBindings && markReviewingScrollBindings.length >= 2,
    'command and args overflow blocks must both call markReviewing onScroll',
  );
  assert.ok(
    markReviewingWheelBindings && markReviewingWheelBindings.length >= 2,
    'command and args overflow blocks must both call markReviewing onWheel',
  );
  assert.match(
    toolCallSource,
    /onScroll=\{isPendingApproval \? markReviewing : undefined\}[\s\S]{0,80}onWheel=\{isPendingApproval \? markReviewing : undefined\}[\s\S]{0,80}JSON\.stringify\(args/,
  );
});
