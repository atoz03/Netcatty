import type { AgentEvent, CompactionTrace } from './types';

const DEFAULT_MAX_EVENTS = 2_000;
const DEFAULT_MAX_COMPACTIONS = 500;

export interface TraceExport {
  sessionId: string;
  events: AgentEvent[];
  compactions: CompactionTrace[];
  exportedAt: number;
}

export class TraceStore {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly compactions = new Map<string, CompactionTrace[]>();
  private readonly maxEvents: number;
  private readonly maxCompactions: number;

  constructor(
    maxEvents = DEFAULT_MAX_EVENTS,
    maxCompactions = Math.min(DEFAULT_MAX_COMPACTIONS, maxEvents),
  ) {
    this.maxEvents = Math.max(1, Math.floor(maxEvents));
    this.maxCompactions = Math.max(1, Math.floor(maxCompactions));
  }

  append(event: AgentEvent): void {
    const list = this.events.get(event.sessionId) ?? [];
    list.push(event);
    if (list.length > this.maxEvents) {
      list.splice(0, list.length - this.maxEvents);
    }
    this.events.set(event.sessionId, list);

    if (event.type === 'compaction') {
      const traces = this.compactions.get(event.sessionId) ?? [];
      traces.push(event.trace);
      if (traces.length > this.maxCompactions) {
        traces.splice(0, traces.length - this.maxCompactions);
      }
      this.compactions.set(event.sessionId, traces);
    }
  }

  getEvents(sessionId: string): readonly AgentEvent[] {
    return this.events.get(sessionId) ?? [];
  }

  getCompactions(sessionId: string): readonly CompactionTrace[] {
    return this.compactions.get(sessionId) ?? [];
  }

  exportTrace(sessionId: string): TraceExport {
    return {
      sessionId,
      events: [...(this.events.get(sessionId) ?? [])],
      compactions: [...(this.compactions.get(sessionId) ?? [])],
      exportedAt: Date.now(),
    };
  }

  clear(sessionId: string): void {
    this.events.delete(sessionId);
    this.compactions.delete(sessionId);
  }
}

/** Process-wide trace store for harness debugging. */
export const globalTraceStore = new TraceStore();
