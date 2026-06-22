import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import type { Host } from "../domain/models";
import {
  prepareAutoRunSnippetCommand,
  prepareProtectedBroadcastSnippetData,
  shouldHideConnectingDialogForConnectionReuse,
  shouldShowTerminalConnectionDialog,
} from "./terminal/terminalHelpers";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "alice",
  authMethod: "password",
  ...overrides,
});

test("connection dialog is hidden while a reused SSH channel is opening", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
      hideConnectingDialogForConnectionReuse: true,
    }),
    false,
  );
});

test("connection dialog remains visible when reuse is not actually supported", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
      hideConnectingDialogForConnectionReuse: false,
    }),
    true,
  );
});

test("connection dialog still appears for fresh remote connections", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    true,
  );
});

test("connection dialog keeps existing local and disconnected behavior", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: true,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connected",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "disconnected",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: true,
    }),
    false,
  );
});

test("connection reuse hides connecting dialog only while reuse is still possible", () => {
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host(),
      connectionReuseFellBack: false,
    }),
    true,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host({ x11Forwarding: true }),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host({ moshEnabled: true }),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host({ etEnabled: true }),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host(),
      connectionReuseFellBack: true,
    }),
    false,
  );
});

test("auto-run snippets on Linux-like SSH hosts restore terminal mode afterwards", () => {
  const command = "bash <(curl -sSL https://linuxmirrors.cn/docker.sh)";

  const wrapped = prepareAutoRunSnippetCommand(command, {
    host: host({ protocol: "ssh", os: "linux", distro: "centos" }),
    noAutoRun: false,
    shellType: "posix",
  });

  assert.match(wrapped, /__netcatty_stty_state=/);
  assert.match(wrapped, /__netcatty_cmd_b64='/);
  assert.equal(wrapped.includes("\n"), false);
  assert.match(wrapped, /stty "\$__netcatty_stty_state"/);
  assert.match(wrapped, /trap __netcatty_restore INT TERM EXIT/);
  assert.match(wrapped, /trap - INT TERM EXIT/);
  assert.match(wrapped, /stty sane/);
  assert.match(wrapped, /\( exit \$__netcatty_status \)/);

  const encoded = wrapped.match(/__netcatty_cmd_b64='([^']+)'/)?.[1];
  assert.equal(Buffer.from(encoded ?? "", "base64").toString("utf8"), command);
});

test("auto-run snippets with unknown remote shell use a portable current-shell wrapper", () => {
  const command = "bash <(curl -sSL https://linuxmirrors.cn/docker.sh)";

  const wrapped = prepareAutoRunSnippetCommand(command, {
    host: host({ protocol: "ssh", os: "linux", distro: "centos" }),
    noAutoRun: false,
  });

  assert.match(wrapped, /^sh -c 'printf %s "\$1" \| base64 -d > \/tmp\/\.netcatty-cmd-/);
  assert.match(wrapped, /sh -c 'stty -g > \/tmp\/\.netcatty-stty-/);
  assert.match(wrapped, /trap "sh -c 'xargs stty < \/tmp\/\.netcatty-stty-/);
  assert.match(wrapped, /source \/tmp\/\.netcatty-cmd-/);
  assert.match(wrapped, /\. \/tmp\/\.netcatty-cmd-/);
  assert.match(wrapped, /set __netcatty_status/);
  assert.match(wrapped, /__netcatty_status=\\\$\?/);
  assert.match(wrapped, /\/tmp\/\.netcatty-status-/);
  assert.match(wrapped, /trap - INT TERM EXIT/);
  assert.doesNotMatch(wrapped, /\$[{]SHELL:-sh[}]/);
});

test("auto-run snippets with unknown remote shell preserve failure status", () => {
  const wrapped = prepareAutoRunSnippetCommand("sh -c 'exit 42'", {
    host: host({ protocol: "ssh", os: "linux", distro: "centos" }),
    noAutoRun: false,
  });

  const result = spawnSync("bash", ["-lc", wrapped], { encoding: "utf8" });
  assert.equal(result.status, 42);
});

test("auto-run snippets keep multi-line commands as terminal input", () => {
  const command = "echo one\necho two";

  assert.equal(prepareAutoRunSnippetCommand(command, {
    host: host({ protocol: "ssh", os: "linux", distro: "centos" }),
    noAutoRun: false,
  }), command);

  assert.equal(prepareAutoRunSnippetCommand(command, {
    host: host({ protocol: "ssh", os: "linux", distro: "centos" }),
    noAutoRun: false,
    shellType: "posix",
  }), command);
});

test("snippet terminal mode restore is skipped for paste-only and non-shell targets", () => {
  const command = "show version";

  assert.equal(
    prepareAutoRunSnippetCommand(command, {
      host: host({ protocol: "ssh", os: "linux", distro: "centos" }),
      noAutoRun: true,
    }),
    command,
  );

  assert.equal(
    prepareAutoRunSnippetCommand(command, {
      host: host({ protocol: "ssh", deviceType: "network", distro: "cisco" }),
      noAutoRun: false,
    }),
    command,
  );

  assert.equal(
    prepareAutoRunSnippetCommand(command, {
      host: host({ protocol: "serial" }),
      noAutoRun: false,
    }),
    command,
  );

  assert.equal(
    prepareAutoRunSnippetCommand(command, {
      host: host({ protocol: "ssh", os: "linux", distro: undefined }),
      noAutoRun: false,
    }),
    command,
  );

  assert.equal(
    prepareAutoRunSnippetCommand(command, {
      host: host({ protocol: "ssh", os: "linux", distro: "centos" }),
      noAutoRun: false,
      shellType: "fish",
    }),
    command,
  );

  assert.equal(
    prepareAutoRunSnippetCommand(command, {
      host: host({ protocol: "ssh", os: "linux", distro: "centos" }),
      noAutoRun: false,
      shellType: "unknown",
    }),
    command,
  );
});

test("protected snippet broadcast is prepared per target host", () => {
  const command = "bash <(curl -sSL https://linuxmirrors.cn/docker.sh)";
  const fallbackData = `${command}\r`;

  const linuxData = prepareProtectedBroadcastSnippetData({
    rawCommand: command,
    fallbackData,
    host: host({ protocol: "ssh", os: "linux", distro: "rocky" }),
    noAutoRun: false,
    shellType: "posix",
  });
  assert.match(linuxData, /__netcatty_stty_state=/);
  assert.match(linuxData, /stty "\$__netcatty_stty_state"/);
  assert.equal(linuxData.endsWith("\r"), true);

  const fishData = prepareProtectedBroadcastSnippetData({
    rawCommand: command,
    fallbackData,
    host: host({ protocol: "ssh", os: "linux", distro: "rocky" }),
    noAutoRun: false,
    shellType: "fish",
  });
  assert.equal(fishData, fallbackData);

  const networkDeviceData = prepareProtectedBroadcastSnippetData({
    rawCommand: command,
    fallbackData,
    host: host({ protocol: "ssh", deviceType: "network", distro: "cisco" }),
    noAutoRun: false,
  });
  assert.equal(networkDeviceData, fallbackData);
});
