import type { TerminalSession } from "../../domain/models";
import { isVaultInitialized } from "../../application/state/vaultInitStore";

export type TerminalReconnectMode = "restored" | "manual" | "automatic";

export const getInitialTerminalStatus = (): TerminalSession["status"] => (
  "connecting"
);

export const resolveTerminalVaultInitialized = (
  sharedVaultInitialized: boolean,
  windowVaultInitialized?: boolean,
): boolean => windowVaultInitialized ?? sharedVaultInitialized;

/**
 * Backend start waits for vault hydration so restored sessions cannot dial SSH
 * with empty keys while hosts have already been published mid-init.
 */
export const shouldStartTerminalBackend = (): boolean => isVaultInitialized();

export const shouldSuppressHostStartupCommandOnReconnect = (
  mode: TerminalReconnectMode,
): boolean => mode === "automatic";
