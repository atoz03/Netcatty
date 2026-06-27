const assert = require("node:assert/strict");
const test = require("node:test");

const { createPreloadApi } = require("./preload/api.cjs");
const {
  clearTerminalDataSession,
  createTerminalDataBacklog,
  createTerminalDataDispatcher,
} = require("./preload/terminalDataBacklog.cjs");

test("stores early terminal data until the listener is registered", () => {
  const backlog = createTerminalDataBacklog();

  backlog.append("session-1", "Linux banner\r\n");
  backlog.append("session-1", "root@host:~# ");

  assert.equal(backlog.take("session-1"), "Linux banner\r\nroot@host:~# ");
  assert.equal(backlog.take("session-1"), "");
});

test("keeps each session backlog isolated", () => {
  const backlog = createTerminalDataBacklog();

  backlog.append("session-1", "one");
  backlog.append("session-2", "two");

  assert.equal(backlog.take("session-2"), "two");
  assert.equal(backlog.take("session-1"), "one");
});

test("trims old data when the per-session limit is exceeded", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 5 });

  backlog.append("session-1", "hello");
  backlog.append("session-1", " world");

  assert.equal(backlog.take("session-1"), "world");
});

test("clear drops pending data for a closed session", () => {
  const backlog = createTerminalDataBacklog();

  backlog.append("session-1", "pending");
  backlog.clear("session-1");

  assert.equal(backlog.size("session-1"), 0);
  assert.equal(backlog.take("session-1"), "");
});

test("onSessionData flushes pending terminal data on subscribe", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "early MOTD\r\n");

  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  const received = [];
  const unsubscribe = api.onSessionData("session-1", (chunk) => {
    received.push(chunk);
  }, { replayBacklog: true });

  assert.deepEqual(received, ["early MOTD\r\n"]);
  assert.equal(terminalDataBacklog.size("session-1"), 0);
  assert.equal(displayDataListeners.get("session-1").size, 1);

  unsubscribe();
  assert.equal(dataListeners.has("session-1"), false);
  assert.equal(displayDataListeners.has("session-1"), false);
});

test("non-display listeners do not drain pending terminal data", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "early prompt");

  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  const observerReceived = [];
  const displayReceived = [];

  api.onSessionData("session-1", (chunk) => {
    observerReceived.push(chunk);
  });
  assert.deepEqual(observerReceived, []);
  assert.equal(terminalDataBacklog.size("session-1"), "early prompt".length);

  api.onSessionData("session-1", (chunk) => {
    displayReceived.push(chunk);
  }, { replayBacklog: true });

  assert.deepEqual(observerReceived, []);
  assert.deepEqual(displayReceived, ["early prompt"]);
  assert.equal(terminalDataBacklog.size("session-1"), 0);
});

test("keeps early data for display replay while only observer listeners exist", () => {
  const observed = [];
  const dataListeners = new Map([
    ["session-1", new Set([(chunk) => observed.push(chunk)])],
  ]);
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const deliverToListeners = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  deliverToListeners("session-1", "Linux banner\r\n");

  assert.deepEqual(observed, ["Linux banner\r\n"]);
  assert.equal(terminalDataBacklog.take("session-1"), "Linux banner\r\n");
});

test("does not backlog data once the display listener is registered", () => {
  const observed = [];
  const displayed = [];
  const displayListener = (chunk) => displayed.push(chunk);
  const dataListeners = new Map([
    ["session-1", new Set([(chunk) => observed.push(chunk), displayListener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([displayListener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  const deliverToListeners = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  deliverToListeners("session-1", "live output");

  assert.deepEqual(observed, ["live output"]);
  assert.deepEqual(displayed, ["live output"]);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("drops terminal data for sessions marked closed", () => {
  const observed = [];
  const dataListeners = new Map([
    ["session-1", new Set([(chunk) => observed.push(chunk)])],
  ]);
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const closedSessions = new Set(["session-1"]);
  const deliverToListeners = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
    shouldDropSession: (sessionId) => closedSessions.has(sessionId),
  });

  deliverToListeners("session-1", "late output");

  assert.deepEqual(observed, []);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("clearTerminalDataSession drops listener and backlog state together", () => {
  const listener = () => {};
  const dataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "pending");

  clearTerminalDataSession({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  }, "session-1");

  assert.equal(dataListeners.has("session-1"), false);
  assert.equal(displayDataListeners.has("session-1"), false);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("closeSession clears terminal data state and marks the session closed", () => {
  const listener = () => {};
  const dataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  const closedTerminalDataSessions = new Set();
  const telnetEchoModeListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const sent = [];
  const closedPorts = [];
  terminalDataBacklog.append("session-1", "pending");

  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send(channel, payload) {
        sent.push({ channel, payload });
      },
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
    closedTerminalDataSessions,
    telnetEchoModeListeners,
    terminalOutputPorts: {
      closeSession(sessionId) {
        closedPorts.push(sessionId);
      },
    },
  });

  api.closeSession("session-1");

  assert.equal(dataListeners.has("session-1"), false);
  assert.equal(displayDataListeners.has("session-1"), false);
  assert.equal(terminalDataBacklog.take("session-1"), "");
  assert.equal(closedTerminalDataSessions.has("session-1"), true);
  assert.equal(telnetEchoModeListeners.has("session-1"), false);
  assert.deepEqual(closedPorts, ["session-1"]);
  assert.deepEqual(sent, [
    { channel: "netcatty:close", payload: { sessionId: "session-1" } },
  ]);
});

test("interruptSession uses the urgent input port before falling back to IPC", () => {
  const sent = [];
  const urgent = [];
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send(channel, payload) {
        sent.push({ channel, payload });
      },
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    terminalUrgentInputPorts: {
      postInterrupt(sessionId, trace) {
        urgent.push({ sessionId, trace });
        return true;
      },
    },
  });

  api.interruptSession("session-1", {
    traceId: "trace-1",
    rendererKeyAt: 123,
  });

  assert.deepEqual(urgent, [
    {
      sessionId: "session-1",
      trace: {
        traceId: "trace-1",
        rendererKeyAt: 123,
        rendererHasSelection: false,
        debug: false,
        rendererPriority: undefined,
        rendererSendAt: undefined,
        rendererStatus: undefined,
        sessionId: undefined,
        source: undefined,
      },
    },
  ]);
  assert.deepEqual(sent, []);
});

test("startLocalSession reopens a previously closed terminal data session", async () => {
  const closedTerminalDataSessions = new Set(["session-1"]);
  const invoked = [];
  const api = createPreloadApi({
    ipcRenderer: {
      async invoke(channel, payload) {
        invoked.push({ channel, payload, wasClosed: closedTerminalDataSessions.has("session-1") });
        return { sessionId: "session-1" };
      },
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    closedTerminalDataSessions,
    telnetEchoModeListeners: new Map(),
  });

  const sessionId = await api.startLocalSession({ sessionId: "session-1" });

  assert.equal(sessionId, "session-1");
  assert.deepEqual(invoked, [
    {
      channel: "netcatty:local:start",
      payload: { sessionId: "session-1" },
      wasClosed: false,
    },
  ]);
  assert.equal(closedTerminalDataSessions.has("session-1"), false);
});
