import assert from "node:assert/strict";
import test from "node:test";

import type { Host } from "../../domain/models.ts";
import { haveSameManagedSshAgentFields } from "./useManagedSourceSync.ts";

const host: Host = {
  id: "host-1",
  label: "Managed host",
  hostname: "managed.example.com",
  username: "root",
  port: 22,
  protocol: "ssh",
  os: "linux",
  tags: [],
};

test("managed SSH source comparison tracks every agent setting", () => {
  const changedFields: Array<keyof Host> = [
    "useSshAgent",
    "identityAgent",
    "identitiesOnly",
    "addKeysToAgent",
    "useKeychain",
  ];

  for (const field of changedFields) {
    const changed = {
      ...host,
      [field]: field === "identityAgent" || field === "addKeysToAgent"
        ? "changed"
        : true,
    };
    assert.equal(haveSameManagedSshAgentFields(host, changed), false, field);
  }

  assert.equal(haveSameManagedSshAgentFields(host, { ...host }), true);
});

test("managed SSH source comparison tracks identity file paths", () => {
  const withPaths = {
    ...host,
    identityFilePaths: ["~/.ssh/id_ed25519", "~/.ssh/id_backup"],
  };

  assert.equal(haveSameManagedSshAgentFields(host, withPaths), false);
  assert.equal(haveSameManagedSshAgentFields(withPaths, host), false);
  assert.equal(haveSameManagedSshAgentFields(withPaths, {
    ...withPaths,
    identityFilePaths: [...withPaths.identityFilePaths],
  }), true);
  assert.equal(haveSameManagedSshAgentFields(withPaths, {
    ...withPaths,
    identityFilePaths: [...withPaths.identityFilePaths].reverse(),
  }), false);
});
