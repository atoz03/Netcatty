import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useTerminalAutocomplete } from "./autocomplete/useTerminalAutocomplete.ts";

test("useTerminalAutocomplete can render before any autocomplete interaction", () => {
  function Probe() {
    const termRef = useRef(null);
    const containerRef = useRef(null);
    const autocomplete = useTerminalAutocomplete({
      termRef,
      containerRef,
      sessionId: "session-1",
      hostId: "host-1",
      hostOs: "linux",
      onAcceptText: () => {},
    });

    return <span>{typeof autocomplete.repositionPopup}</span>;
  }

  assert.doesNotThrow(() => {
    renderToStaticMarkup(<Probe />);
  });
});

test("mount effect re-arms disposedRef after dispose cleanup (HMR / StrictMode)", () => {
  // dispose() sets disposedRef=true on effect cleanup. Fast Refresh preserves
  // refs, so without resetting on mount, fetchSuggestions stays dead forever
  // while handleInput keeps scheduling — "fetch-scheduled" with no popup.
  const source = readFileSync(
    fileURLToPath(new URL("./autocomplete/useTerminalAutocomplete.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(source.includes("disposedRef.current = false;"));
  assert.ok(source.includes("return () => { dispose(); };"));
});
