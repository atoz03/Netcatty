"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createExecOnSessionApi } = require("./execOnSession.cjs");

test("execOnSession closes ssh exec stdin after writing provided input", async () => {
  const writes = [];
  let ended = false;
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = (data) => {
    writes.push(data);
    return true;
  };
  stream.end = () => {
    ended = true;
  };

  const conn = {
    exec(_command, callback) {
      callback(null, stream);
      process.nextTick(() => stream.emit("close", 0));
    },
  };
  const execApi = createExecOnSessionApi({
    sessions: { get: () => ({ conn, type: "ssh" }) },
  });

  const result = await execApi.execOnSession(null, "s1", "sudo -S -p '' docker ps", 1000, {
    stdin: "secret\n",
  });

  assert.equal(result.success, true);
  assert.deepEqual(writes, ["secret\n"]);
  assert.equal(ended, true);
});

test("execOnSession reports local maxBuffer errors instead of returning truncated stdout", async () => {
  const execApi = createExecOnSessionApi({
    sessions: { get: () => ({ type: "local", protocol: "local" }) },
    process,
  });

  const result = await execApi.execOnSession(null, "local", "yes x | head -c 2048", 1000, {
    maxBuffer: 128,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /maxBuffer|stdout maxBuffer/i);
});

test("execOnSession enforces maxBuffer for SSH streamed stdout", async () => {
  let closed = false;
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => {
    closed = true;
  };

  const conn = {
    exec(_command, callback) {
      callback(null, stream);
      process.nextTick(() => {
        stream.emit("data", Buffer.from("x".repeat(256)));
        stream.emit("close", 0);
      });
    },
  };
  const execApi = createExecOnSessionApi({
    sessions: { get: () => ({ conn, type: "ssh" }) },
  });

  const result = await execApi.execOnSession(null, "s1", "ps", 1000, {
    maxBuffer: 128,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /maxBuffer/i);
  assert.equal(result.stdout, "");
  assert.equal(closed, true);
});
