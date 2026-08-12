import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { CodebuddyElicitationCard } from './CodebuddyElicitationCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

test('CodebuddyElicitationCard renders MCP form fields and response actions', () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <CodebuddyElicitationCard
        elicitation={{
          elicitationId: 'el-1',
          chatSessionId: 'chat-1',
          request: {
            message: 'Choose deployment settings',
            requestedSchema: {
              type: 'object',
              properties: {
                environment: {
                  type: 'string',
                  title: 'Environment',
                  enum: ['staging', 'production'],
                  default: 'staging',
                },
                dryRun: {
                  type: 'boolean',
                  title: 'Dry run',
                },
              },
              required: ['environment'],
            },
          },
        }}
        onRespond={async () => {}}
      />
    </I18nProvider>,
  );

  assert.match(markup, /CodeBuddy needs your input/);
  assert.match(markup, /Choose deployment settings/);
  assert.match(markup, /Environment \*/);
  assert.match(markup, /staging/);
  assert.match(markup, /Dry run/);
  assert.match(markup, /Decline/);
  assert.match(markup, /Continue/);
  assert.doesNotMatch(markup, /role="alert"/);
});

test('CodebuddyElicitationCard renders constraint errors and blocks submission', () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <CodebuddyElicitationCard
        elicitation={{
          elicitationId: 'el-invalid',
          chatSessionId: 'chat-1',
          request: {
            message: 'Choose valid settings',
            requestedSchema: {
              type: 'object',
              properties: {
                retries: {
                  type: 'integer',
                  title: 'Retries',
                  minimum: 10,
                  default: 1,
                },
                regions: {
                  type: 'array',
                  title: 'Regions',
                  minItems: 2,
                  default: ['us-east'],
                  items: {
                    enum: ['us-east', 'eu-west'],
                  },
                },
              },
              required: ['retries', 'regions'],
            },
          },
        }}
        onRespond={async () => {}}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Retries must be at least 10\./);
  assert.match(markup, /Select at least 2 options for Regions\./);
  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Continue<\/button>/);
});

test('CodebuddyElicitationCard uses unique error ids across concurrent cards', () => {
  const makeCard = (elicitationId: string) => (
    <CodebuddyElicitationCard
      elicitation={{
        elicitationId,
        chatSessionId: 'chat-1',
        request: {
          requestedSchema: {
            type: 'object',
            properties: {
              retries: {
                type: 'integer',
                minimum: 2,
                default: 1,
              },
            },
          },
        },
      }}
      onRespond={async () => {}}
    />
  );
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      {makeCard('el-1')}
      {makeCard('el-2')}
    </I18nProvider>,
  );
  const ids = Array.from(markup.matchAll(/id="([^"]+-field-0-error)"/g), (match) => match[1]);
  const describedByIds = Array.from(
    markup.matchAll(/aria-describedby="([^"]+-field-0-error)"/g),
    (match) => match[1],
  );

  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(describedByIds, ids);
});

test('CodebuddyElicitationCard shows "must be whole number" for decimal integer input', () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <CodebuddyElicitationCard
        elicitation={{
          elicitationId: 'el-integer',
          chatSessionId: 'chat-1',
          request: {
            message: 'Pick an integer',
            requestedSchema: {
              type: 'object',
              properties: {
                retries: {
                  type: 'integer',
                  title: 'Retries',
                  default: 3.5,
                },
              },
              required: ['retries'],
            },
          },
        }}
        onRespond={async () => {}}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Retries must be a whole number\./);
  assert.match(markup, /aria-invalid="true"/);
});

test('CodebuddyElicitationCard can clear optional constrained values back to omitted', async () => {
  const responses: Array<{
    action: string;
    content?: Record<string, unknown>;
  }> = [];
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <CodebuddyElicitationCard
        elicitation={{
          elicitationId: 'el-optional',
          chatSessionId: 'chat-1',
          request: {
            requestedSchema: {
              type: 'object',
              properties: {
                contact: {
                  type: 'string',
                  format: 'email',
                },
                regions: {
                  type: 'array',
                  minItems: 1,
                  items: { enum: ['us-east'] },
                },
              },
            },
          },
        }}
        onRespond={async (action, content) => {
          responses.push({ action, content });
        }}
      />,
    );
  });

  const emailInput = renderer!.root.findByProps({ type: 'email' });
  const regionInput = renderer!.root.findByProps({ type: 'checkbox' });
  await act(async () => {
    emailInput.props.onChange({ target: { value: 'cat@example.com' } });
    regionInput.props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    emailInput.props.onChange({ target: { value: '' } });
    regionInput.props.onChange({ target: { checked: false } });
  });

  const continueButton = renderer!.root
    .findAllByType('button')
    .find((button) => button.children.join('') === 'ai.codebuddy.elicitation.accept');
  assert.ok(continueButton);
  assert.equal(continueButton.props.disabled, false);

  await act(async () => {
    continueButton.props.onClick();
    await Promise.resolve();
  });
  assert.deepEqual(responses, [{ action: 'accept', content: {} }]);

  await act(async () => {
    renderer!.unmount();
  });
});

test('CodebuddyElicitationCard submits required empty values when no size constraint forbids them', async () => {
  const responses: Array<{
    action: string;
    content?: Record<string, unknown>;
  }> = [];
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <CodebuddyElicitationCard
        elicitation={{
          elicitationId: 'el-required-empty',
          chatSessionId: 'chat-1',
          request: {
            requestedSchema: {
              type: 'object',
              properties: {
                note: {
                  type: 'string',
                  default: 'temporary',
                },
                regions: {
                  type: 'array',
                  default: ['us-east'],
                  items: { enum: ['us-east'] },
                },
              },
              required: ['note', 'regions'],
            },
          },
        }}
        onRespond={async (action, content) => {
          responses.push({ action, content });
        }}
      />,
    );
  });

  const noteInput = renderer!.root.findByProps({ type: 'text' });
  const regionInput = renderer!.root.findByProps({ type: 'checkbox' });
  await act(async () => {
    noteInput.props.onChange({ target: { value: '' } });
    regionInput.props.onChange({ target: { checked: false } });
  });

  const continueButton = renderer!.root
    .findAllByType('button')
    .find((button) => button.children.join('') === 'ai.codebuddy.elicitation.accept');
  assert.ok(continueButton);
  assert.equal(continueButton.props.disabled, false);

  await act(async () => {
    continueButton.props.onClick();
    await Promise.resolve();
  });
  assert.deepEqual(responses, [{
    action: 'accept',
    content: {
      note: '',
      regions: [],
    },
  }]);

  await act(async () => {
    renderer!.unmount();
  });
});
