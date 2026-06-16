export const MANAGED_TERMINAL_OPEN_EVENT = 'netcatty:managed-terminal-open';

export type ManagedTerminalOpenDetail = {
  sessionId: string;
  title: string;
  startupCommand: string;
  options?: { mode?: 'tab' | 'verticalSplit' };
};

export function requestManagedTerminalOpen(detail: ManagedTerminalOpenDetail): boolean {
  if (typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<ManagedTerminalOpenDetail>(MANAGED_TERMINAL_OPEN_EVENT, {
    detail,
  }));
  return true;
}
