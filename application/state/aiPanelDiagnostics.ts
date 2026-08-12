import type React from 'react';
import {
  STORAGE_KEY_AI_PANEL_DIAGNOSTIC_HIDE,
  STORAGE_KEY_AI_PANEL_DIAGNOSTIC_PROFILE,
} from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export const AI_PANEL_DIAGNOSTIC_HIDE_KEY = STORAGE_KEY_AI_PANEL_DIAGNOSTIC_HIDE;
export const AI_PANEL_DIAGNOSTIC_PROFILE_KEY = STORAGE_KEY_AI_PANEL_DIAGNOSTIC_PROFILE;
export const AI_PANEL_FORCE_HIDE_ALL_CONTENT = false;
export const AI_PANEL_FORCE_HIDE_SHELL = false;

export type AIPanelDiagnosticPart =
  | 'all'
  | 'attachments'
  | 'header'
  | 'history'
  | 'input'
  | 'markdown'
  | 'messages'
  | 'recent'
  | 'toolcalls';

function readLocalStorageValue(key: string): string {
  try {
    return localStorageAdapter.readString(key) ?? '';
  } catch {
    return '';
  }
}

export function getAIPanelDiagnosticHiddenParts(): ReadonlySet<string> {
  if (AI_PANEL_FORCE_HIDE_ALL_CONTENT) {
    return new Set(['all']);
  }
  const raw = readLocalStorageValue(AI_PANEL_DIAGNOSTIC_HIDE_KEY);
  return new Set(
    raw
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAIPanelDiagnosticPartHidden(
  part: AIPanelDiagnosticPart,
  hiddenParts = getAIPanelDiagnosticHiddenParts(),
): boolean {
  return hiddenParts.has('all') || hiddenParts.has(part);
}

export function isAIPanelDiagnosticsProfilingEnabled(): boolean {
  const raw = readLocalStorageValue(AI_PANEL_DIAGNOSTIC_PROFILE_KEY).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function logAIPanelProfiler(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number,
): void {
  if (!isAIPanelDiagnosticsProfilingEnabled()) return;
  console.info(
    `[AI panel profile] ${id} ${phase}: actual=${actualDuration.toFixed(1)}ms base=${baseDuration.toFixed(1)}ms`,
  );
}

export function profileAIPanelCalculation<T>(label: string, calculate: () => T): T {
  if (!isAIPanelDiagnosticsProfilingEnabled()) return calculate();
  const startedAt = performance.now();
  try {
    return calculate();
  } finally {
    const elapsed = performance.now() - startedAt;
    console.info(`[AI panel profile] ${label}: ${elapsed.toFixed(1)}ms`);
  }
}

export function getAIPanelProfilerProps(id: string): Pick<React.ProfilerProps, 'id' | 'onRender'> {
  return {
    id,
    onRender: logAIPanelProfiler,
  };
}
