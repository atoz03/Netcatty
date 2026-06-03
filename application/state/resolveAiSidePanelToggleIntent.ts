export type AiSidePanelToggleIntent =
  | { kind: 'closeTerminalSidePanel' }
  | { kind: 'openAi' };

/**
 * Decide what the top-bar AI button should do given the side panel that is
 * currently open for the active tab.
 * - If the AI panel is already the open sub-panel → close the whole side panel.
 * - Otherwise (closed, or showing a different sub-panel) → switch to AI.
 */
export function resolveAiSidePanelToggleIntent(
  activePanel: string | null,
): AiSidePanelToggleIntent {
  if (activePanel === 'ai') {
    return { kind: 'closeTerminalSidePanel' };
  }

  return { kind: 'openAi' };
}
