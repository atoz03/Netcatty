"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const { Duplex } = require("node:stream");
const Module = require("node:module");

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

function createSender() {
  return {
    id: 1,
    isDestroyed: () => false,
    send() {},
  };
}

function loadBridgeWithMocks(t, options = {}) {
  const originalLoad = Module._load;
  let capturedChainOptions = null;
  let connectCount = 0;
  let forwardInCount = 0;
  const execCommands = [];
  let forwardInFailures = options.forwardInFailures || 0;

  class MockSshClient extends EventEmitter {
    connect(options) {
      connectCount++;
      this.options = options;
      setImmediate(() => this.emit("ready"));
    }

    forwardOut(_srcIP, _srcPort, _dstHost, _dstPort, callback) {
      callback(null, new Duplex({
        read() {},
        write(_chunk, _encoding, done) {
          done();
        },
      }));
    }

    forwardIn(_bindAddress, _localPort, callback) {
      forwardInCount++;
      if (forwardInFailures > 0) {
        forwardInFailures--;
        callback(new Error(options.forwardInErrorMessage || "Unable to bind to remote port"));
        return;
      }
      callback(null);
    }

    exec(command, callback) {
      execCommands.push(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => stream.emit("close", 0);
      callback(null, stream);
      setImmediate(() => {
        if (options.remoteExecOutput) {
          stream.emit("data", Buffer.from(options.remoteExecOutput));
        }
        stream.emit("close", 0);
      });
    }

    end() {
      this.emit("close");
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2") {
      return {
        Client: MockSshClient,
        utils: {
          parseKey: () => null,
        },
      };
    }
    if (request === "./sshBridge.cjs") {
      return {
        buildAlgorithms: () => ({}),
        connectThroughChain: async (_event, options) => {
          capturedChainOptions = options;
          return {
            socket: new Duplex({
              read() {},
              write(_chunk, _encoding, done) {
                done();
              },
            }),
            connections: [],
          };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const bridgePath = require.resolve("./portForwardingBridge.cjs");
  delete require.cache[bridgePath];
  const bridge = require("./portForwardingBridge.cjs");

  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[bridgePath];
  });

  return {
    bridge,
    getCapturedChainOptions: () => capturedChainOptions,
    getConnectCount: () => connectCount,
    getForwardInCount: () => forwardInCount,
    getExecCommands: () => execCommands,
  };
}

test("port forwarding routes jump-host keyboard-interactive prompts through the external scope", async (t) => {
  const { bridge, getCapturedChainOptions } = loadBridgeWithMocks(t);
  const event = { sender: createSender() };

  try {
    const knownHosts = [{
      id: "kh-jump",
      hostname: "jump.internal",
      port: 22,
      keyType: "ssh-ed25519",
      fingerprint: "trusted-jump-fingerprint",
    }];
    const result = await bridge.startPortForward(event, {
      tunnelId: "pf-jump-scope",
      type: "local",
      localPort: 0,
      bindAddress: "127.0.0.1",
      remoteHost: "127.0.0.1",
      remotePort: 3306,
      hostname: "db.internal",
      port: 22,
      username: "dbuser",
      password: "target-password",
      knownHosts,
      jumpHosts: [{
        hostname: "jump.internal",
        port: 22,
        username: "jumpuser",
        password: "jump-password",
      }],
    });

    assert.equal(result.success, true);
    assert.equal(getCapturedChainOptions()?._keyboardInteractiveScope, "external");
    assert.equal(getCapturedChainOptions()?.knownHosts, knownHosts);
  } finally {
    await bridge.stopPortForward(event, { tunnelId: "pf-jump-scope" });
  }
});

test("port forwarding restarts the same rule on the same local port without a bind race", async (t) => {
  const { bridge } = loadBridgeWithMocks(t);
  const event = { sender: createSender() };
  const localPort = await getFreePort();
  const basePayload = {
    ruleId: "rule-restart",
    type: "local",
    localPort,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 3306,
    hostname: "db.internal",
    port: 22,
    username: "dbuser",
    password: "target-password",
  };

  try {
    const first = await bridge.startPortForward(event, {
      ...basePayload,
      tunnelId: "pf-rule-restart-1",
    });
    assert.equal(first.success, true);

    const second = await bridge.startPortForward(event, {
      ...basePayload,
      tunnelId: "pf-rule-restart-2",
    });
    assert.equal(second.success, true);

    assert.deepEqual(await bridge.getPortForwardStatus(event, { tunnelId: "pf-rule-restart-1" }), {
      tunnelId: "pf-rule-restart-1",
      status: "inactive",
    });
    assert.deepEqual(await bridge.getPortForwardStatus(event, { tunnelId: "pf-rule-restart-2" }), {
      tunnelId: "pf-rule-restart-2",
      status: "active",
      type: "local",
    });
  } finally {
    await bridge.stopPortForward(event, { tunnelId: "pf-rule-restart-1" });
    await bridge.stopPortForward(event, { tunnelId: "pf-rule-restart-2" });
  }
});

test("port forwarding serializes wildcard and loopback binds on the same local port", async (t) => {
  const { bridge } = loadBridgeWithMocks(t);
  const event = { sender: createSender() };
  const localPort = await getFreePort();
  const basePayload = {
    ruleId: "rule-rebind-address",
    type: "local",
    localPort,
    remoteHost: "127.0.0.1",
    remotePort: 3306,
    hostname: "db.internal",
    port: 22,
    username: "dbuser",
    password: "target-password",
  };

  try {
    const first = await bridge.startPortForward(event, {
      ...basePayload,
      tunnelId: "pf-rule-rebind-address-1",
      bindAddress: "0.0.0.0",
    });
    assert.equal(first.success, true);

    const second = await bridge.startPortForward(event, {
      ...basePayload,
      tunnelId: "pf-rule-rebind-address-2",
      bindAddress: "127.0.0.1",
    });
    assert.equal(second.success, true);

    assert.deepEqual(await bridge.getPortForwardStatus(event, { tunnelId: "pf-rule-rebind-address-1" }), {
      tunnelId: "pf-rule-rebind-address-1",
      status: "inactive",
    });
    assert.deepEqual(await bridge.getPortForwardStatus(event, { tunnelId: "pf-rule-rebind-address-2" }), {
      tunnelId: "pf-rule-rebind-address-2",
      status: "active",
      type: "local",
    });
  } finally {
    await bridge.stopPortForward(event, { tunnelId: "pf-rule-rebind-address-1" });
    await bridge.stopPortForward(event, { tunnelId: "pf-rule-rebind-address-2" });
  }
});

test("port forwarding reports an external listener on the requested local port", async (t) => {
  const { bridge, getConnectCount } = loadBridgeWithMocks(t);
  const event = { sender: createSender() };
  const externalServer = net.createServer();
  await new Promise((resolve, reject) => {
    externalServer.once("error", reject);
    externalServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    externalServer.close();
  });
  const { port: localPort } = externalServer.address();

  const result = await bridge.startPortForward(event, {
    ruleId: "rule-external-listener",
    tunnelId: "pf-rule-external-listener-1",
    type: "local",
    localPort,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 3306,
    hostname: "db.internal",
    port: 22,
    username: "dbuser",
    password: "target-password",
  }).then(
    () => ({ success: true, error: null }),
    (error) => ({ success: false, error }),
  );

  assert.equal(result.success, false);
  assert.equal(result.error.code, "EADDRINUSE");
  assert.equal(getConnectCount(), 1);
});

test("port forwarding does not replace another rule that already owns the local port", async (t) => {
  const { bridge, getConnectCount } = loadBridgeWithMocks(t);
  const event = { sender: createSender() };
  const localPort = await getFreePort();
  const basePayload = {
    type: "local",
    localPort,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 3306,
    hostname: "db.internal",
    port: 22,
    username: "dbuser",
    password: "target-password",
  };

  try {
    const first = await bridge.startPortForward(event, {
      ...basePayload,
      ruleId: "rule-owner",
      tunnelId: "pf-rule-owner-1",
    });
    assert.equal(first.success, true);

    const second = await bridge.startPortForward(event, {
      ...basePayload,
      ruleId: "rule-contender",
      tunnelId: "pf-rule-contender-1",
    }).then(
      () => ({ success: true, error: null }),
      (error) => ({ success: false, error }),
    );

    assert.equal(second.success, false);
    assert.equal(second.error.code, "EADDRINUSE");
    assert.equal(getConnectCount(), 2);
    assert.deepEqual(await bridge.getPortForwardStatus(event, { tunnelId: "pf-rule-owner-1" }), {
      tunnelId: "pf-rule-owner-1",
      status: "active",
      type: "local",
    });
  } finally {
    await bridge.stopPortForward(event, { tunnelId: "pf-rule-owner-1" });
    await bridge.stopPortForward(event, { tunnelId: "pf-rule-contender-1" });
  }
});

test("remote forwarding can release a stale sshd listener before retrying", async (t) => {
  const { bridge, getForwardInCount, getExecCommands } = loadBridgeWithMocks(t, {
    forwardInFailures: 1,
    remoteExecOutput: [
      "stale\t1234\tsshd\tsshd: user@notty",
      "killed\t1234\tsshd\tsshd: user@notty",
      "",
    ].join("\n"),
  });
  const event = { sender: createSender() };

  try {
    const result = await bridge.startPortForward(event, {
      ruleId: "rule-remote-release",
      tunnelId: "pf-rule-remote-release-1",
      type: "remote",
      localPort: 17900,
      bindAddress: "127.0.0.1",
      remoteHost: "127.0.0.1",
      remotePort: 3306,
      hostname: "db.internal",
      port: 22,
      username: "dbuser",
      password: "target-password",
      releaseStaleRemoteSshd: true,
    });

    assert.equal(result.success, true);
    assert.equal(getForwardInCount(), 2);
    assert.equal(getExecCommands().length, 1);
    assert.match(getExecCommands()[0], /17900/);
    assert.match(getExecCommands()[0], /BIND_ADDRESS=.*127\.0\.0\.1/);
  } finally {
    await bridge.stopPortForward(event, { tunnelId: "pf-rule-remote-release-1" });
  }
});

test("remote forwarding does not release stale sshd for non-bind failures", async (t) => {
  const { bridge, getForwardInCount, getExecCommands } = loadBridgeWithMocks(t, {
    forwardInFailures: 1,
    forwardInErrorMessage: "Remote port forwarding is administratively prohibited",
    remoteExecOutput: "killed\t1234\tsshd\tsshd: user@notty\n",
  });
  const event = { sender: createSender() };

  const result = await bridge.startPortForward(event, {
    ruleId: "rule-remote-policy-denied",
    tunnelId: "pf-rule-remote-policy-denied-1",
    type: "remote",
    localPort: 17900,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 3306,
    hostname: "db.internal",
    port: 22,
    username: "dbuser",
    password: "target-password",
    releaseStaleRemoteSshd: true,
  }).then(
    () => ({ success: true, error: null }),
    (error) => ({ success: false, error }),
  );

  assert.equal(result.success, false);
  assert.equal(getForwardInCount(), 1);
  assert.equal(getExecCommands().length, 0);
});

test("remote forwarding does not kill stale sshd without explicit release option", async (t) => {
  const { bridge, getForwardInCount, getExecCommands } = loadBridgeWithMocks(t, {
    forwardInFailures: 1,
    remoteExecOutput: "killed\t1234\tsshd\tsshd: user@notty\n",
  });
  const event = { sender: createSender() };

  const result = await bridge.startPortForward(event, {
    ruleId: "rule-remote-no-release",
    tunnelId: "pf-rule-remote-no-release-1",
    type: "remote",
    localPort: 17900,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 3306,
    hostname: "db.internal",
    port: 22,
    username: "dbuser",
    password: "target-password",
  }).then(
    () => ({ success: true, error: null }),
    (error) => ({ success: false, error }),
  );

  assert.equal(result.success, false);
  assert.equal(getForwardInCount(), 1);
  assert.equal(getExecCommands().length, 0);
});
