import React, { useEffect } from 'react';

import { initializeFonts } from './application/state/fontStore';
import { initializeUIFonts } from './application/state/uiFontStore';
import { useSettingsChromeStore } from './application/state/settingsChromeStore';
import { I18nProvider } from './application/i18n/I18nProvider';
import { ToastProvider } from './components/ui/toast';
import { TooltipProvider } from './components/ui/tooltip';
import { ScriptAutomationRoot } from './components/scripts/ScriptAutomationRoot';
import { ExternalMcpApprovalsHost } from './components/ai/ExternalMcpApprovalsHost';
import { PluginAuthenticationHost } from './components/plugins/PluginAuthenticationHost';
import { useExternalMcpGrantPersister } from './components/ai/useExternalMcpGrantPersister';
import { setupMcpApprovalBridge } from './infrastructure/ai/shared/approvalGate';
import { setupCodexAppServerInteractionBridge } from './infrastructure/ai/shared/codexAppServerInteractions';
import { netcattyBridge } from './infrastructure/services/netcattyBridge';
import { AppShell } from './application/app/AppShell';
import { AppLocalStateProvider } from './application/app/AppLocalState';
import { AppSideEffects } from './application/app/AppSideEffects';
import { SessionPublisher } from './application/app/publishers/SessionPublisher';
import { SettingsPublisher } from './application/app/publishers/SettingsPublisher';
import { VaultPublisher } from './application/app/publishers/VaultPublisher';

// Initialize fonts eagerly at app startup
initializeFonts();
initializeUIFonts();

let rendererReadySent = false;

/**
 * Bridges the locale out of settings chrome without pulling App into a
 * settings-subscribing mega component.
 */
function SettingsI18nProvider({ children }: { children: React.ReactNode }) {
  const { uiLanguage } = useSettingsChromeStore();
  return <I18nProvider locale={uiLanguage}>{children}</I18nProvider>;
}

/**
 * Thin coordinator: no vault/session/settings React subscriptions and no
 * domain bag construction. Publishers own mega hooks; Host islands build
 * shell bags; AppSideEffects owns reactive effects + local UI publishing.
 */
function App() {
  return (
    <AppLocalStateProvider>
      <AppSideEffects />
      <AppShell />
    </AppLocalStateProvider>
  );
}

function AppWithProviders() {
  const isPeerSessionWindow = typeof window !== 'undefined' && window.location.hash.startsWith('#/session-window');

  useEffect(() => {
    let splashRemovalTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const splash = document.getElementById('splash');
      if (splash) {
        splash.classList.add('fade-out');
        splashRemovalTimer = setTimeout(() => splash.remove(), 200);
      }
      if (!rendererReadySent) {
        rendererReadySent = true;
        netcattyBridge.get()?.rendererReady?.();
      }
    } catch {
      // ignore
    }
    return () => {
      if (splashRemovalTimer !== undefined) clearTimeout(splashRemovalTimer);
    };
  }, []);

  useEffect(() => {
    return setupMcpApprovalBridge();
  }, []);

  useEffect(() => {
    return setupCodexAppServerInteractionBridge();
  }, []);

  useExternalMcpGrantPersister();

  return (
    <SettingsPublisher
      enableSettingsSync={!isPeerSessionWindow}
      enableSystemEffects={!isPeerSessionWindow}
    >
      <SettingsI18nProvider>
        <ToastProvider>
          <TooltipProvider delayDuration={300}>
            <ScriptAutomationRoot />
            <ExternalMcpApprovalsHost />
            <PluginAuthenticationHost />
            <VaultPublisher>
              <SessionPublisher persistSessionRestore={!isPeerSessionWindow}>
                <App />
              </SessionPublisher>
            </VaultPublisher>
          </TooltipProvider>
        </ToastProvider>
      </SettingsI18nProvider>
    </SettingsPublisher>
  );
}

export default AppWithProviders;
