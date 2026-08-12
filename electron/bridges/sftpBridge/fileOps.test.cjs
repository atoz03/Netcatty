const assert = require("node:assert/strict");
const test = require("node:test");

const { createFileOpsApi } = require("./fileOps.cjs");

test("home discovery accepts a virtual SFTP root when SSH exec is unavailable", async () => {
  const channel = {};
  const listed = [];
  const api = createFileOpsApi({
    sftpClients: new Map([["jumpserver", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    realpathAsync: async (resolvedChannel, remotePath) => {
      assert.equal(resolvedChannel, channel);
      assert.equal(remotePath, ".");
      return "/";
    },
    readdirAsync: async (resolvedChannel, remotePath) => {
      listed.push([resolvedChannel, remotePath]);
      return [{ filename: "data" }];
    },
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "jumpserver" });

  assert.deepEqual(result, { success: true, homeDir: "/" });
  assert.deepEqual(listed, [[channel, "/"]]);
});

test("home discovery rejects non-listable root so candidate probing can run", async () => {
  const channel = {};
  const api = createFileOpsApi({
    sftpClients: new Map([["restricted", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    realpathAsync: async () => "/",
    readdirAsync: async () => {
      const error = new Error("Permission denied");
      error.code = "EACCES";
      throw error;
    },
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "restricted" });

  assert.equal(result.success, false);
  assert.match(result.error || "", /Could not determine home directory/);
});

test("home discovery still accepts non-root realpath without listing", async () => {
  const channel = {};
  let readdirCalls = 0;
  const api = createFileOpsApi({
    sftpClients: new Map([["normal", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    realpathAsync: async () => "/home/deploy",
    readdirAsync: async () => {
      readdirCalls += 1;
      return [];
    },
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "normal" });

  assert.deepEqual(result, { success: true, homeDir: "/home/deploy" });
  assert.equal(readdirCalls, 0);
});
