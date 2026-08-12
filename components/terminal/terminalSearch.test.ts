import assert from "node:assert/strict";
import test from "node:test";

import { notifyTerminalSearchTermChange } from "./TerminalSearchBar.tsx";
import { resetTerminalSearch } from "./hooks/useTerminalSearch.ts";

test("clearing the search input notifies the terminal search handler", () => {
  const terms: string[] = [];
  const onSearch = (term: string) => {
    terms.push(term);
    return false;
  };

  let previousTerm = notifyTerminalSearchTermChange("needle", "", onSearch);
  previousTerm = notifyTerminalSearchTermChange("", previousTerm, onSearch);

  assert.equal(previousTerm, "");
  assert.deepEqual(terms, ["needle", ""]);
});

test("unchanged search input does not repeat a search", () => {
  const terms: string[] = [];

  const previousTerm = notifyTerminalSearchTermChange("needle", "needle", (term) => {
    terms.push(term);
    return false;
  });

  assert.equal(previousTerm, "needle");
  assert.deepEqual(terms, []);
});

test("resetting terminal search clears both match decorations and active selection", () => {
  let decorationsVisible = true;
  let activeSelectionVisible = true;
  const searchedTerms: string[] = [];
  const searchAddon = {
    findNext(term: string) {
      searchedTerms.push(term);
      if (term === "") {
        decorationsVisible = false;
        activeSelectionVisible = false;
      }
      return false;
    },
    clearDecorations() {},
  };
  const searchTermRef = { current: "needle" };

  resetTerminalSearch(searchAddon, searchTermRef);

  assert.equal(searchTermRef.current, "");
  assert.deepEqual(searchedTerms, [""]);
  assert.equal(decorationsVisible, false);
  assert.equal(activeSelectionVisible, false);
});

test("resetting terminal search clears cached decorations and refreshes the terminal", () => {
  // Disposing search decorations can leave yellow match backgrounds painted on
  // the canvas (seen on Windows after clearing/closing search). Keyword
  // highlighting already forces a refresh after dispose; search reset must too.
  const calls: string[] = [];
  const searchAddon = {
    findNext(term: string) {
      calls.push(`findNext:${term}`);
      return false;
    },
    clearDecorations() {
      calls.push("clearDecorations");
    },
  };
  const term = {
    rows: 24,
    refresh(start: number, end: number) {
      calls.push(`refresh:${start}:${end}`);
    },
  };
  const searchTermRef = { current: "needle" };

  resetTerminalSearch(searchAddon, searchTermRef, term);

  assert.equal(searchTermRef.current, "");
  assert.deepEqual(calls, ["findNext:", "clearDecorations", "refresh:0:23"]);
});
