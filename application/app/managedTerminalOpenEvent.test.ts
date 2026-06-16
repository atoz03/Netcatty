import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGED_TERMINAL_OPEN_EVENT,
  requestManagedTerminalOpen,
  type ManagedTerminalOpenDetail,
} from './managedTerminalOpenEvent';

test('requestManagedTerminalOpen dispatches managed terminal open detail', () => {
  const previousWindow = globalThis.window;
  let received: ManagedTerminalOpenDetail | null = null;
  const listeners = new Map<string, (event: Event) => void>();
  globalThis.window = {
    addEventListener: (name: string, listener: EventListener) => {
      listeners.set(name, listener as (event: Event) => void);
    },
    removeEventListener: () => {},
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.(event);
      return true;
    },
  } as Window & typeof globalThis;

  window.addEventListener(MANAGED_TERMINAL_OPEN_EVENT, (event) => {
    received = (event as CustomEvent<ManagedTerminalOpenDetail>).detail;
  });

  try {
    const detail: ManagedTerminalOpenDetail = {
      sessionId: 'session-1',
      title: 'zellij: dev',
      startupCommand: "zellij attach 'dev'",
      options: { mode: 'tab' },
    };

    assert.equal(requestManagedTerminalOpen(detail), true);
    assert.deepEqual(received, detail);
  } finally {
    globalThis.window = previousWindow;
  }
});
