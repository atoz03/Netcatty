/* eslint-disable no-undef */
// Cursor ships its SDK as an optional dependency plus a per-platform binary
// package, so whether it resolves is environment state rather than app logic.
// Keeping the probe in its own module gives the discovery handlers a seam they
// can stub, instead of the handler tests silently depending on whether the
// optional dependency happens to be installed in the current node_modules.
function getCursorPlatformPackageName(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `@cursor/sdk-darwin-${arch}`;
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) return `@cursor/sdk-linux-${arch}`;
  if (platform === "win32" && arch === "x64") return "@cursor/sdk-win32-x64";
  return null;
}

/**
 * Locate the ESM entry that `import("@cursor/sdk")` loads, without evaluating
 * the ~4 MB SDK (importing it just to detect it also kept it resident in the
 * main process for good). The package does not export package.json and its
 * CommonJS build is stripped from release builds, so walk the resolution paths
 * for the ESM entry instead of using require.resolve.
 */
function isCursorSdkEntryPresent() {
  const nodePath = require("node:path");
  const nodeFs = require("node:fs");
  for (const base of require.resolve.paths("@cursor/sdk") || []) {
    try {
      if (nodeFs.existsSync(nodePath.join(base, "@cursor", "sdk", "dist", "esm", "index.js"))) return true;
    } catch { /* keep looking */ }
  }
  return false;
}

async function detectCursorSdkInstalled() {
  const platformPackageName = getCursorPlatformPackageName();
  if (!platformPackageName) return false;
  try {
    require.resolve(`${platformPackageName}/package.json`);
    return isCursorSdkEntryPresent();
  } catch {
    return false;
  }
}

module.exports = { getCursorPlatformPackageName, detectCursorSdkInstalled };
