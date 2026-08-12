import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCodebuddyElicitationsForChat,
  completeCodebuddyElicitation,
  onCodebuddyElicitation,
  onCodebuddyElicitationCleared,
  registerCodebuddyElicitation,
  replayPendingCodebuddyElicitations,
  respondCodebuddyElicitation,
  type CodebuddyElicitation,
} from './codebuddyElicitations';

test('CodeBuddy elicitation gate replays, responds, completes, and clears by chat', async () => {
  const previousWindow = globalThis.window;
  const responses: unknown[][] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      netcatty: {
        aiSdkAgentElicitationResponse: async (...args: unknown[]) => {
          responses.push(args);
          return { ok: true };
        },
      },
    },
  });

  const received: CodebuddyElicitation[] = [];
  const cleared: string[][] = [];
  const unsubscribe = onCodebuddyElicitation((elicitation) => received.push(elicitation));
  const unsubscribeCleared = onCodebuddyElicitationCleared((ids) => cleared.push(ids));

  registerCodebuddyElicitation({
    elicitationId: 'el-1',
    chatSessionId: 'chat-1',
    request: {
      message: 'Confirm deployment?',
      requestedSchema: {
        type: 'object',
        properties: { environment: { type: 'string' } },
        required: ['environment'],
      },
    },
  });
  assert.equal(received[0]?.elicitationId, 'el-1');

  const replayed: CodebuddyElicitation[] = [];
  replayPendingCodebuddyElicitations((elicitation) => replayed.push(elicitation));
  assert.equal(replayed[0]?.request.message, 'Confirm deployment?');

  await respondCodebuddyElicitation('el-1', 'accept', { environment: 'staging' });
  assert.deepEqual(responses[0], ['el-1', 'accept', { environment: 'staging' }]);
  assert.deepEqual(cleared[0], ['el-1']);

  registerCodebuddyElicitation({
    elicitationId: 'el-2',
    chatSessionId: 'chat-1',
    request: { message: 'Wait for completion' },
  });
  completeCodebuddyElicitation({ elicitationId: 'el-2' });
  assert.deepEqual(cleared[1], ['el-2']);

  registerCodebuddyElicitation({
    elicitationId: 'el-3',
    chatSessionId: 'chat-1',
    request: {},
  });
  registerCodebuddyElicitation({
    elicitationId: 'el-4',
    chatSessionId: 'chat-2',
    request: {},
  });
  clearCodebuddyElicitationsForChat('chat-1');
  assert.deepEqual(cleared[2], ['el-3']);

  const remaining: CodebuddyElicitation[] = [];
  replayPendingCodebuddyElicitations((elicitation) => remaining.push(elicitation));
  assert.deepEqual(remaining.map((elicitation) => elicitation.elicitationId), ['el-4']);

  clearCodebuddyElicitationsForChat('chat-2');
  unsubscribe();
  unsubscribeCleared();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: previousWindow,
  });
});

test('CodeBuddy elicitation registration assigns a new instance to reused protocol ids', () => {
  const received: CodebuddyElicitation[] = [];
  const unsubscribe = onCodebuddyElicitation((elicitation) => received.push(elicitation));

  registerCodebuddyElicitation({
    elicitationId: 'reused-id',
    chatSessionId: 'chat-1',
    request: { message: 'First request' },
  });
  registerCodebuddyElicitation({
    elicitationId: 'reused-id',
    chatSessionId: 'chat-1',
    request: { message: 'Replacement request' },
  });

  assert.equal(received.length, 2);
  assert.equal(typeof received[0].requestInstanceId, 'number');
  assert.equal(typeof received[1].requestInstanceId, 'number');
  assert.notEqual(received[0].requestInstanceId, received[1].requestInstanceId);

  completeCodebuddyElicitation({ elicitationId: 'reused-id' });
  unsubscribe();
});
