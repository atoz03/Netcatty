import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../../../../application/i18n/I18nProvider';
import { CodexConnectionCard } from './CodexConnectionCard';

test('CodexConnectionCard surfaces the experimental App Server runtime', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(CodexConnectionCard, {
        pathInfo: { path: '/usr/bin/codex', version: '0.144.3', available: true },
        isResolvingPath: false,
        customPath: '',
        onCustomPathChange: () => {},
        onRecheckPath: () => {},
        onResetPath: () => {},
        integration: null,
        loginSession: null,
        isLoading: false,
        error: null,
        onRefresh: () => {},
        onConnect: () => {},
        onCancel: () => {},
        onOpenUrl: () => {},
        onLogout: () => {},
        appServerRuntime: 'app-server',
        appServerStatus: { available: true },
        onAppServerRuntimeChange: () => {},
      }),
    ),
  );
  assert.match(markup, /Use Codex App Server/);
  assert.match(markup, /Experimental/);
  assert.match(markup, /App Server is available/);
  assert.match(markup, /role="switch"/);
  assert.match(markup, /aria-checked="true"/);
});
