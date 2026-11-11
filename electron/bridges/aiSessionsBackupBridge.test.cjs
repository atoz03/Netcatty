const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bridge = require("./aiSessionsBackupBridge.cjs");
const session = { id: "s1", title: "Session", agentId: "agent", scope: { type: "global" }, messages: [], updatedAt: 1 };

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ai-backup-"));
}

test("writeGeneration writes atomically and rotates generations to the cap", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const { MAX_GENERATIONS } = bridge.__internals;
    for (let i = 0; i < MAX_GENERATIONS + 2; i++) {
      const result = await bridge.__internals.writeGeneration(JSON.stringify({ gen: i }));
      assert.equal(result.ok, true);
      // Small delay so timestamped names strictly increase.
      const stamp = bridge.__internals.timestampToken();
      while (bridge.__internals.timestampToken() === stamp) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    const generations = bridge.__internals.listGenerationFiles(dir);
    assert.equal(generations.length, MAX_GENERATIONS);
    // Newest generation wins the lexicographic sort.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, generations[0]), "utf-8")), {
      gen: MAX_GENERATIONS + 1,
    });
    // No temp files left behind by the atomic write.
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration skips corrupt generations and reads the newest parseable one", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    fs.writeFileSync(path.join(dir, "ai-sessions-20260101T000000-000Z.json"), "not json");
    fs.writeFileSync(
      path.join(dir, "ai-sessions-20260102T000000-000Z.json"),
      JSON.stringify([session]),
    );
    const latest = bridge.__internals.readLatestGeneration();
    assert.equal(latest.ok, true);
    assert.deepEqual(JSON.parse(latest.json), [session]);
    // A corrupt-only directory reports failure instead of throwing.
    const corruptOnly = makeTempDir();
    bridge.__internals._setBackupDir(corruptOnly);
    try {
      fs.writeFileSync(path.join(corruptOnly, "ai-sessions-20260103T000000-000Z.json"), "{oops");
      assert.equal(bridge.__internals.readLatestGeneration().ok, false);
    } finally {
      bridge.__internals._setBackupDir(dir);
      fs.rmSync(corruptOnly, { recursive: true, force: true });
    }
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration skips non-array generations", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const olderFile = "ai-sessions-20260101T000000-000Z.json";
    const sessions = [session];
    fs.writeFileSync(path.join(dir, olderFile), JSON.stringify(sessions));
    fs.writeFileSync(path.join(dir, "ai-sessions-20260102T000000-000Z.json"), JSON.stringify({ sessions }));

    const latest = bridge.__internals.readLatestGeneration();
    assert.equal(latest.ok, true);
    assert.equal(latest.file, olderFile);
    assert.deepEqual(JSON.parse(latest.json), sessions);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration skips arrays without usable sessions", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const olderFile = "ai-sessions-20260101T000000-000Z.json";
    fs.writeFileSync(path.join(dir, olderFile), JSON.stringify([session]));
    fs.writeFileSync(path.join(dir, "ai-sessions-20260102T000000-000Z.json"), JSON.stringify([{ id: "bad" }]));

    const latest = bridge.__internals.readLatestGeneration();
    assert.equal(latest.ok, true);
    assert.equal(latest.file, olderFile);
    assert.deepEqual(JSON.parse(latest.json), [session]);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration treats an empty generation as an authoritative wipe", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const newestFile = "ai-sessions-20260102T000000-000Z.json";
    fs.writeFileSync(path.join(dir, "ai-sessions-20260101T000000-000Z.json"), JSON.stringify([session]));
    fs.writeFileSync(path.join(dir, newestFile), "[]");

    const latest = bridge.__internals.readLatestGeneration();
    assert.equal(latest.ok, true);
    assert.equal(latest.file, newestFile);
    assert.deepEqual(JSON.parse(latest.json), []);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readLatestGeneration skips sessions with malformed messages", () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const olderFile = "ai-sessions-20260101T000000-000Z.json";
    const newestFile = "ai-sessions-20260102T000000-000Z.json";
    fs.writeFileSync(path.join(dir, olderFile), JSON.stringify([session]));
    for (const message of [null, {}, { id: "m", role: "user", content: "hello", timestamp: null }]) {
      fs.writeFileSync(path.join(dir, newestFile), JSON.stringify([{ ...session, messages: [message] }]));
      const latest = bridge.__internals.readLatestGeneration();
      assert.equal(latest.ok, true);
      assert.equal(latest.file, olderFile);
      assert.deepEqual(JSON.parse(latest.json), [session]);
    }
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeGeneration rejects invalid or oversized payloads", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    assert.equal((await bridge.__internals.writeGeneration("")).ok, false);
    assert.equal((await bridge.__internals.writeGeneration(null)).ok, false);
    const oversized = "x".repeat(bridge.__internals.MAX_BACKUP_JSON_BYTES + 1);
    assert.equal((await bridge.__internals.writeGeneration(oversized)).ok, false);
    assert.deepEqual(bridge.__internals.listGenerationFiles(dir), []);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export falls back to a fixed path when no dialog is available", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const result = await bridge.__internals.writeExportFixed(dir, JSON.stringify([{ id: "s1" }]));
    assert.equal(result.success, true);
    assert.ok(path.basename(result.filePath).startsWith("export-"));
    assert.equal(fs.existsSync(result.filePath), true);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeGeneration serializes concurrent writes without leaving temp files", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const results = await Promise.all([
      bridge.__internals.writeGeneration(JSON.stringify({ gen: "a" })),
      bridge.__internals.writeGeneration(""),
      bridge.__internals.writeGeneration(JSON.stringify({ gen: "b" })),
    ]);
    assert.deepEqual(results.map((result) => result.ok), [true, false, true]);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
    const newest = bridge.__internals.listGenerationFiles(dir)[0];
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, newest), "utf-8")), { gen: "b" });
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 分块写入（大型主机归档超过单条 IPC 64 MB 上限） ──

test("chunked generation larger than the single-payload cap is written atomically and restorable", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const { MAX_BACKUP_JSON_BYTES } = bridge.__internals;
    // 每块约 4 MiB，总量超过 64 MiB：旧的单次写入会以 payload-too-large 拒绝。
    const content = "x".repeat(4 * 1024 * 1024);
    const sessions = Array.from({ length: 17 }, (_, index) => ({
      ...session,
      id: `s${index}`,
      messages: [{ id: `m${index}`, role: "user", content, timestamp: index }],
    }));
    const parts = sessions.map((entry, index) => (index === 0 ? "[" : ",") + JSON.stringify(entry));
    parts[parts.length - 1] += "]";
    const total = parts.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
    assert.ok(total > MAX_BACKUP_JSON_BYTES);

    const id = "gen-large";
    // 与渲染进程一致：不等待中间结果，按顺序连续发送。
    const pending = [
      bridge.__internals.beginChunkedGeneration(id),
      ...parts.map((chunk) => bridge.__internals.appendChunkedGeneration(id, chunk)),
      bridge.__internals.commitChunkedGeneration(id),
    ];
    const results = await Promise.all(pending);
    assert.ok(results.every((result) => result.ok), JSON.stringify(results.filter((r) => !r.ok)));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);

    const latest = bridge.__internals.readLatestGeneration();
    assert.equal(latest.ok, true);
    assert.equal(latest.file, results.at(-1).file);
    const restored = JSON.parse(latest.json);
    assert.deepEqual(restored.map((entry) => entry.id), sessions.map((entry) => entry.id));
    assert.equal(restored[16].messages[0].content.length, content.length);
    // 分块代以 gzip 保存，磁盘占用远小于未压缩的 JSON。
    assert.ok(latest.file.endsWith(bridge.__internals.GZIP_SUFFIX));
    assert.ok(fs.statSync(path.join(dir, latest.file)).size < total / 10);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chunked generation rotates with single-payload generations to the shared cap", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const { MAX_GENERATIONS } = bridge.__internals;
    for (let i = 0; i < MAX_GENERATIONS + 2; i++) {
      const id = `rot-${i}`;
      const results = await Promise.all([
        bridge.__internals.beginChunkedGeneration(id, Date.UTC(2026, 0, 1, 0, 0, i)),
        bridge.__internals.appendChunkedGeneration(id, "[{\"gen\":"),
        bridge.__internals.appendChunkedGeneration(id, `${i}}]`),
        bridge.__internals.commitChunkedGeneration(id),
      ]);
      assert.ok(results.every((result) => result.ok));
    }
    const generations = bridge.__internals.listGenerationFiles(dir);
    assert.equal(generations.length, MAX_GENERATIONS);
    assert.ok(generations.every((file) => file.endsWith(bridge.__internals.GZIP_SUFFIX)));
    assert.deepEqual(
      JSON.parse(bridge.__internals.readGenerationJson(path.join(dir, generations[0]))),
      [{ gen: MAX_GENERATIONS + 1 }],
    );
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed or aborted chunked generation leaves older generations and no temp files", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const good = await bridge.__internals.writeGeneration(JSON.stringify([session]));
    assert.equal(good.ok, true);

    // 单块超过 64 MB 上限：本代失败，提交时删除临时文件。
    const oversized = "x".repeat(bridge.__internals.MAX_BACKUP_JSON_BYTES + 1);
    const failed = await Promise.all([
      bridge.__internals.beginChunkedGeneration("too-big"),
      bridge.__internals.appendChunkedGeneration("too-big", "["),
      bridge.__internals.appendChunkedGeneration("too-big", oversized),
      bridge.__internals.appendChunkedGeneration("too-big", "]"),
      bridge.__internals.commitChunkedGeneration("too-big"),
    ]);
    assert.deepEqual(failed.map((result) => result.ok), [true, true, false, false, false]);
    assert.equal(failed.at(-1).error, "payload-too-large");

    // 显式中止。
    await bridge.__internals.beginChunkedGeneration("aborted");
    await bridge.__internals.appendChunkedGeneration("aborted", "[");
    assert.equal((await bridge.__internals.abortChunkedGeneration("aborted")).ok, true);
    assert.equal((await bridge.__internals.commitChunkedGeneration("aborted")).ok, false);

    // 非法 id / 未开始的代 / 空代。
    assert.equal((await bridge.__internals.beginChunkedGeneration("../escape")).ok, false);
    assert.equal((await bridge.__internals.appendChunkedGeneration("never-began", "[]")).ok, false);
    await bridge.__internals.beginChunkedGeneration("empty");
    assert.equal((await bridge.__internals.commitChunkedGeneration("empty")).ok, false);

    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
    assert.deepEqual(bridge.__internals.listGenerationFiles(dir), [good.file]);
    assert.equal(bridge.__internals.readLatestGeneration().file, good.file);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an abandoned chunked generation is cleaned up once stale", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    const startedAt = Date.UTC(2026, 0, 1);
    await bridge.__internals.beginChunkedGeneration("abandoned", startedAt);
    await bridge.__internals.appendChunkedGeneration("abandoned", "[");
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 1);
    const later = startedAt + bridge.__internals.STALE_CHUNKED_GENERATION_MS + 1;
    await bridge.__internals.beginChunkedGeneration("next", later);
    await bridge.__internals.abortChunkedGeneration("next");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
    assert.equal((await bridge.__internals.commitChunkedGeneration("abandoned")).ok, false);
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gzip and plain generations rotate and restore together, newest first", async () => {
  const dir = makeTempDir();
  bridge.__internals._setBackupDir(dir);
  try {
    // 升级前写下的明文代仍可读取；更新的压缩代优先。
    fs.writeFileSync(path.join(dir, "ai-sessions-20260101T000000-000Z.json"), JSON.stringify([{ ...session, id: "plain" }]));
    const id = "mixed";
    await Promise.all([
      bridge.__internals.beginChunkedGeneration(id, Date.UTC(2026, 0, 2)),
      bridge.__internals.appendChunkedGeneration(id, JSON.stringify([{ ...session, id: "compressed" }])),
      bridge.__internals.commitChunkedGeneration(id),
    ]);
    assert.equal(JSON.parse(bridge.__internals.readLatestGeneration().json)[0].id, "compressed");
    // 损坏的压缩代被跳过，回退到更早的明文代。
    const [newest] = bridge.__internals.listGenerationFiles(dir);
    fs.writeFileSync(path.join(dir, newest), "not gzip");
    assert.equal(JSON.parse(bridge.__internals.readLatestGeneration().json)[0].id, "plain");
  } finally {
    bridge.__internals._setBackupDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
