import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ElicitationCreateRequest,
  ElicitationHandler,
  Options,
  SessionOptions,
} from '@tencent-ai/agent-sdk';

test('CodeBuddy SDK Options and SessionOptions support elicitation handlers', async () => {
  const calls: string[] = [];
  const handler: ElicitationHandler = {
    async create(_request, _options) {
      calls.push('create');
      return { action: 'accept', content: { confirmed: true } };
    },
    complete() {
      calls.push('complete');
    },
  };
  const queryOptions = { elicitation: handler } satisfies Options;
  const sessionOptions = { elicitation: handler } satisfies SessionOptions;
  const request: ElicitationCreateRequest = {
    sessionId: 'contract-session',
    mode: 'form',
    message: 'Confirm?',
    requestedSchema: {
      type: 'object',
      properties: { confirmed: { type: 'boolean' } },
    },
  };

  assert.equal(queryOptions.elicitation, handler);
  assert.equal(sessionOptions.elicitation, handler);
  assert.deepEqual(
    await sessionOptions.elicitation.create(request, {
      signal: new AbortController().signal,
    }),
    { action: 'accept', content: { confirmed: true } },
  );
  await sessionOptions.elicitation.complete?.({ elicitationId: 'contract-elicit' });
  assert.deepEqual(calls, ['create', 'complete']);
});
