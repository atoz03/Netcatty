import { useLayoutEffect, type ReactNode } from 'react';

import {
  AppSettingsRuntimeContext,
  registerAppSettingsRuntime,
} from '../../state/appRuntimeBridge';
import { useSettingsState } from '../../state/useSettingsState';

export type SettingsPublisherProps = {
  /** Peer session windows must not drive the main window's settings IPC sync. */
  enableSettingsSync: boolean;
  /** Peer session windows must not re-apply OS-level system settings effects. */
  enableSystemEffects: boolean;
  children?: ReactNode;
};

/**
 * Owns `useSettingsState` and hands it to consumers the same way
 * `VaultPublisher` / `SessionPublisher` hand over their runtimes: a context for
 * render-time reads and the `appRuntimeBridge` slot for imperative callers.
 *
 * The store fan-out (`settingsChromeStore` / `appearanceChromeStore`) already
 * happens inside `useSettingsState`, so this publisher only relocates the hook
 * out of the component that also builds the shell's domain bags.
 */
export function SettingsPublisher({
  enableSettingsSync,
  enableSystemEffects,
  children,
}: SettingsPublisherProps) {
  const settings = useSettingsState({ enableSettingsSync, enableSystemEffects });

  useLayoutEffect(() => {
    registerAppSettingsRuntime(settings);
  }, [settings]);

  // Only a real unmount clears the slot; see VaultPublisher for why.
  useLayoutEffect(() => () => {
    registerAppSettingsRuntime(null);
  }, []);

  return (
    <AppSettingsRuntimeContext.Provider value={settings}>
      {children}
    </AppSettingsRuntimeContext.Provider>
  );
}
