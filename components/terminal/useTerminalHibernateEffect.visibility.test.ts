import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("hibernate effect keeps isVisibleRef current even when hibernate is disabled", () => {
  const source = readFileSync(
    new URL("./useTerminalHibernateEffect.ts", import.meta.url),
    "utf8",
  );
  // Visibility sync must not early-return when hibernate is off; otherwise
  // solo tab switches leave write/recovery paths on a stale isVisibleRef.
  assert.doesNotMatch(
    source,
    /if \(!hibernateEnabled\) \{\s*clearHibernateTimer\(\);[\s\S]*return \(\) => \{\s*unsubscribeDisabled\(\);\s*\};\s*\}/,
  );
  assert.match(source, /isVisibleRef\.current = visible;/);
  assert.match(
    source,
    /if \(hibernateEnabled\) \{\s*scheduleHibernate\(\);\s*\}/,
  );
});
