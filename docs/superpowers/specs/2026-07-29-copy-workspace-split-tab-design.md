# Design: Copy a multi-pane (workspace) tab

Date: 2026-07-29
Status: Approved (design) — pending spec review

## Summary

The existing "Copy Tab" feature clones a single-session tab (and inherits its
cwd). It does **not** work when a tab holds multiple split panes — a *workspace*
tab. This change extends copy so that a workspace tab (both `split` and `focus`
view modes) can be copied: the new tab reproduces the source's **layout tree**,
each pane becomes a fresh session, and each pane starts in the **same working
directory** as the corresponding source pane.

The work mirrors the single-tab `copySession` path one layer up, at the
workspace level, and reuses the existing clone and cwd-capture machinery. Only
one new pure domain helper (tree remap) is introduced.

## Background — what already exists

- **Workspace model** (`domain/models/workspace.ts:11-35`): a workspace tab owns
  a recursive layout tree `WorkspaceNode = pane{sessionId} | split{direction,
  children, sizes?}`, a `viewMode` (`'split' | 'focus'`), optional
  `focusedSessionId`, `focusSessionOrder`, `snippetId`, and `title`. The tab id
  is the **workspace id** (`ws-…`), not a session id.
- **Tree operations** live in `domain/workspace.ts` (pure): `collectSessionIds`,
  `createWorkspaceFromSessionIds`, `insertPaneIntoWorkspace`,
  `pruneWorkspaceNode`, `updateWorkspaceSplitSizes`, focus-order helpers. There
  is **no** helper that deep-clones a tree while remapping its sessionIds — this
  is the one gap.
- **Single-session copy** (`application/state/useSessionState.ts:946-981`):
  `copySession(sessionId, { localShellType, inheritedCwd })` pre-mints one new
  session id outside the `setSessions` updater (StrictMode double-invoke
  safety), clones one session via `createCopiedTerminalSessionClone`, and
  inserts it into `tabOrder` next to the source via `insertCopiedTabOrderIdOnce`.
  It **no-ops on a workspace id** because `prevSessions.find(id)` misses.
- **Clone factory** (`application/state/terminalConnectionReuse.ts:26-88`):
  `createCopiedTerminalSessionClone(session, { id, localShellType, workspaceId?,
  inheritedCwd? })` copies host/connection identity; for local sets
  `localStartDir = inheritedCwd`; for ssh sets `pendingInitialCwd = inheritedCwd`
  (drives the `cd -- <quoted>` injection on first connect). `workspaceId` is set
  only when passed.
- **cwd capture** (`application/app/AppHandlers.ts`):
  `captureCtxInheritedCwd(getCtx, session)` resolves a session's cwd in priority
  order (`lastCwd` → SSH `/proc` probe `getSessionPwd` → `localStartDir`).
  `copySessionWithCurrentShellImpl` (`AppHandlers.ts:513-522`) is the async App
  handler that captures then calls `copySession`.
- **Copy-Tab UI**: session tabs expose "Copy Tab" via
  `components/top-tabs/SessionTabContextMenuContent.tsx:45-48` and
  double-click (`TopTabItems.tsx:236-239`), bound to `copySessionWithCurrentShell`
  (`AppView.tsx:261,489`). The **workspace** tab
  (`WorkspaceTopTab`, `TopTabItems.tsx:833-855, 961-980`) has **no** Copy item
  and no double-click handler and is passed no copy prop.

## Why it fails today (root cause)

Two independent gaps:

1. **No entry point** — `WorkspaceTopTab`'s context menu offers only Rename /
   Detach / Close; there is no "Copy Tab" item and no double-click handler.
2. **No handler** — even if invoked, `copySession(workspaceId)` looks the id up
   in `sessions`, misses (the id is a workspace id), and returns unchanged.
   `copySession` clones exactly one session and has no notion of the layout tree.

## Decisions (from brainstorming)

- **Entry point**: match single-session tabs — add "Copy Tab" to the workspace
  tab right-click menu **and** enable double-click-to-copy.
- **Scope**: copy **all** workspace tabs — both `split` (tiled) and `focus`
  (list + single terminal) view modes — preserving the view mode and layout.
- **cwd inheritance**: per pane, exactly the single-tab behavior applied to every
  pane (`lastCwd` → SSH probe → `localStartDir`).
- **Not doing** (YAGNI): copies are fresh sessions created exactly like the
  single-tab copy (`createCopiedTerminalSessionClone`) — connection-reuse
  behavior is whatever `copySession` already does, not overridden here; no live
  pane-content duplication; no broadcast-mode copy.

## Architecture

Layering follows `AGENTS.md`: pure tree logic in `domain/`, orchestration in the
`useSessionState` hook, async cwd capture in the App handler, presentation-only
wiring in components.

### 1. Domain helper (pure) — `domain/workspace.ts`

```ts
// Deep-clone a layout tree, minting fresh node ids and remapping every
// pane.sessionId via idMap (old -> new). Preserves split direction and sizes.
export function cloneWorkspaceTree(
  node: WorkspaceNode,
  sessionIdMap: ReadonlyMap<string, string>,
): WorkspaceNode
```

- `pane` → new node id, `sessionId = sessionIdMap.get(old) ?? old`.
- `split` → new node id, same `direction`, cloned `sizes` (copied array),
  children recursively cloned.
- No React/Electron imports; unit-tested.

### 2. State action — `application/state/useSessionState.ts`

`copyWorkspace(workspaceId, { perPaneCwd, localShellType })` beside
`copySession`:

1. Look up workspace in `workspaces`; if missing, no-op. Source session ids =
   `collectSessionIds(ws.root)`.
2. **Pre-mint** outside the updater (StrictMode safety, as `copySession` does):
   new workspace id + an `oldId → newId` session-id `Map` for every source
   session.
3. Filter source ids to sessions that still exist in `prevSessions`. If a source
   session was closed mid-action, prune its pane from the source tree first via
   `pruneWorkspaceNode(root, deadSessionId)` (repeated per dead session). Build
   `idMap` only over the surviving sessions. Clone each surviving session via
   `createCopiedTerminalSessionClone(src, { id: newId, workspaceId: newWsId,
   localShellType, inheritedCwd: perPaneCwd[srcId] })` and append all clones. If
   no sessions survive, no-op.
4. Build the new workspace: `root = cloneWorkspaceTree(prunedRoot, idMap)`
   (so it references only surviving, remapped ids), preserve `viewMode`,
   `title`, `snippetId`; remap `focusSessionOrder` through `idMap` (dropping
   dead ids); set `focusedSessionId` to the remapped source focus, or the first
   new id if the source focus pane did not survive.
5. Register: add workspace (`addWorkspaceIfMissing`), insert new workspace id into
   `tabOrder` next to the source (mirror `insertCopiedTabOrderIdOnce`),
   `setActiveTabId(newWsId)`.

Notes:
- Broadcast mode is keyed by workspace id (`broadcastWorkspaceIds`); the new
  workspace id is absent → the copy starts non-broadcast. No action needed.
- Copies inherit the clone factory's behavior verbatim (`status: 'connecting'`,
  and `reuseConnectionFromSessionId` set for a connected SSH source exactly as
  `copySession` does) — the workspace copy does not change connection-reuse
  semantics.

### 3. App handler — `application/app/AppHandlers.ts`

`copyWorkspaceWithCurrentShellImpl(getCtx, workspaceId)` beside
`copySessionWithCurrentShellImpl`:

1. Resolve the workspace and its session ids from ctx state.
2. For **every** session, `captureCtxInheritedCwd(getCtx, session)` — run panes
   in parallel (`Promise.all`), since SSH panes may `await` the `/proc` probe.
3. Build `perPaneCwd: Record<sessionId, string | undefined>` and call
   `copyWorkspace(workspaceId, { perPaneCwd, localShellType })`.

### 4. UI wiring — presentation only

- `WorkspaceTopTab` context menu (`components/top-tabs/TopTabItems.tsx`): add a
  "Copy Tab" item reusing the existing i18n key `tabs.copyTab`, placed
  immediately after Rename to match the session-tab context-menu order
  (Rename → Copy Tab).
- Add a double-click-to-copy handler on `WorkspaceTopTab`, paralleling
  `SessionTopTab` (`createSessionTopTabDoubleClickHandler`).
- New prop `onCopyWorkspace: (workspaceId: string) => void` threaded
  `App → AppView → TopTabs → WorkspaceTopTab`, bound to
  `copyWorkspaceWithCurrentShell`.
- Add `onCopyWorkspace` to the `topTabsAreEqual` memo comparison and the
  `WorkspaceTopTab` props/equality checks so re-renders stay correct.

## Data flow

```
right-click "Copy Tab" / double-click on a workspace tab
  -> onCopyWorkspace(workspaceId) = copyWorkspaceWithCurrentShell (async)
     -> for each session: captureCtxInheritedCwd (lastCwd | ssh /proc | localStartDir)  [parallel]
     -> copyWorkspace(workspaceId, { perPaneCwd, localShellType })
        -> pre-mint newWsId + idMap(old->new session ids)
        -> clone each session (new workspaceId, inheritedCwd=perPaneCwd[old])
        -> root = cloneWorkspaceTree(ws.root, idMap); remap focus fields
        -> add sessions + workspace, tabOrder insert, setActiveTabId(newWsId)
  -> each new pane connects; local uses localStartDir, ssh injects `cd -- <cwd>`
```

## Error handling / edge cases

- **Workspace closed** between click and handler: `copyWorkspace` no-ops.
- **A pane's session closed** mid-action: skip that session and prune its pane
  from the cloned tree so the tree never references a missing session.
- **Single-pane workspace** (root is a bare `pane`): handled generically by
  `cloneWorkspaceTree`.
- **Remote panes with no known cwd**: `inheritedCwd` undefined → pane behaves as
  today (no cd injection), same as single-tab copy.
- **StrictMode** double-invocation: ids pre-minted outside the updater; nested
  `setActiveTabId` / `setTabOrder` are idempotent.

## Testing

Run: `node --test --import tsx <file>`.

- `domain/workspace.test.ts` — `cloneWorkspaceTree`: remaps all `pane.sessionId`
  via the map, mints fresh node ids (no id shared with source), preserves
  `direction` and `sizes` on a nested tree; identity when map is empty.
- `application/state/useSessionState*.test.ts` — `copyWorkspace`: creates N new
  sessions + 1 workspace; cloned tree references only new session ids; new
  workspace carries `viewMode`/remapped focus fields; tabOrder places the copy
  next to the source; active tab is the new workspace; StrictMode
  double-invocation mints no duplicates; a mid-action-closed pane is pruned.
- App handler test — per-pane `inheritedCwd` resolved for every session (local →
  `localStartDir`, SSH → probe), assembled into `perPaneCwd`.

## Files touched

- `domain/workspace.ts` (+ `domain/workspace.test.ts`) — `cloneWorkspaceTree`.
- `application/state/useSessionState.ts` (+ test) — `copyWorkspace`.
- `application/app/AppHandlers.ts` (+ test) — `copyWorkspaceWithCurrentShellImpl`.
- `application/app/AppView.tsx`, `components/TopTabs.tsx`,
  `components/top-tabs/TopTabItems.tsx` — UI entry point + prop threading.
- i18n: reuse existing `tabs.copyTab`; no new key required.
```
