import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import { useStoredBoolean } from "../../../application/state/useStoredBoolean";
import { STORAGE_KEY_TERMINAL_SEARCH_OPEN } from "../../../infrastructure/config/storageKeys";

type SearchMatchCount = { current: number; total: number } | null;

const SEARCH_DECORATIONS = {
  matchBackground: "#FFFF0044",
  matchBorder: "#FFFF00",
  matchOverviewRuler: "#FFFF00",
  activeMatchBackground: "#FF880088",
  activeMatchBorder: "#FF8800",
  activeMatchColorOverviewRuler: "#FF8800",
} as const;

const SEARCH_OPTIONS = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  decorations: SEARCH_DECORATIONS,
} as const;

export const resetTerminalSearch = (
  searchAddon: Pick<SearchAddon, "findNext" | "clearDecorations"> | null,
  searchTermRef: { current: string },
  term?: Pick<XTerm, "refresh" | "rows"> | null,
): void => {
  searchTermRef.current = "";
  // The addon's empty-search path clears both its decorations and the terminal
  // selection used for the active match. clearDecorations() alone leaves that
  // selection visible.
  searchAddon?.findNext("", SEARCH_OPTIONS);
  // findNext("") assigns cachedSearchTerm back to "". Clear decorations again
  // so the addon drops that cache to undefined and cannot revive match
  // highlights via its delayed onResize/onWriteParsed update path.
  searchAddon?.clearDecorations();
  // Disposing search decorations does not always repaint cells (observed on
  // Windows after clearing or closing search). Keyword highlighting already
  // forces a refresh after dispose; do the same here so yellow match
  // backgrounds cannot linger.
  if (term && term.rows > 0) {
    term.refresh(0, term.rows - 1);
  }
};

export const useTerminalSearch = ({
  searchAddonRef,
  termRef,
}: {
  searchAddonRef: RefObject<SearchAddon | null>;
  termRef: RefObject<XTerm | null>;
}) => {
  const [isSearchOpen, setIsSearchOpen] = useStoredBoolean(
    STORAGE_KEY_TERMINAL_SEARCH_OPEN,
    false,
  );
  const [searchMatchCount, setSearchMatchCount] = useState<SearchMatchCount>(null);
  // Bumped each time the search hotkey fires. The SearchBar watches this token
  // to refocus its input — without it, calling setIsSearchOpen(true) when
  // already open is a no-op (React bails on the unchanged boolean) and focus
  // never returns to the input. See issue #1789.
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchTermRef = useRef<string>("");

  // Invoked by the searchTerminal hotkey (Cmd/Ctrl+F). Always opens the bar
  // and bumps the focus token: when closed, setIsSearchOpen(true) mounts the
  // SearchBar (whose isOpen effect focuses the input); when open, the token
  // bump makes the SearchBar re-run its focus effect and refocus. Doing both
  // unconditionally avoids reading `isSearchOpen` here — the xterm runtime
  // captures this callback once at creation (it only re-runs on host.id /
  // sessionId change), so a stale `isSearchOpen` closure would otherwise pick
  // the wrong branch.
  const requestSearchFocus = useCallback(() => {
    setIsSearchOpen(true);
    setSearchFocusToken((n) => n + 1);
  }, [setIsSearchOpen]);

  const handleToggleSearch = useCallback(() => {
    const next = !isSearchOpen;
    setIsSearchOpen(next);
    if (!next) {
      setSearchMatchCount(null);
      resetTerminalSearch(searchAddonRef.current, searchTermRef, termRef.current);
    }
  }, [isSearchOpen, searchAddonRef, setIsSearchOpen, termRef]);

  const handleSearch = useCallback(
    (term: string): boolean => {
      const searchAddon = searchAddonRef.current;
      if (!searchAddon || !term) {
        resetTerminalSearch(searchAddon, searchTermRef, termRef.current);
        setSearchMatchCount(null);
        return false;
      }

      searchTermRef.current = term;
      searchAddon.clearDecorations();

      const found = searchAddon.findNext(term, SEARCH_OPTIONS);

      if (found) {
        setSearchMatchCount({ current: 1, total: 1 });
      } else {
        setSearchMatchCount({ current: 0, total: 0 });
      }

      return found;
    },
    [searchAddonRef, termRef],
  );

  const handleFindNext = useCallback((): boolean => {
    const searchAddon = searchAddonRef.current;
    const term = searchTermRef.current;
    if (!searchAddon || !term) return false;
    return searchAddon.findNext(term, SEARCH_OPTIONS);
  }, [searchAddonRef]);

  const handleFindPrevious = useCallback((): boolean => {
    const searchAddon = searchAddonRef.current;
    const term = searchTermRef.current;
    if (!searchAddon || !term) return false;
    return searchAddon.findPrevious(term, SEARCH_OPTIONS);
  }, [searchAddonRef]);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchMatchCount(null);
    resetTerminalSearch(searchAddonRef.current, searchTermRef, termRef.current);
    termRef.current?.focus();
  }, [searchAddonRef, setIsSearchOpen, termRef]);

  return {
    isSearchOpen,
    setIsSearchOpen,
    searchMatchCount,
    searchFocusToken,
    requestSearchFocus,
    handleToggleSearch,
    handleSearch,
    handleFindNext,
    handleFindPrevious,
    handleCloseSearch,
  };
};
