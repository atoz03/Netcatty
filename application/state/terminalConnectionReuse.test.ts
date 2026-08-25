import test from "node:test";
import assert from "node:assert/strict";

import type { TerminalSession } from "../../domain/models";
import {
  canReuseTerminalConnection,
  createCopiedTerminalSessionClone,
  createSplitTerminalSessionClone,
  isTerminalSessionEligibleForSftpReuse,
} from "./terminalConnectionReuse";

const session = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: "session-1",
  hostId: "host-1",
  hostLabel: "Host",
  hostname: "example.com",
  username: "alice",
  status: "connected",
  protocol: "ssh",
  ...overrides,
});

test("connected SSH sessions can reuse their authenticated connection", () => {
  assert.equal(canReuseTerminalConnection(session()), true);
  assert.equal(canReuseTerminalConnection(session({ protocol: undefined })), true);
});

test("SSH sessions stay SFTP-linkable while reconnecting", () => {
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ status: "connecting" })), true);
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ status: "disconnected" })), true);
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ protocol: "local" })), false);
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ moshEnabled: true })), false);
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ etEnabled: true })), false);
});

test("non-SSH or unavailable sessions do not reuse a connection", () => {
  assert.equal(canReuseTerminalConnection(session({ status: "connecting" })), false);
  assert.equal(canReuseTerminalConnection(session({ status: "disconnected" })), false);
  assert.equal(canReuseTerminalConnection(session({ protocol: "local" })), false);
  assert.equal(canReuseTerminalConnection(session({ protocol: "serial" })), false);
  assert.equal(canReuseTerminalConnection(session({ protocol: "telnet" })), false);
  assert.equal(canReuseTerminalConnection(session({ moshEnabled: true })), false);
  assert.equal(canReuseTerminalConnection(session({ etEnabled: true })), false);
});

test("split session clones reuse only connected SSH sources", () => {
  assert.equal(
    createSplitTerminalSessionClone(session(), { id: "split-1", workspaceId: "workspace-1" }).reuseConnectionFromSessionId,
    "session-1",
  );
  assert.equal(
    createSplitTerminalSessionClone(session({ etEnabled: true }), { id: "split-2" }).reuseConnectionFromSessionId,
    undefined,
  );
  assert.equal(
    createSplitTerminalSessionClone(session({ moshEnabled: true }), { id: "split-3" }).reuseConnectionFromSessionId,
    undefined,
  );
});

test("session clones preserve the ephemeral-host marker", () => {
  assert.equal(
    createSplitTerminalSessionClone(session({ ephemeralHost: true }), { id: "split-1" }).ephemeralHost,
    true,
  );
  assert.equal(
    createCopiedTerminalSessionClone(session({ ephemeralHost: true }), { id: "copy-1" }).ephemeralHost,
    true,
  );
  assert.equal(
    createSplitTerminalSessionClone(session(), { id: "split-2" }).ephemeralHost,
    undefined,
  );
});

test("copy session clones reuse SSH sources and preserve serial config", () => {
  const copied = createCopiedTerminalSessionClone(
    session({
      serialConfig: { path: "/dev/tty.usbserial", baudRate: 115200 },
    }),
    { id: "copy-1" },
  );

  assert.equal(copied.reuseConnectionFromSessionId, "session-1");
  assert.deepEqual(copied.serialConfig, { path: "/dev/tty.usbserial", baudRate: 115200 });
});

test("split and copy session clones preserve local start directory", () => {
  const source = session({
    protocol: "local",
    localStartDir: "/Users/alice/project with spaces ",
  });

  assert.equal(
    createSplitTerminalSessionClone(source, { id: "split-local" }).localStartDir,
    "/Users/alice/project with spaces ",
  );
  assert.equal(
    createCopiedTerminalSessionClone(source, { id: "copy-local" }).localStartDir,
    "/Users/alice/project with spaces ",
  );
});

test("split clone applies remote inheritedCwd as pendingInitialCwd without touching localStartDir", () => {
  const clone = createSplitTerminalSessionClone(session({ protocol: "ssh" }), {
    id: "split-remote-cwd",
    inheritedCwd: "/var/log",
  });

  assert.equal(clone.pendingInitialCwd, "/var/log");
  assert.equal(clone.localStartDir, undefined);
});

test("split clone applies local inheritedCwd as localStartDir without pendingInitialCwd", () => {
  const clone = createSplitTerminalSessionClone(
    session({ protocol: "local", localStartDir: "/home/u", status: "connecting" }),
    { id: "split-local-cwd", localShellType: "posix", inheritedCwd: "/tmp/work" },
  );

  assert.equal(clone.localStartDir, "/tmp/work");
  assert.equal(clone.pendingInitialCwd, undefined);
});

test("clone does not set pendingInitialCwd for protocols that never inject a cd", () => {
  for (const overrides of [
    { protocol: "telnet" as const },
    { protocol: "serial" as const },
    { protocol: "ssh" as const, moshEnabled: true },
    { protocol: "ssh" as const, etEnabled: true },
  ]) {
    const clone = createSplitTerminalSessionClone(session(overrides), {
      id: "split-no-inject",
      inheritedCwd: "/var/log",
    });
    assert.equal(clone.pendingInitialCwd, undefined, `${JSON.stringify(overrides)} should not set pendingInitialCwd`);
  }
});

test("copy clone without inheritedCwd keeps localStartDir and sets no pendingInitialCwd", () => {
  const clone = createCopiedTerminalSessionClone(
    session({ protocol: "local", localStartDir: "/home/u", status: "connecting" }),
    { id: "copy-no-cwd", localShellType: "posix" },
  );

  assert.equal(clone.localStartDir, "/home/u");
  assert.equal(clone.pendingInitialCwd, undefined);
});

test("split and copy session clones preserve isolated plugin connection snapshots", () => {
  const pluginConnection = {
    providerId: "com.example.transport.connection",
    configuration: { endpoint: "gateway.example", options: ["fast"] },
    credentialId: "credential-reference-1234",
  };
  const source = session({
    protocol: `plugin:${pluginConnection.providerId}`,
    pluginConnection,
  });

  const split = createSplitTerminalSessionClone(source, { id: "split-plugin" });
  const copied = createCopiedTerminalSessionClone(source, { id: "copy-plugin" });

  assert.deepEqual(split.pluginConnection, pluginConnection);
  assert.deepEqual(copied.pluginConnection, pluginConnection);
  assert.notEqual(split.pluginConnection, pluginConnection);
  assert.notEqual(copied.pluginConnection, pluginConnection);
  assert.equal(split.reuseConnectionFromSessionId, undefined);
  assert.equal(copied.reuseConnectionFromSessionId, undefined);
});
