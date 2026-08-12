export function tryBeginDraftSend(gate: { current: boolean }): boolean {
  if (gate.current) {
    return false;
  }

  gate.current = true;
  return true;
}

export function endDraftSend(gate: { current: boolean }): void {
  gate.current = false;
}

export const tryBeginSend = tryBeginDraftSend;
export const endSend = endDraftSend;

const sendInFlightByKey = new Set<string>();

export function tryBeginSendForKey(key: string): boolean {
  if (!key || sendInFlightByKey.has(key)) return false;
  sendInFlightByKey.add(key);
  return true;
}

export function endSendForKey(key: string): void {
  if (!key) return;
  sendInFlightByKey.delete(key);
}
