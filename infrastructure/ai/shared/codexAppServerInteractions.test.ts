import test from 'node:test';
import assert from 'node:assert/strict';
import {
  onCodexAppServerInteraction,
  replayPendingCodexAppServerInteractions,
  respondCodexUserInput,
  setupCodexAppServerInteractionBridge,
  type CodexAppServerInteraction,
} from './codexAppServerInteractions';
import {
  clearAllPendingApprovals,
  onApprovalRequest,
  replayPendingApprovals,
  resolveApproval,
  type ApprovalRequest,
} from './approvalGate';

test('Codex App Server interaction gate replays requests and forwards typed responses', async () => {
  let requestListener: ((payload: CodexAppServerInteraction) => void) | undefined;
  let clearedListener: ((payload: { interactionIds: string[] }) => void) | undefined;
  const responses: Record<string, unknown>[] = [];
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      netcatty: {
        onCodexAppServerInteractionRequest: (listener: typeof requestListener) => {
          requestListener = listener;
          return () => {};
        },
        onCodexAppServerInteractionCleared: (listener: typeof clearedListener) => {
          clearedListener = listener;
          return () => {};
        },
        respondCodexAppServerInteraction: async (payload: Record<string, unknown>) => {
          responses.push(payload);
          return { ok: true };
        },
      },
    },
  });

  const teardown = setupCodexAppServerInteractionBridge();
  const received: CodexAppServerInteraction[] = [];
  const approvals: ApprovalRequest[] = [];
  const unsubscribe = onCodexAppServerInteraction((interaction) => received.push(interaction));
  const unsubscribeApprovals = onApprovalRequest((approval) => approvals.push(approval));
  requestListener?.({
    interactionId: 'approval-1',
    source: 'codex-app-server',
    kind: 'command',
    requestId: 'request-1',
    chatSessionId: 'chat-1',
    toolName: 'codex.command',
    args: { command: 'npm test' },
    availableDecisions: ['accept', 'decline', 'cancel'],
  });
  assert.equal(received.length, 0);
  assert.equal(approvals[0].source, 'codex-app-server');
  assert.equal(approvals[0].allowSession, false);

  const replayedApprovals: ApprovalRequest[] = [];
  replayPendingApprovals((approval) => replayedApprovals.push(approval));
  assert.equal(replayedApprovals[0].toolCallId, 'approval-1');
  resolveApproval('approval-1', { approved: true, scope: 'once' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses[0], { interactionId: 'approval-1', decision: 'once' });

  requestListener?.({
    interactionId: 'approval-session',
    source: 'codex-app-server',
    kind: 'command',
    requestId: 'request-1',
    chatSessionId: 'chat-1',
    toolName: 'codex.command',
    args: { command: 'npm test' },
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
  });
  assert.equal(approvals[1].allowSession, true);
  resolveApproval('approval-session', { approved: true, scope: 'session' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses[1], { interactionId: 'approval-session', decision: 'session' });

  requestListener?.({
    interactionId: 'approval-stop',
    source: 'codex-app-server',
    kind: 'file-change',
    requestId: 'request-1',
    chatSessionId: 'chat-1',
    toolName: 'codex.file_change',
    args: { reason: 'write files' },
  });
  clearAllPendingApprovals('chat-1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses[2], { interactionId: 'approval-stop', decision: 'cancel' });

  requestListener?.({
    interactionId: 'input-1',
    source: 'codex-app-server',
    kind: 'user-input',
    requestId: 'request-1',
    chatSessionId: 'chat-1',
    questions: [],
  });
  assert.equal(received[0].interactionId, 'input-1');
  const replayedInputs: CodexAppServerInteraction[] = [];
  replayPendingCodexAppServerInteractions((interaction) => replayedInputs.push(interaction));
  assert.equal(replayedInputs[0].interactionId, 'input-1');
  await respondCodexUserInput('input-1', { mode: { answers: ['safe'] } });
  assert.deepEqual(responses[3], {
    interactionId: 'input-1',
    answers: { mode: { answers: ['safe'] } },
  });
  clearedListener?.({ interactionIds: ['missing'] });

  unsubscribe();
  unsubscribeApprovals();
  teardown();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
});

test('Codex App Server interaction bridge is ref-counted across setup/teardown', () => {
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      netcatty: {
        onCodexAppServerInteractionRequest: () => {
          subscribeCount += 1;
          return () => {
            unsubscribeCount += 1;
          };
        },
        onCodexAppServerInteractionCleared: () => () => {},
      },
    },
  });

  const first = setupCodexAppServerInteractionBridge();
  const second = setupCodexAppServerInteractionBridge();
  assert.equal(subscribeCount, 1, 'nested setup must not stack ipc listeners');
  first();
  assert.equal(unsubscribeCount, 0, 'first teardown while second still live keeps the bridge');
  second();
  assert.equal(unsubscribeCount, 1);

  Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
});
