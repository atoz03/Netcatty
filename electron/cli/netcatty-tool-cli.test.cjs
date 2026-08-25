"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs } = require("./netcatty-tool-cli.cjs");

test("parseArgs consumes attachment filename flag", () => {
  const { positionals, opts } = parseArgs([
    "node",
    "netcatty-tool-cli",
    "attachment",
    "read",
    "--filename",
    "hosts.csv",
    "--chat-session",
    "chat-1",
    "--json",
  ]);

  assert.deepEqual(positionals, ["attachment", "read"]);
  assert.equal(opts.filename, "hosts.csv");
  assert.equal(opts.chatSessionId, "chat-1");
  assert.equal(opts.json, true);
});

test("parseArgs consumes snippet multi-line run mode flag", () => {
  const { positionals, opts } = parseArgs([
    "node",
    "netcatty-tool-cli",
    "snippets",
    "update",
    "--snippet-id",
    "snippet-1",
    "--multi-line-run-mode",
    "lineDelay",
    "--json",
  ]);

  assert.deepEqual(positionals, ["snippets", "update"]);
  assert.equal(opts.snippetId, "snippet-1");
  assert.equal(opts.multiLineRunMode, "lineDelay");
  assert.equal(opts.json, true);
});

test("parseArgs consumes dynamic script group targets", () => {
  const { positionals, opts } = parseArgs([
    "node",
    "netcatty-tool-cli",
    "scripts",
    "targets",
    "set",
    "--script-id",
    "script-1",
    "--target-groups",
    '["Production","Staging/Web"]',
    "--json",
  ]);

  assert.deepEqual(positionals, ["scripts", "targets", "set"]);
  assert.equal(opts.scriptId, "script-1");
  assert.equal(opts.targetGroups, '["Production","Staging/Web"]');
  assert.equal(opts.json, true);
});
