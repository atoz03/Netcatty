# Copy Multi-Pane (Workspace) Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user copy a multi-pane workspace tab (split or focus view) so the new tab reproduces the source layout tree, with each pane a fresh session inheriting its source pane's working directory.

**Architecture:** A pure domain helper (`cloneWorkspaceTree`) deep-clones the layout tree remapping session ids. A pure exported helper (`buildCopiedWorkspace`) assembles the cloned sessions + new workspace. A `useSessionState` action (`copyWorkspace`) wires it into state (StrictMode-safe id pre-minting, tabOrder, active tab). An async App handler (`copyWorkspaceWithCurrentShellImpl`) captures per-pane cwd (reusing `captureCtxInheritedCwd`) before calling it. UI adds "Copy Tab" + double-click to the workspace tab, mirroring session tabs.

**Tech Stack:** TypeScript, React (hooks), Node test runner via `tsx`. Renderer is ESM. Tests: `node --test --import tsx <file>`.

**Base branch:** `feat/copy-workspace-split-tab` (already created off `feat/clone-tab-split-cwd-local-icon`, spec committed).

---

## File Structure

- `domain/workspace.ts` — add `cloneWorkspaceTree` (pure tree clone + session-id remap). Test: `domain/workspace.test.ts`.
- `application/state/useSessionState.ts` — add exported pure `buildCopiedWorkspace` + the `copyWorkspace` action (returned from the hook). Test: `application/state/copyWorkspace.test.ts` (new).
- `application/app/AppHandlers.ts` — add `copyWorkspaceWithCurrentShellImpl`. Test: `application/app/AppHandlers.test.ts`.
- `App.tsx` — destructure `copyWorkspace` from `useSessionState`; add `copyWorkspaceWithCurrentShell` callback; expose it in the `AppView` ctx.
- `application/app/AppView.tsx` — thread `onCopyWorkspace` into `TopTabs`.
- `components/TopTabs.tsx` — add `onCopyWorkspace` to props, memo comparison, and pass to `WorkspaceTopTab`.
- `components/top-tabs/TopTabItems.tsx` — `WorkspaceTopTab`: add `onCopyWorkspace` prop, double-click handler, and a "Copy Tab" context-menu item.

No new i18n key — reuse existing `tabs.copyTab` (`application/i18n/locales/en/terminal.ts:612`).

---

## Task 1: `cloneWorkspaceTree` domain helper

**Files:**
- Modify: `domain/workspace.ts`
- Test: `domain/workspace.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `domain/workspace.test.ts` (it already imports `WorkspaceNode` and has a nested `root`; add `cloneWorkspaceTree` to the existing import from `./workspace.ts`):

```ts
import { cloneWorkspaceTree } from "./workspace.ts";

const nestedRoot: WorkspaceNode = {
  id: "split-root",
  type: "split",
  direction: "vertical",
  sizes: [0.8, 0.2],
  children: [
    { id: "pane-a", type: "pane", sessionId: "s1" },
    {
      id: "split-inner",
      type: "split",
      direction: "horizontal",
      sizes: [0.5, 0.5],
      children: [
        { id: "pane-b", type: "pane", sessionId: "s2" },
        { id: "pane-c", type: "pane", sessionId: "s3" },
      ],
    },
  ],
};

test("cloneWorkspaceTree remaps every sessionId and preserves direction/sizes", () => {
  const map = new Map([["s1", "n1"], ["s2", "n2"], ["s3", "n3"]]);
  const clone = cloneWorkspaceTree(nestedRoot, map);

  // Structure + split metadata preserved.
  assert.equal(clone.type, "split");
  if (clone.type !== "split") return;
  assert.equal(clone.direction, "vertical");
  assert.deepEqual(clone.sizes, [0.8, 0.2]);
  const inner = clone.children[1];
  assert.equal(inner.type, "split");
  if (inner.type !== "split") return;
  assert.equal(inner.direction, "horizontal");
  assert.deepEqual(inner.sizes, [0.5, 0.5]);

  // sessionIds remapped.
  const collect = (n: WorkspaceNode): string[] =>
    n.type === "pane" ? [n.sessionId] : n.children.flatMap(collect);
  assert.deepEqual(collect(clone), ["n1", "n2", "n3"]);
});

test("cloneWorkspaceTree mints fresh node ids and does not mutate the source", () => {
  const map = new Map([["s1", "n1"], ["s2", "n2"], ["s3", "n3"]]);
  const clone = cloneWorkspaceTree(nestedRoot, map);
  assert.notEqual(clone.id, nestedRoot.id);
  // Source untouched.
  assert.equal(nestedRoot.id, "split-root");
  const collectSrc = (n: WorkspaceNode): string[] =>
    n.type === "pane" ? [n.sessionId] : n.children.flatMap(collectSrc);
  assert.deepEqual(collectSrc(nestedRoot), ["s1", "s2", "s3"]);
});

test("cloneWorkspaceTree keeps original sessionId when the map lacks it", () => {
  const clone = cloneWorkspaceTree(
    { id: "p", type: "pane", sessionId: "s1" },
    new Map(),
  );
  assert.equal(clone.type === "pane" && clone.sessionId, "s1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx domain/workspace.test.ts`
Expected: FAIL — `cloneWorkspaceTree is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Add to `domain/workspace.ts` (near `collectSessionIds`, ~line 280). Uses `crypto.randomUUID()` for node ids — the same generator every other builder in this file already uses.

```ts
/**
 * Deep-clone a workspace layout tree, minting fresh node ids and remapping
 * every pane's sessionId via `sessionIdMap` (old id -> new id). Split
 * `direction` and `sizes` are preserved. A sessionId absent from the map is
 * kept as-is. Pure; does not mutate `node`.
 */
export const cloneWorkspaceTree = (
  node: WorkspaceNode,
  sessionIdMap: ReadonlyMap<string, string>,
): WorkspaceNode => {
  if (node.type === 'pane') {
    return {
      id: crypto.randomUUID(),
      type: 'pane',
      sessionId: sessionIdMap.get(node.sessionId) ?? node.sessionId,
    };
  }
  return {
    id: crypto.randomUUID(),
    type: 'split',
    direction: node.direction,
    children: node.children.map(child => cloneWorkspaceTree(child, sessionIdMap)),
    ...(node.sizes ? { sizes: [...node.sizes] } : {}),
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx domain/workspace.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add domain/workspace.ts domain/workspace.test.ts
git commit -m "feat(workspace): add cloneWorkspaceTree tree-clone helper"
```

---

## Task 2: `buildCopiedWorkspace` pure helper

**Files:**
- Modify: `application/state/useSessionState.ts`
- Test: `application/state/copyWorkspace.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `application/state/copyWorkspace.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { TerminalSession, Workspace } from '../../domain/models';
import { collectSessionIds } from '../../domain/workspace';
import { buildCopiedWorkspace } from './useSessionState';

const session = (id: string, workspaceId?: string): TerminalSession => ({
  id,
  hostId: `host-${id}`,
  hostLabel: `Host ${id}`,
  hostname: `${id}.example.test`,
  username: 'user',
  status: 'connected',
  protocol: 'ssh',
  workspaceId,
});

const wsRoot = {
  id: 'split-1',
  type: 'split' as const,
  direction: 'vertical' as const,
  sizes: [0.6, 0.4],
  children: [
    { id: 'pane-1', type: 'pane' as const, sessionId: 's1' },
    { id: 'pane-2', type: 'pane' as const, sessionId: 's2' },
  ],
};

const sourceWorkspace: Workspace = {
  id: 'ws-src',
  title: 'My Split',
  viewMode: 'split',
  focusedSessionId: 's2',
  focusSessionOrder: ['s1', 's2'],
  root: wsRoot,
};

test('buildCopiedWorkspace clones every session with the new workspace id and inherited cwd', () => {
  const prev = [session('s1', 'ws-src'), session('s2', 'ws-src')];
  const built = buildCopiedWorkspace(sourceWorkspace, prev, {
    newWorkspaceId: 'ws-new',
    sessionIdMap: new Map([['s1', 'n1'], ['s2', 'n2']]),
    perPaneCwd: { s1: '/home/a', s2: '/home/b' },
  });

  assert.ok(built);
  assert.deepEqual(built.newSessions.map(s => s.id), ['n1', 'n2']);
  assert.ok(built.newSessions.every(s => s.workspaceId === 'ws-new'));
  // ssh clones carry the inherited cwd for cd injection.
  assert.equal(built.newSessions[0].pendingInitialCwd, '/home/a');
  assert.equal(built.newSessions[1].pendingInitialCwd, '/home/b');
});

test('buildCopiedWorkspace rebuilds the tree with new ids and preserves view mode + remapped focus', () => {
  const prev = [session('s1', 'ws-src'), session('s2', 'ws-src')];
  const built = buildCopiedWorkspace(sourceWorkspace, prev, {
    newWorkspaceId: 'ws-new',
    sessionIdMap: new Map([['s1', 'n1'], ['s2', 'n2']]),
  });

  assert.ok(built);
  assert.equal(built.newWorkspace.id, 'ws-new');
  assert.equal(built.newWorkspace.viewMode, 'split');
  assert.equal(built.newWorkspace.title, 'My Split');
  assert.deepEqual(collectSessionIds(built.newWorkspace.root), ['n1', 'n2']);
  assert.equal(built.newWorkspace.focusedSessionId, 'n2');
  assert.deepEqual(built.newWorkspace.focusSessionOrder, ['n1', 'n2']);
  // Tree references only the NEW session ids (none of the source ids leak).
  const ids = collectSessionIds(built.newWorkspace.root);
  assert.ok(!ids.includes('s1') && !ids.includes('s2'));
});

test('buildCopiedWorkspace prunes panes whose source session no longer exists', () => {
  const prev = [session('s2', 'ws-src')]; // s1 was closed
  const built = buildCopiedWorkspace(sourceWorkspace, prev, {
    newWorkspaceId: 'ws-new',
    sessionIdMap: new Map([['s1', 'n1'], ['s2', 'n2']]),
  });

  assert.ok(built);
  assert.deepEqual(built.newSessions.map(s => s.id), ['n2']);
  assert.deepEqual(collectSessionIds(built.newWorkspace.root), ['n2']);
  // focus fell back off the pruned session.
  assert.equal(built.newWorkspace.focusedSessionId, 'n2');
  assert.deepEqual(built.newWorkspace.focusSessionOrder, ['n2']);
});

test('buildCopiedWorkspace returns null when no source session survives', () => {
  const built = buildCopiedWorkspace(sourceWorkspace, [], {
    newWorkspaceId: 'ws-new',
    sessionIdMap: new Map([['s1', 'n1'], ['s2', 'n2']]),
  });
  assert.equal(built, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx application/state/copyWorkspace.test.ts`
Expected: FAIL — `buildCopiedWorkspace` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `application/state/useSessionState.ts`:

(a) Ensure the imports include `cloneWorkspaceTree`, `collectSessionIds`, and `pruneWorkspaceNode` from `../../domain/workspace` (the file already imports several of these — add whichever are missing to the existing import statement). Ensure `createCopiedTerminalSessionClone` is imported from `./terminalConnectionReuse` (already used by `copySession`). Ensure `Workspace` and `TerminalSession` types are imported from `../../domain/models` (already used).

(b) Add the exported pure helper next to `insertCopiedTabOrderIdOnce` (~line 101):

```ts
export function buildCopiedWorkspace(
  sourceWorkspace: Workspace,
  prevSessions: TerminalSession[],
  params: {
    newWorkspaceId: string;
    sessionIdMap: ReadonlyMap<string, string>;
    localShellType?: TerminalSession['shellType'];
    perPaneCwd?: Record<string, string | undefined>;
  },
): { newSessions: TerminalSession[]; newWorkspace: Workspace } | null {
  const sourceIds = collectSessionIds(sourceWorkspace.root);
  const liveIds = sourceIds.filter(id => prevSessions.some(s => s.id === id));
  if (liveIds.length === 0) return null;

  // Prune panes whose source session is gone so the clone never references a
  // missing session.
  let prunedRoot = sourceWorkspace.root;
  for (const deadId of sourceIds.filter(id => !liveIds.includes(id))) {
    const next = pruneWorkspaceNode(prunedRoot, deadId);
    if (next) prunedRoot = next;
  }

  const liveIdMap = new Map<string, string>(
    liveIds.map(id => [id, params.sessionIdMap.get(id) as string]),
  );

  const newSessions = liveIds.map(srcId => {
    const src = prevSessions.find(s => s.id === srcId) as TerminalSession;
    return createCopiedTerminalSessionClone(src, {
      id: liveIdMap.get(srcId) as string,
      workspaceId: params.newWorkspaceId,
      localShellType: params.localShellType,
      inheritedCwd: params.perPaneCwd?.[srcId],
    });
  });

  const remap = (id?: string): string | undefined =>
    (id != null ? liveIdMap.get(id) : undefined) ?? undefined;

  const newWorkspace: Workspace = {
    ...sourceWorkspace,
    id: params.newWorkspaceId,
    root: cloneWorkspaceTree(prunedRoot, liveIdMap),
    focusedSessionId: remap(sourceWorkspace.focusedSessionId)
      ?? liveIdMap.get(liveIds[0]),
    focusSessionOrder: sourceWorkspace.focusSessionOrder
      ? sourceWorkspace.focusSessionOrder
          .map(id => liveIdMap.get(id))
          .filter((id): id is string => Boolean(id))
      : undefined,
  };

  return { newSessions, newWorkspace };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx application/state/copyWorkspace.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add application/state/useSessionState.ts application/state/copyWorkspace.test.ts
git commit -m "feat(session): add buildCopiedWorkspace pure helper"
```

---

## Task 3: `copyWorkspace` state action

**Files:**
- Modify: `application/state/useSessionState.ts`

No new test file — the action is a thin StrictMode-safe wrapper over the Task 2 helper (which is already tested). Its idempotent primitives (`addWorkspaceIfMissing`, `insertCopiedTabOrderIdOnce`) each have coverage in `useSessionStateWorkspaceStrictMode.test.ts`.

- [ ] **Step 1: Add the action inside the hook, next to `copySession` (~line 981)**

```ts
  // Copy a whole workspace (split/focus tab): clone every pane's session and
  // reproduce the layout tree in a new tab.
  const copyWorkspace = useCallback((workspaceId: string, options?: {
    localShellType?: TerminalSession['shellType'];
    perPaneCwd?: Record<string, string | undefined>;
  }) => {
    const sourceWorkspace = workspaces.find(w => w.id === workspaceId);
    if (!sourceWorkspace) return;

    // Pre-mint the new workspace id and the old->new session-id map OUTSIDE the
    // updater so StrictMode's double-invocation does not mint two sets of ids.
    const newWorkspaceId = `ws-${crypto.randomUUID()}`;
    const sessionIdMap = new Map<string, string>(
      collectSessionIds(sourceWorkspace.root).map(id => [id, crypto.randomUUID()]),
    );

    setSessions(prevSessions => {
      const built = buildCopiedWorkspace(sourceWorkspace, prevSessions, {
        newWorkspaceId,
        sessionIdMap,
        localShellType: options?.localShellType,
        perPaneCwd: options?.perPaneCwd,
      });
      // Every source pane was closed between click and update — skip cleanly.
      if (!built) return prevSessions;

      // Nested idempotent setStates (mirrors copySession's pattern).
      setWorkspaces(prev => addWorkspaceIfMissing(prev, built.newWorkspace));
      setActiveTabId(newWorkspaceId);
      setTabOrder(prevTabOrder => {
        const allTabIds = [
          ...orphanSessions.map(s => s.id),
          ...workspaces.map(w => w.id),
          newWorkspaceId,
          ...logViews.map(lv => lv.id),
        ];
        return insertCopiedTabOrderIdOnce(prevTabOrder, workspaceId, newWorkspaceId, allTabIds);
      });

      return [...prevSessions, ...built.newSessions];
    });
  }, [workspaces, orphanSessions, logViews, setActiveTabId]);
```

- [ ] **Step 2: Add `copyWorkspace` to the hook's return object**

Find the object the hook returns (where `copySession` is returned) and add `copyWorkspace` alongside it.

Run: `grep -n "copySession,\|return {" application/state/useSessionState.ts | head`
Add `copyWorkspace,` next to the `copySession,` entry in the returned object.

- [ ] **Step 3: Verify the file type-checks and existing tests pass**

Run: `node --test --import tsx application/state/copyWorkspace.test.ts application/state/useSessionStateWorkspaceStrictMode.test.ts`
Expected: PASS.

Run: `npm run lint -- application/state/useSessionState.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add application/state/useSessionState.ts
git commit -m "feat(session): add copyWorkspace action for multi-pane tabs"
```

---

## Task 4: `copyWorkspaceWithCurrentShellImpl` App handler

**Files:**
- Modify: `application/app/AppHandlers.ts:513` (add after `copySessionWithCurrentShellImpl`)
- Test: `application/app/AppHandlers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `application/app/AppHandlers.test.ts` (it already imports from `./AppHandlers` and constructs `getCtx` stubs — mirror the existing `copySessionWithCurrentShell` tests at the top of the file for the ctx shape):

```ts
import { copyWorkspaceWithCurrentShellImpl } from "./AppHandlers";

test("copyWorkspaceWithCurrentShell captures per-pane cwd and copies the workspace", async () => {
  const calls: { copy?: { id: string; opts: any } } = {};
  const sessions = [
    { id: "p1", protocol: "local", localStartDir: "/home/a" },
    { id: "p2", protocol: "local", localStartDir: "/home/b" },
  ];
  const workspaces = [{
    id: "ws-1",
    root: {
      id: "sp", type: "split", direction: "vertical",
      children: [
        { id: "n1", type: "pane", sessionId: "p1" },
        { id: "n2", type: "pane", sessionId: "p2" },
      ],
    },
  }];
  const getCtx = () => ({
    classifyLocalShellType: () => "bash",
    collectSessionIds: (node: any): string[] =>
      node.type === "pane" ? [node.sessionId] : node.children.flatMap((c: any) => getCtx().collectSessionIds(c)),
    copyWorkspace: (id: string, opts: any) => { calls.copy = { id, opts }; },
    discoveredShells: [],
    getSessionRestoreCwd: () => undefined,
    hostById: new Map(),
    terminalHosts: [],
    netcattyBridge: { get: () => ({}) },
    resolveShellSetting: () => ({ command: "bash" }),
    sessions,
    terminalSettings: { localShell: "bash" },
    workspaces,
  });

  await copyWorkspaceWithCurrentShellImpl(getCtx, "ws-1");

  assert.equal(calls.copy?.id, "ws-1");
  assert.deepEqual(calls.copy?.opts.perPaneCwd, { p1: "/home/a", p2: "/home/b" });
  assert.equal(calls.copy?.opts.localShellType, "bash");
});

test("copyWorkspaceWithCurrentShell no-ops when the workspace is gone", async () => {
  let called = false;
  const getCtx = () => ({
    classifyLocalShellType: () => "bash",
    collectSessionIds: () => [],
    copyWorkspace: () => { called = true; },
    discoveredShells: [],
    getSessionRestoreCwd: () => undefined,
    hostById: new Map(),
    terminalHosts: [],
    netcattyBridge: { get: () => ({}) },
    resolveShellSetting: () => ({ command: "bash" }),
    sessions: [],
    terminalSettings: { localShell: "bash" },
    workspaces: [],
  });
  await copyWorkspaceWithCurrentShellImpl(getCtx, "missing");
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx application/app/AppHandlers.test.ts`
Expected: FAIL — `copyWorkspaceWithCurrentShellImpl` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `application/app/AppHandlers.ts` immediately after `copySessionWithCurrentShellImpl` (~line 523). `captureCtxInheritedCwd` is module-private in this same file — call it directly.

```ts
export async function copyWorkspaceWithCurrentShellImpl(getCtx: AppContextGetter, workspaceId: string) {
  const { classifyLocalShellType, collectSessionIds, copyWorkspace, discoveredShells, resolveShellSetting, terminalSettings, workspaces } = getCtx();
  const workspace = workspaces.find((w: { id: string }) => w.id === workspaceId);
  if (!workspace) return;

  const sessionIds: string[] = collectSessionIds(workspace.root);
  // Resolve each pane's cwd in parallel — SSH panes may await the /proc probe.
  const entries = await Promise.all(
    sessionIds.map(async (id): Promise<readonly [string, string | undefined]> =>
      [id, await captureCtxInheritedCwd(getCtx, id)] as const),
  );
  const perPaneCwd: Record<string, string | undefined> = Object.fromEntries(entries);

  const resolved = resolveShellSetting(terminalSettings.localShell, discoveredShells);
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return copyWorkspace(workspaceId, {
    localShellType: classifyLocalShellType(resolved?.command || terminalSettings.localShell, userAgent),
    perPaneCwd,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx application/app/AppHandlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add application/app/AppHandlers.ts application/app/AppHandlers.test.ts
git commit -m "feat(app): add copyWorkspaceWithCurrentShell handler with per-pane cwd"
```

---

## Task 5: Wire the handler in App.tsx and AppView

**Files:**
- Modify: `App.tsx`
- Modify: `application/app/AppView.tsx`

- [ ] **Step 1: Import the new handler in App.tsx**

Find the import of `copySessionWithCurrentShellImpl` and add `copyWorkspaceWithCurrentShellImpl` to that same import from `./application/app/AppHandlers`.

Run: `grep -n "copySessionWithCurrentShellImpl" App.tsx`

- [ ] **Step 2: Destructure `copyWorkspace` from `useSessionState`**

In the `useSessionState({...})` destructuring block (contains `copySession,` ~line 331), add `copyWorkspace,`.

- [ ] **Step 3: Add the bound callback next to `copySessionWithCurrentShell` (App.tsx:891)**

```tsx
  const copyWorkspaceWithCurrentShell = useCallback((workspaceId: string) => { return copyWorkspaceWithCurrentShellImpl(() => ({ classifyLocalShellType, collectSessionIds, copyWorkspace, discoveredShells, getSessionRestoreCwd, hostById, terminalHosts, netcattyBridge, resolveShellSetting, sessions, terminalSettings, workspaces }), workspaceId); }, [copyWorkspace, terminalSettings, discoveredShells, sessions, workspaces, getSessionRestoreCwd, hostById, terminalHosts]);
```

(`collectSessionIds` is already in scope in App.tsx — it appears in the `executeHotkeyAction` ctx.)

- [ ] **Step 4: Expose it in the AppView ctx**

In the `<AppView ctx={{ ... }} />` object (App.tsx ~line 1582), add `copyWorkspaceWithCurrentShell,` next to `copySessionWithCurrentShell,`.

- [ ] **Step 5: Destructure it in AppView and pass to TopTabs**

In `application/app/AppView.tsx`, add `copyWorkspaceWithCurrentShell` to the ctx destructure (near `copySessionWithCurrentShell` at line 102). Then add the prop to the `TopTabs` usage that renders workspace tabs — the one that passes `onRenameWorkspace={startWorkspaceRename}` (line 263):

```tsx
        onCopyWorkspace={copyWorkspaceWithCurrentShell}
```

Run: `grep -n "onRenameWorkspace={startWorkspaceRename}\|onCopySession={copySessionWithCurrentShell}" application/app/AppView.tsx`
Add `onCopyWorkspace={copyWorkspaceWithCurrentShell}` immediately after each `onRenameWorkspace={startWorkspaceRename}` occurrence (both TopTabs render sites, if the second one also passes workspace props).

- [ ] **Step 6: Verify build/type-check**

Run: `npm run lint -- App.tsx application/app/AppView.tsx`
Expected: no errors. (A "prop does not exist on TopTabsProps" error here is expected until Task 6 adds it — proceed to Task 6, then re-run.)

- [ ] **Step 7: Commit**

```bash
git add App.tsx application/app/AppView.tsx
git commit -m "feat(app): wire copyWorkspaceWithCurrentShell into AppView"
```

---

## Task 6: TopTabs + WorkspaceTopTab UI (menu item + double-click)

**Files:**
- Modify: `components/TopTabs.tsx`
- Modify: `components/top-tabs/TopTabItems.tsx`

- [ ] **Step 1: Add `onCopyWorkspace` to `TopTabsProps` and thread it**

In `components/TopTabs.tsx`:

(a) In the `TopTabsProps` interface, next to `onRenameWorkspace: (workspaceId: string) => void;` (line 135), add:

```ts
  onCopyWorkspace: (workspaceId: string) => void;
```

(b) In the component's destructured props (next to `onRenameWorkspace,` at line 181), add `onCopyWorkspace,`.

(c) In the `<WorkspaceTopTab ... />` usage (line 837), next to `onRenameWorkspace={onRenameWorkspace}` (line 852), add:

```tsx
            onCopyWorkspace={onCopyWorkspace}
```

(d) In `topTabsAreEqual` (line 1170), add `onCopyWorkspace` to the compared props (mirror how `onRenameWorkspace` / `onCopySession` are compared):

Run: `grep -n "onRenameWorkspace" components/TopTabs.tsx`
Add a `prev.onCopyWorkspace === next.onCopyWorkspace` clause alongside the existing `onRenameWorkspace` comparison.

- [ ] **Step 2: Add `onCopyWorkspace` to `WorkspaceTopTabProps` and the component**

In `components/top-tabs/TopTabItems.tsx`:

(a) In `WorkspaceTopTabProps` (line 833), next to `onRenameWorkspace: (workspaceId: string) => void;` add:

```ts
  onCopyWorkspace: (workspaceId: string) => void;
```

(b) In the `WorkspaceTopTab` destructured props (next to `onRenameWorkspace,` ~line 870) add `onCopyWorkspace,`.

- [ ] **Step 3: Add the double-click handler to the workspace tab body**

In `WorkspaceTopTab`, add a memoized handler near the top of the component (after `handleClick`, ~line 883). Reuse the existing factory used by session tabs, keyed on the workspace id:

```tsx
  const handleDoubleClick = useMemo(
    () => createSessionTopTabDoubleClickHandler(onCopyWorkspace, workspace.id),
    [onCopyWorkspace, workspace.id],
  );
```

Then add `onDoubleClick={handleDoubleClick}` to the tab `<div>` that has `data-tab-type="workspace"` (the element with `onClick={handleClick}`, ~line 889).

(`createSessionTopTabDoubleClickHandler` is already exported in this file at line 236 — `(onCopy, id) => () => onCopy(id)` — so it works unchanged for a workspace id. Ensure `useMemo` is imported; it is already used by `SessionTopTab` in this file.)

- [ ] **Step 4: Add the "Copy Tab" context-menu item**

In the workspace `<ContextMenuContent>` (~line 970), add a Copy item immediately
after Rename, matching the session-tab menu order (Rename → Copy Tab):

```tsx
        <ContextMenuItem onClick={() => onRenameWorkspace(workspace.id)}>
          {t('common.rename')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCopyWorkspace(workspace.id)}>
          {t('tabs.copyTab')}
        </ContextMenuItem>
```

(Replace the existing standalone Rename item with this two-item block so Copy sits directly after Rename.)

- [ ] **Step 5: Verify lint + full type-check pass**

Run: `npm run lint -- components/TopTabs.tsx components/top-tabs/TopTabItems.tsx application/app/AppView.tsx App.tsx`
Expected: no errors (the TopTabsProps error from Task 5 is now resolved).

- [ ] **Step 6: Commit**

```bash
git add components/TopTabs.tsx components/top-tabs/TopTabItems.tsx
git commit -m "feat(top-tabs): add Copy Tab + double-click to workspace tabs"
```

---

## Task 7: Full verification

- [ ] **Step 1: Run the full lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 2: Run the affected test suites**

Run: `node --test --import tsx domain/workspace.test.ts application/state/copyWorkspace.test.ts application/state/useSessionStateWorkspaceStrictMode.test.ts application/app/AppHandlers.test.ts`
Expected: all PASS.

- [ ] **Step 3: Manual verification (drive the real app)**

Invoke the `verify` skill (or `run` skill) to launch the app, then:
1. Open a local terminal; in it `cd` to a distinctive directory (e.g. `/tmp`).
2. Split it (horizontal and/or vertical) so the tab has 2–3 panes; `cd` each pane to a different directory.
3. Right-click the workspace tab → **Copy Tab** (and separately test double-click).
4. Confirm: a new tab appears with the **same split layout**; each new pane opens in the **same directory** as its source pane (`pwd` in each).
5. Repeat for an SSH-based split (each SSH pane should `cd` to the source pane's remote cwd on connect).
6. Repeat for a focus-mode multi-session tab (view mode preserved).

Expected: layout and per-pane cwd reproduced; no console errors.

- [ ] **Step 4: Push the branch**

```bash
git push -u fork feat/copy-workspace-split-tab
```

---

## Self-Review notes (author)

- **Spec coverage:** tree clone → Task 1; per-pane session clone + cwd + layout rebuild + focus/viewMode preserve + dead-pane prune → Task 2; StrictMode-safe state action + tabOrder/active tab → Task 3; per-pane cwd capture (all panes, parallel) → Task 4; entry points (menu + double-click, both view modes) → Task 6. Broadcast-not-copied is automatic (new ws id absent from `broadcastWorkspaceIds`) — no task needed.
- **Types:** `cloneWorkspaceTree(node, ReadonlyMap)`, `buildCopiedWorkspace(source, prevSessions, { newWorkspaceId, sessionIdMap, localShellType?, perPaneCwd? })`, `copyWorkspace(workspaceId, { localShellType?, perPaneCwd? })`, `copyWorkspaceWithCurrentShellImpl(getCtx, workspaceId)`, `onCopyWorkspace(workspaceId)` — consistent across tasks.
- **No placeholders:** every code step shows real code and exact run commands.
```
