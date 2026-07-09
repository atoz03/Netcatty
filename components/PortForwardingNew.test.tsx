import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToString } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider";
import PortForwarding from "./PortForwardingNew";

function installLocalStorageMock() {
  const previous = globalThis.localStorage;
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  return () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: previous,
    });
  };
}

test("port forwarding vault section renders without runtime reference errors", () => {
  const restoreLocalStorage = installLocalStorageMock();
  try {
    const html = renderToString(
      <I18nProvider initialLocale="zh-CN">
        <PortForwarding
          hosts={[]}
          keys={[]}
          identities={[]}
          customGroups={[]}
          knownHosts={[]}
          managedSources={[]}
          groupConfigs={[]}
          proxyProfiles={[]}
          terminalSettings={{ keepaliveInterval: 30, keepaliveCountMax: 3 }}
        />
      </I18nProvider>,
    );

    assert.match(html, /Set up port forwarding/);
  } finally {
    restoreLocalStorage();
  }
});
