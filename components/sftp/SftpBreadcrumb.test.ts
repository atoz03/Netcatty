import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getSftpBreadcrumbSegments } from "../../application/state/sftp/utils.ts";
import {
  normalizeSftpBreadcrumbMaxVisibleParts,
  resolveSftpBreadcrumbVisibleParts,
  scrollSftpBreadcrumbViewportToTail,
  shouldShowSftpBreadcrumbEllipsis,
  splitSftpBreadcrumbPinnedParts,
} from "./SftpBreadcrumb.tsx";

const breadcrumbSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "SftpBreadcrumb.tsx"),
  "utf8",
);

test("deep unix paths keep the first segment and trailing segments", () => {
  const { segments } = getSftpBreadcrumbSegments(
    "/var/www/apps/netcatty/releases/current/public",
  );
  const resolved = resolveSftpBreadcrumbVisibleParts({
    segments,
    maxVisibleParts: 4,
  });

  assert.equal(resolved.needsTruncation, true);
  assert.deepEqual(
    resolved.visibleParts.map((part) => part.segment.label),
    ["var", "releases", "current", "public"],
  );
  assert.deepEqual(
    resolved.hiddenParts.map((part) => part.segment.label),
    ["www", "apps", "netcatty"],
  );

  const split = splitSftpBreadcrumbPinnedParts(resolved.visibleParts);
  assert.equal(split.leadingPart?.segment.label, "var");
  assert.deepEqual(
    split.trailingParts.map((part) => part.segment.label),
    ["releases", "current", "public"],
  );
});

test("windows drive paths keep the drive letter while preferring the tail", () => {
  const { segments } = getSftpBreadcrumbSegments(
    "C:\\Users\\alice\\projects\\netcatty\\src\\components",
  );
  const resolved = resolveSftpBreadcrumbVisibleParts({
    segments,
    maxVisibleParts: 4,
  });

  assert.equal(resolved.needsTruncation, true);
  assert.equal(resolved.visibleParts[0]?.segment.label, "C:");
  assert.deepEqual(
    resolved.visibleParts.slice(1).map((part) => part.segment.label),
    ["netcatty", "src", "components"],
  );
});

test("windows UNC paths keep the share root while preferring the tail", () => {
  const { segments } = getSftpBreadcrumbSegments(
    "\\\\wsl.localhost\\Ubuntu-22.04\\home\\alice\\projects\\netcatty\\src",
  );
  const resolved = resolveSftpBreadcrumbVisibleParts({
    segments,
    maxVisibleParts: 4,
  });

  assert.equal(resolved.needsTruncation, true);
  assert.equal(
    resolved.visibleParts[0]?.segment.label,
    "\\\\wsl.localhost\\Ubuntu-22.04",
  );
  assert.deepEqual(
    resolved.visibleParts.slice(1).map((part) => part.segment.label),
    ["projects", "netcatty", "src"],
  );
});

test("budget of one keeps the leading root and still exposes hidden segments via ellipsis", () => {
  assert.equal(normalizeSftpBreadcrumbMaxVisibleParts(0), 1);
  assert.equal(normalizeSftpBreadcrumbMaxVisibleParts(1.9), 1);

  const { segments } = getSftpBreadcrumbSegments(
    "C:\\Users\\alice\\projects\\netcatty\\src",
  );
  const resolved = resolveSftpBreadcrumbVisibleParts({
    segments,
    maxVisibleParts: 1,
  });

  assert.equal(resolved.needsTruncation, true);
  assert.deepEqual(
    resolved.visibleParts.map((part) => part.segment.label),
    ["C:"],
  );
  assert.ok(resolved.hiddenParts.length >= 3);
  assert.equal(
    shouldShowSftpBreadcrumbEllipsis({
      needsTruncation: resolved.needsTruncation,
      hiddenPartsCount: resolved.hiddenParts.length,
    }),
    true,
  );
  assert.deepEqual(splitSftpBreadcrumbPinnedParts(resolved.visibleParts).trailingParts, []);
});

test("breadcrumb pins leading chrome and only scrolls trailing chips", () => {
  assert.doesNotMatch(breadcrumbSource, /dir="rtl"/);
  assert.match(breadcrumbSource, /splitSftpBreadcrumbPinnedParts/);
  assert.match(breadcrumbSource, /shouldShowSftpBreadcrumbEllipsis/);
  assert.match(breadcrumbSource, /scrollSftpBreadcrumbViewportToTail/);
  assert.match(breadcrumbSource, /shrink-0/);
  assert.match(breadcrumbSource, /flex-1 overflow-hidden/);

  const calls: Array<{ left: number }> = [];
  const viewport = {
    scrollWidth: 400,
    clientWidth: 120,
    set scrollLeft(value: number) {
      calls.push({ left: value });
    },
    get scrollLeft() {
      return calls.at(-1)?.left ?? 0;
    },
  } as HTMLElement;

  scrollSftpBreadcrumbViewportToTail(viewport);
  assert.deepEqual(calls, [{ left: 280 }]);

  const shortCalls: number[] = [];
  scrollSftpBreadcrumbViewportToTail({
    scrollWidth: 100,
    clientWidth: 120,
    set scrollLeft(value: number) {
      shortCalls.push(value);
    },
    get scrollLeft() {
      return shortCalls.at(-1) ?? 0;
    },
  } as HTMLElement);
  assert.deepEqual(shortCalls, [0]);
});
