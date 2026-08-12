export const CHAT_INPUT_MIN_HEIGHT = 112;
export const CHAT_INPUT_MAX_HEIGHT = 420;
export const CHAT_INPUT_DEFAULT_HEIGHT = 128;
export const CHAT_INPUT_PANEL_RESERVE = 112;

export function resolveChatInputMaxHeight(panelHeight: number): number {
  return Math.max(
    CHAT_INPUT_MIN_HEIGHT,
    Math.min(CHAT_INPUT_MAX_HEIGHT, panelHeight - CHAT_INPUT_PANEL_RESERVE),
  );
}

export function resolveVisibleChatInputMaxHeight(panelHeight: number): number | null {
  if (!Number.isFinite(panelHeight) || panelHeight <= 0) return null;
  return resolveChatInputMaxHeight(panelHeight);
}

export function resolveVisibleChatInputHeight(
  desiredHeight: number | null,
  maxHeight: number,
): number | null {
  return desiredHeight == null ? null : Math.min(desiredHeight, maxHeight);
}

export function resolveChatInputAriaHeight(
  height: number | null,
  maxHeight: number,
): number {
  return Math.max(
    CHAT_INPUT_MIN_HEIGHT,
    Math.min(maxHeight, height ?? CHAT_INPUT_DEFAULT_HEIGHT),
  );
}

export function resolveChatInputResizeHeight(
  startHeight: number,
  startPointerY: number,
  pointerY: number,
  maxHeight: number,
): number {
  return Math.min(
    maxHeight,
    Math.max(CHAT_INPUT_MIN_HEIGHT, startHeight + startPointerY - pointerY),
  );
}
