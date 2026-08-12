"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const cacheDir = path.join(root, "node_modules", ".cache", "netcatty", "codex-app-server-schema");
const sourceFile = path.join(cacheDir, "codex_app_server_protocol.schemas.json");
const targetFile = path.join(
  root,
  "electron",
  "bridges",
  "aiBridge",
  "codexAppServer",
  "protocol.schema.json",
);
const check = process.argv.includes("--check");

fs.rmSync(cacheDir, { recursive: true, force: true });
fs.mkdirSync(cacheDir, { recursive: true });

const codexEntry = require.resolve("@openai/codex/bin/codex.js");
execFileSync(process.execPath, [
  codexEntry,
  "app-server",
  "generate-json-schema",
  "--experimental",
  "--out",
  cacheDir,
], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

const generated = Buffer.from(
  `${JSON.stringify(sortJson(JSON.parse(fs.readFileSync(sourceFile, "utf8"))), null, 2)}\n`,
);
if (check) {
  const current = fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null;
  if (!current || !current.equals(generated)) {
    console.error("Codex App Server protocol schema is out of date. Run npm run generate:codex-app-server-schema.");
    process.exitCode = 1;
  }
} else {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, generated);
  console.log(`Updated ${path.relative(root, targetFile)}`);
}

fs.rmSync(cacheDir, { recursive: true, force: true });
