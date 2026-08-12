type Listener = () => void;

/**
 * Live terminal CWD map + version token.
 * OSC 7 / cwd probes update this store without setState on TerminalLayer,
 * so only subscribers (side-panel live snapshot bridge) re-render.
 */
class TerminalCwdStore {
  private cwdBySession = new Map<string, string>();
  private version = 0;
  private listeners = new Set<Listener>();

  getVersion = (): number => this.version;

  getCwd = (sessionId: string | null | undefined): string | null => {
    if (!sessionId) return null;
    return this.cwdBySession.get(sessionId) ?? null;
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setCwd(sessionId: string, cwd: string | null): boolean {
    const current = this.cwdBySession.get(sessionId) ?? null;
    const next = cwd && cwd.trim().length > 0 ? cwd : null;
    if (current === next) return false;

    if (next) {
      this.cwdBySession.set(sessionId, next);
    } else {
      this.cwdBySession.delete(sessionId);
    }
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
    return true;
  }

  prune(validSessionIds: ReadonlySet<string>): void {
    let changed = false;
    for (const sessionId of this.cwdBySession.keys()) {
      if (!validSessionIds.has(sessionId)) {
        this.cwdBySession.delete(sessionId);
        changed = true;
      }
    }
    if (!changed) return;
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const terminalCwdStore = new TerminalCwdStore();
