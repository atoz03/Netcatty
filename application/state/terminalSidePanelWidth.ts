export const TERMINAL_SIDE_PANEL_MIN_WIDTH = 280;
export const TERMINAL_SIDE_PANEL_MAX_WIDTH = 1200;
export const TERMINAL_SIDE_PANEL_MIN_TERMINAL_WIDTH = 320;
export const TERMINAL_SIDE_PANEL_TOOL_BUTTON_WIDTH = 28;
export const TERMINAL_SIDE_PANEL_TOOLBAR_RESERVED_WIDTH = 200;

export function getTerminalSidePanelAvailableWidth(
  terminalLayerWidth: number,
  occupiedSiblingWidth: number,
): number {
  return Math.max(0, terminalLayerWidth - occupiedSiblingWidth);
}

export function getTerminalSidePanelMaxWidth(availableSurfaceWidth: number): number {
  const availableWidth = availableSurfaceWidth - TERMINAL_SIDE_PANEL_MIN_TERMINAL_WIDTH;
  return Math.max(
    TERMINAL_SIDE_PANEL_MIN_WIDTH,
    Math.min(TERMINAL_SIDE_PANEL_MAX_WIDTH, availableWidth),
  );
}

export function clampTerminalSidePanelWidth(
  width: number,
  availableSurfaceWidth: number,
  contentMinimumWidth = TERMINAL_SIDE_PANEL_MIN_WIDTH,
): number {
  const maximumWidth = getTerminalSidePanelMaxWidth(availableSurfaceWidth);
  const minimumWidth = Math.min(
    maximumWidth,
    Math.max(TERMINAL_SIDE_PANEL_MIN_WIDTH, contentMinimumWidth),
  );
  return Math.max(minimumWidth, Math.min(maximumWidth, width));
}

export function getTerminalSidePanelMaxShownTools(panelWidth: number): number {
  return Math.max(
    1,
    Math.floor(
      (panelWidth - TERMINAL_SIDE_PANEL_TOOLBAR_RESERVED_WIDTH)
      / TERMINAL_SIDE_PANEL_TOOL_BUTTON_WIDTH,
    ),
  );
}
