const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

class FakePty {
  constructor() {
    this.pid = 4242;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.paused = false;
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  write() {}

  resize() {}

  kill() {}

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  emitData(data) {
    for (const handler of this.dataHandlers) handler(data);
  }
}

function loadBridgeWithFakes(spawns, sentries) {
  const bridgePath = require.resolve("./terminalBridge.cjs");
  delete require.cache[bridgePath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "node-pty") {
      return {
        spawn() {
          const pty = new FakePty();
          spawns.push(pty);
          return pty;
        },
      };
    }

    if (request === "serialport") {
      return { SerialPort: class { static async list() { return []; } } };
    }

    if (request === "./nodePtySpawnHelperPermissions.cjs") {
      return { ensureNodePtySpawnHelperExecutable() {} };
    }

    if (request === "./zmodemHelper.cjs") {
      return {
        createZmodemSentry(options) {
          const sentry = {
            active: false,
            consumeCalls: [],
            consume(data) {
              this.consumeCalls.push(data);
              const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
              options.onData(raw);
            },
            isActive() {
              return this.active;
            },
            cancel() {},
          };
          sentries.push(sentry);
          return sentry;
        },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("./terminalBridge.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

test("local terminal buffers incoming flood while renderer flow is paused", () => {
  const spawns = [];
  const sentries = [];
  const sent = [];
  const sessions = new Map();
  const bridge = loadBridgeWithFakes(spawns, sentries);

  bridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId() {
          return { send: (channel, payload) => sent.push({ channel, payload }) };
        },
      },
    },
  });

  bridge.startLocalSession(
    { sender: { id: 7 } },
    { sessionId: "local-flood", shell: "/bin/sh", cols: 80, rows: 24 },
  );

  bridge.setSessionFlowPaused(
    { sender: {} },
    { sessionId: "local-flood", paused: true },
  );
  spawns[0].emitData(Buffer.from("ordinary flood"));

  assert.equal(sentries[0].consumeCalls.length, 1);
  assert.deepEqual(sent, []);
  bridge.setSessionFlowPaused(
    { sender: {} },
    { sessionId: "local-flood", paused: false },
  );
  assert.deepEqual(sent.map((item) => item.payload.data), ["ordinary flood"]);

  sentries[0].active = true;
  spawns[0].emitData(Buffer.from("transfer bytes"));

  assert.equal(sentries[0].consumeCalls.length, 2);
});

test("closing a local terminal discards buffered output instead of flushing it", () => {
  const spawns = [];
  const sentries = [];
  const sent = [];
  const sessions = new Map();
  const bridge = loadBridgeWithFakes(spawns, sentries);

  bridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId() {
          return { send: (channel, payload) => sent.push({ channel, payload }) };
        },
      },
    },
  });

  bridge.startLocalSession(
    { sender: { id: 7 } },
    { sessionId: "local-flood-close", shell: "/bin/sh", cols: 80, rows: 24 },
  );

  spawns[0].emitData(Buffer.from("pending tail"));
  bridge.closeSession({ sender: {} }, { sessionId: "local-flood-close" });

  assert.deepEqual(sent, []);
});
