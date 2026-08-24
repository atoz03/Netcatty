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

async function detectCursorSdkInstalled() {
  const platformPackageName = getCursorPlatformPackageName();
  if (!platformPackageName) return false;
  try {
    await import("@cursor/sdk");
    require.resolve(`${platformPackageName}/package.json`);
    return true;
  } catch {
    return false;
  }
}

module.exports = { getCursorPlatformPackageName, detectCursorSdkInstalled };
