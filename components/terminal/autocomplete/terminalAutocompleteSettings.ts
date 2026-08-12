import type { AutocompleteSettings } from "./useTerminalAutocomplete";
import type { AutocompleteHistoryScope } from "../../../domain/models";

type TerminalAutocompleteSettingFields = {
  autocompleteEnabled?: boolean;
  autocompleteGhostText?: boolean;
  autocompletePopupMenu?: boolean;
  autocompleteDebounceMs?: number;
  autocompleteMinChars?: number;
  autocompleteMaxSuggestions?: number;
  autocompleteHistoryScope?: AutocompleteHistoryScope;
  shiftEnterNewlineEnabled?: boolean;
};

export function resolveTerminalAutocompleteSettings(input: {
  protocol?: string;
  terminalSettings?: TerminalAutocompleteSettingFields;
}): Partial<AutocompleteSettings> | undefined {
  const { protocol, terminalSettings } = input;

  if (protocol === "serial") {
    return {
      enabled: terminalSettings?.autocompleteEnabled ?? true,
      showGhostText: terminalSettings?.autocompleteGhostText ?? true,
      showPopupMenu: terminalSettings?.autocompletePopupMenu ?? true,
      livePreview: false,
      allowLineReplacement: false,
      debounceMs: terminalSettings?.autocompleteDebounceMs ?? 100,
      minChars: terminalSettings?.autocompleteMinChars ?? 1,
      maxSuggestions: terminalSettings?.autocompleteMaxSuggestions ?? 50,
      historyScope: terminalSettings?.autocompleteHistoryScope ?? "host",
      shiftEnterNewlineEnabled: terminalSettings?.shiftEnterNewlineEnabled ?? true,
    };
  }

  if (!terminalSettings) return undefined;

  return {
    enabled: terminalSettings.autocompleteEnabled ?? true,
    showGhostText: terminalSettings.autocompleteGhostText ?? true,
    showPopupMenu: terminalSettings.autocompletePopupMenu ?? true,
    livePreview: true,
    allowLineReplacement: true,
    debounceMs: terminalSettings.autocompleteDebounceMs ?? 100,
    minChars: terminalSettings.autocompleteMinChars ?? 1,
    maxSuggestions: terminalSettings.autocompleteMaxSuggestions ?? 50,
    historyScope: terminalSettings.autocompleteHistoryScope ?? "host",
    shiftEnterNewlineEnabled: terminalSettings.shiftEnterNewlineEnabled ?? true,
  };
}
