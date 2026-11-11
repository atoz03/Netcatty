/**
 * AI 会话持久化路径基准（`npm run bench:ai-session-persistence`）。
 *
 * 模拟一次流式回复：useAIState 每 500ms 防抖调用一次 `writeSessionsForStorage`，
 * 每次只有当前会话追加/增长一条消息。统计：
 * - 写入路径耗时（同步部分，即渲染线程被占用的时间）；
 * - 整库 JSON 序列化的次数与字节数（备份镜像的主要开销）；
 * - 实际发出的磁盘备份代数与单条 IPC 的最大字节数；
 * - IndexedDB 会话记录 put 次数（逐条写入的放大情况）。
 *
 * 使用内存版 IndexedDB 桩，不访问任何真实用户数据。数字随机器变化，仅用于
 * 同一台机器上前后对比。
 */
import { installFakeIndexedDb } from '../application/state/testSupport/fakeIndexedDb.ts';
import type { AISession } from '../infrastructure/ai/types.ts';

interface Scenario {
  name: string;
  sessions: number;
  messagesPerSession: number;
  messageBytes: number;
  hostBound: boolean;
  streamingWrites: number;
}

const SCENARIOS: Scenario[] = [
  {
    name: '主机归档：300 个会话 × 120 条消息',
    sessions: 300,
    messagesPerSession: 120,
    messageBytes: 1000,
    hostBound: true,
    streamingWrites: 40,
  },
  {
    name: '未绑定主机：100 个会话 × 300 条消息（超过默认 200 条上限）',
    sessions: 100,
    messagesPerSession: 300,
    messageBytes: 400,
    hostBound: false,
    streamingWrites: 40,
  },
];

function buildSessions(scenario: Scenario): AISession[] {
  const filler = 'x'.repeat(scenario.messageBytes);
  return Array.from({ length: scenario.sessions }, (_, index) => ({
    id: `session-${index}`,
    title: `session ${index}`,
    agentId: 'catty',
    scope: scenario.hostBound
      ? { type: 'terminal', targetId: `terminal-${index}`, hostIds: [`host-${index % 20}`] }
      : { type: 'global' },
    messages: Array.from({ length: scenario.messagesPerSession }, (_, messageIndex) => ({
      id: `m-${index}-${messageIndex}`,
      role: messageIndex % 2 ? 'assistant' : 'user',
      content: filler,
      timestamp: messageIndex,
    })),
    createdAt: 1,
    updatedAt: scenario.sessions - index,
  })) as AISession[];
}

function installMemoryLocalStorage() {
  const values = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; },
  };
}

async function run(scenario: Scenario) {
  installMemoryLocalStorage();
  const snapshots = await import('../application/state/aiStateSnapshots.ts');
  snapshots.__resetBackupMirrorForTests();
  snapshots.__resetIdbPersistenceForTests();
  const idb = installFakeIndexedDb();

  const backupPayloadBytes: number[] = [];
  let backupGenerations = 0;
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      aiSessionsBackupWrite: async (payload: { json: string }) => {
        backupGenerations += 1;
        backupPayloadBytes.push(Buffer.byteLength(payload.json));
        return { ok: true };
      },
      // 分块写入接口（存在时由新实现使用）。
      aiSessionsBackupWriteBegin: async () => ({ ok: true }),
      aiSessionsBackupWriteChunk: async (payload: { chunk: string }) => {
        const bytes = Buffer.byteLength(payload.chunk);
        backupPayloadBytes.push(bytes);
        return { ok: true };
      },
      aiSessionsBackupWriteCommit: async () => {
        backupGenerations += 1;
        return { ok: true };
      },
      aiSessionsBackupWriteAbort: async () => ({ ok: true }),
    },
  };

  let sessions = buildSessions(scenario);
  snapshots.writeSessionsForStorage(sessions);
  snapshots.flushBackupMirror();
  await snapshots.__flushIdbWritesForTests();
  const putsBefore = idb.db.opCounts.get('sessions')?.put ?? 0;
  backupGenerations = 0;
  backupPayloadBytes.length = 0;

  const originalStringify = JSON.stringify;
  let stringifyCalls = 0;
  let stringifiedChars = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const result = originalStringify(...args);
    stringifyCalls += 1;
    stringifiedChars += typeof result === 'string' ? result.length : 0;
    return result;
  }) as typeof JSON.stringify;

  let writeMs = 0;
  try {
    for (let step = 0; step < scenario.streamingWrites; step += 1) {
      const [active, ...rest] = sessions;
      const updated: AISession = {
        ...active,
        updatedAt: active.updatedAt + 1,
        messages: [
          ...active.messages,
          { id: `stream-${step}`, role: 'assistant', content: 'y'.repeat(200 + step * 20), timestamp: 10_000 + step },
        ] as AISession['messages'],
      };
      sessions = [updated, ...rest];
      const startedAt = performance.now();
      snapshots.writeSessionsForStorage(sessions);
      writeMs += performance.now() - startedAt;
    }
    const flushStartedAt = performance.now();
    snapshots.flushBackupMirror();
    const flushMs = performance.now() - flushStartedAt;
    await snapshots.__flushIdbWritesForTests();
    await new Promise(resolve => setTimeout(resolve, 0));

    const storeBytes = Buffer.byteLength(originalStringify(sessions));
    console.log(`\n## ${scenario.name}`);
    console.log(`整库 JSON 大小: ${(storeBytes / 1024 / 1024).toFixed(1)} MiB，流式写入 ${scenario.streamingWrites} 次`);
    console.log(`写入路径同步耗时合计: ${writeMs.toFixed(1)} ms（平均 ${(writeMs / scenario.streamingWrites).toFixed(2)} ms/次）`);
    console.log(`flushBackupMirror 同步耗时: ${flushMs.toFixed(1)} ms`);
    console.log(`JSON.stringify 调用 ${stringifyCalls} 次，共 ${(stringifiedChars / 1024 / 1024).toFixed(1)} Mi 字符`);
    console.log(`备份代数: ${backupGenerations}，单条 IPC 最大 ${(Math.max(0, ...backupPayloadBytes) / 1024 / 1024).toFixed(1)} MiB`);
    console.log(`IndexedDB 会话 put: ${(idb.db.opCounts.get('sessions')?.put ?? 0) - putsBefore}`);
  } finally {
    JSON.stringify = originalStringify;
    idb.restore();
    snapshots.__resetBackupMirrorForTests();
    snapshots.__resetIdbPersistenceForTests();
  }
}

for (const scenario of SCENARIOS) {
  await run(scenario);
}
