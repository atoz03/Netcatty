import { createContext, useContext } from 'react';

import type { useSessionState } from './useSessionState';
import type { useSettingsState } from './useSettingsState';
import type { useVaultState } from './useVaultState';

export type AppVaultRuntime = ReturnType<typeof useVaultState>;
export type AppSessionRuntime = ReturnType<typeof useSessionState>;
export type AppSettingsRuntime = ReturnType<typeof useSettingsState>;

/**
 * The slice of the vault runtime that `VaultPublisher` puts on the React
 * context.
 *
 * `notes` / `noteGroups` / `connectionLogs` / `shellHistory` are deliberately
 * absent. They churn on every note keystroke, session start/exit, and history
 * append, and publishing them here would re-render every context consumer for
 * data those consumers only ever read at call time. Consumers subscribe to
 * `notesStore` / `connectionLogsStore` / `shellHistoryStore` instead, or read
 * the full runtime imperatively through `getAppVaultRuntime()`.
 *
 * `exportData` is omitted for the same reason: its callback identity tracks the
 * notes arrays, so keeping it would reintroduce the churn it is meant to avoid.
 */
export type AppVaultContextValue = Omit<
  AppVaultRuntime,
  'notes' | 'noteGroups' | 'connectionLogs' | 'shellHistory' | 'exportData'
>;

type Listener = () => void;

/**
 * Holds the live return of one mega hook so the component that owns the hook
 * and the components that consume it no longer have to be the same component.
 *
 * `VaultPublisher` / `SessionPublisher` / `SettingsPublisher` own
 * `useVaultState` / `useSessionState` / `useSettingsState` and expose the value
 * two ways:
 *
 * - through a React context, for render-time consumers (App). Context keeps the
 *   read synchronous and non-null from the first render, which a store written
 *   in a layout effect cannot do for a descendant.
 * - through this module slot, for imperative callers that need the current
 *   runtime outside of a render (`getAppVaultRuntime()` in an event handler or
 *   a bridge callback) and for non-descendant subscribers.
 */
class RuntimeSlot<T> {
  private value: T | null = null;
  private listeners = new Set<Listener>();

  get = (): T | null => this.value;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(next: T | null): void {
    if (this.value === next) return;
    this.value = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const vaultSlot = new RuntimeSlot<AppVaultRuntime>();
const sessionSlot = new RuntimeSlot<AppSessionRuntime>();
const settingsSlot = new RuntimeSlot<AppSettingsRuntime>();

export function registerAppVaultRuntime(runtime: AppVaultRuntime | null): void {
  vaultSlot.set(runtime);
}

export function getAppVaultRuntime(): AppVaultRuntime | null {
  return vaultSlot.get();
}

export function subscribeAppVaultRuntime(listener: Listener): () => void {
  return vaultSlot.subscribe(listener);
}

export function registerAppSessionRuntime(runtime: AppSessionRuntime | null): void {
  sessionSlot.set(runtime);
}

export function getAppSessionRuntime(): AppSessionRuntime | null {
  return sessionSlot.get();
}

export function subscribeAppSessionRuntime(listener: Listener): () => void {
  return sessionSlot.subscribe(listener);
}

export function registerAppSettingsRuntime(runtime: AppSettingsRuntime | null): void {
  settingsSlot.set(runtime);
}

export function getAppSettingsRuntime(): AppSettingsRuntime | null {
  return settingsSlot.get();
}

export function subscribeAppSettingsRuntime(listener: Listener): () => void {
  return settingsSlot.subscribe(listener);
}

export const AppVaultRuntimeContext = createContext<AppVaultContextValue | null>(null);
export const AppSessionRuntimeContext = createContext<AppSessionRuntime | null>(null);
export const AppSettingsRuntimeContext = createContext<AppSettingsRuntime | null>(null);

/** Read the vault runtime owned by `VaultPublisher`. */
export function useAppVaultRuntime(): AppVaultContextValue {
  const runtime = useContext(AppVaultRuntimeContext);
  if (!runtime) {
    throw new Error('useAppVaultRuntime must be rendered inside <VaultPublisher>');
  }
  return runtime;
}

/** Read the session runtime owned by `SessionPublisher`. */
export function useAppSessionRuntime(): AppSessionRuntime {
  const runtime = useContext(AppSessionRuntimeContext);
  if (!runtime) {
    throw new Error('useAppSessionRuntime must be rendered inside <SessionPublisher>');
  }
  return runtime;
}

/** Read the settings runtime owned by `SettingsPublisher`. */
export function useAppSettingsRuntime(): AppSettingsRuntime {
  const runtime = useContext(AppSettingsRuntimeContext);
  if (!runtime) {
    throw new Error('useAppSettingsRuntime must be rendered inside <SettingsPublisher>');
  }
  return runtime;
}
