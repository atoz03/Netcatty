import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync(new URL("./combobox.tsx", import.meta.url), "utf8");

test("combobox option popovers use a native wheel-scrollable list", () => {
  assert.match(
    source,
    /function ComboboxOptionsList[\s\S]*max-h-\[280px\][\s\S]*overflow-y-auto[\s\S]*overscroll-contain/,
  );
  assert.match(source, /onWheelCapture=\{handleWheelCapture\}/);
  assert.match(source, /target\.scrollTop \+= wheelDeltaToPixels\(event\)/);
  assert.match(source, /event\.nativeEvent\.stopImmediatePropagation\(\)/);
  assert.match(source, /app-no-drag p-0 border-border\/60/);
  assert.doesNotMatch(source, /from "\.\/scroll-area"/);
});
