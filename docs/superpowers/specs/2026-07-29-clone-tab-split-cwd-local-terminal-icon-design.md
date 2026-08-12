# Design: Clone-tab, split-inherits-cwd, and local-terminal quick icon

Date: 2026-07-29
Status: Approved (design) — pending spec review

## Summary

Three small terminal UX improvements for Netcatty:

1. **One-click clone tab** — the existing tab right-click "Copy Tab" should also
   inherit the source tab's current working directory.
2. **Split inherits cwd** — horizontal/vertical split of a session should start
   the new pane in the source pane's current working directory.
3. **Local-terminal quick icon** — a small terminal icon in the top tab bar
   (left of the file-transfer / `GlobalSftpTransferCenter` button) that opens a
   new local terminal with one click.

All three build on machinery that already exists; the work is mostly wiring plus
one new shared cwd-inheritance helper.

## Background — what already exists

- `TerminalSession.lastCwd` (`domain/models/terminal.ts:571`) holds the latest
  tracked working directory, synced from the renderer's `knownCwdRef` (OSC 7)
  via `updateSessionRestoreCwd` (`useSessionState.ts:291`).
- `copySession(id, opts)` (`useSessionState.ts:922`) already clones a tab to a
  new tab and is exposed via the tab right-click menu (`onCopySession`,
  `TopTabs.tsx:804`). It does **not** copy `lastCwd`.
- `splitSession(id, direction, opts)` (`useSessionState.ts:724`) clones a session
  into a workspace pane via `createSplitTerminalSessionClone`
  (`terminalConnectionReuse.ts`). The clone factory copies `localStartDir` but
  **deliberately not** `lastCwd` — this is the root gap for features 1 & 2.
- Local pty spawn cwd comes from `localStartDir`
  (`createTerminalSessionStarters.ts:1592`, passed as `cwd` to
  `startLocalSession`). `initialCwd` (`Terminal.tsx:2001`) only feeds
  plugin-lifecycle metadata, not the spawn.
- SSH cwd resolution: `getSessionPwd` (`sshBridge/sessionOps.cjs:238`) reads
  `/proc/<pid>/cwd`; wired renderer→main as `netcatty:ssh:pwd`, exposed to the
  renderer via `useTerminalBackend.getSessionPwd`. Local terminals have **no**
  backend cwd probe — local cwd is known only from OSC 7 output.
- SSH "start at a directory" primitive: `resolveRestoreCwdIntent`
  (`domain/sessionRestore.ts:255`) produces `{ cwd, command: 'cd -- <quoted>' }`
  and `Terminal.tsx` injects it after the shell is ready
  (`restoreCwdIntentRef`, `prepareRestoredReconnect` at `Terminal.tsx:1285`).
  Today it fires only for relaunch-restored sessions, gated by the
  `restoreTerminalCwd` setting.
- Local-terminal creation: `createLocalTerminalWithCurrentShell`
  (`App.tsx:886` → `AppHandlers.ts:448`) resolves the configured shell and calls
  `createLocalTerminal`. The tab-bar `+` button opens the quick switcher
  (`onOpenQuickSwitcher`), not a direct local terminal.

## Decisions (from brainstorming)

- Feature 1 entry point: **reuse the existing right-click "Copy Tab"** and make
  it inherit cwd (no new tab-hover button).
- Feature 3 placement: **top tab bar right controls, immediately left of the
  file-transfer button** (`GlobalSftpTransferCenter`, `TopTabs.tsx:1095`).
- cwd capture: **active probe** — for SSH, when `lastCwd` is empty, call
  `getSessionPwd`. Local has no probe (OSC 7 / `lastCwd` only).
- SSH `cd` injection for clone/split: **always inherit**, decoupled from the
  `restoreTerminalCwd` relaunch setting.

## Architecture

### Shared core: cwd capture & apply

**Capture (App-level, async).** A small async helper resolves the source
session's cwd to inherit, in priority order:

1. `session.lastCwd` if present.
2. Else, if protocol is SSH and connected: `await getSessionPwd(id)` (the
   `/proc` probe). Guard with a short timeout / try-catch; on failure fall
   through.
3. Else fall back to the source session's `localStartDir` (local) or `undefined`
   (remote — meaning "no inheritance, behave as today").

The capture runs in the App-level handlers (`copySessionWith...`,
`splitSessionWith...`) because it may `await` a probe, whereas the clone
factories run synchronously inside a `setSessions` updater.

**Apply (clone factory).** `createTerminalSessionClone` (and its
`createSplitTerminalSessionClone` / `createCopiedTerminalSessionClone` exports)
gains an `inheritedCwd?: string` option, applied by protocol:

- **local** → set clone `localStartDir = inheritedCwd` (native pty spawn cwd,
  works for all local shells incl. powershell/cmd).
- **ssh / remote (ssh)** → carry `inheritedCwd` so the terminal injects
  `cd -- <quoted>` on first connect. Reuse `quoteRestoreCwdArgument` and
  generalize the `restoreCwdIntent` path so it fires for a freshly-connecting
  clone, **independent** of `restoreTerminalCwd` and of `restoreState`.
- **serial / telnet / mosh / et, or local powershell/cmd for the `cd` path** →
  skip cd injection (matches existing `shouldAttemptRestoreCwd` exclusions).
  Local powershell/cmd still gets `localStartDir` which is correct.

Threading: `copySession(id, { localShellType, inheritedCwd })` and
`splitSession(id, direction, { localShellType, inheritedCwd })` pass the option
into the clone factory.

The generalized SSH injection is exposed as a new eligibility path in
`domain/sessionRestore.ts` (or a sibling pure helper) so it stays unit-testable
and free of React/Electron. Concretely: a function that, given a clone's
protocol/shellType/inheritedCwd, returns the same `{ cwd, command }` shape the
terminal already consumes — without requiring `restoreState ===
"restored-disconnected"` or the `enabled` flag.

### Feature 1 — clone tab inherits cwd

`copySessionWithCurrentShellImpl` (`AppHandlers.ts:473`) becomes async: capture
`inheritedCwd` from the source session, then call `copySession(id, {
localShellType, inheritedCwd })`. No UI change — the existing right-click "Copy
Tab" now lands in the same directory.

### Feature 2 — split inherits cwd

`splitSessionWithCurrentShellImpl` (`AppHandlers.ts:463`) becomes async: capture
`inheritedCwd`, then `splitSession(id, direction, { localShellType,
inheritedCwd })`. Applies to both horizontal and vertical split (same handler,
`direction` param).

### Feature 3 — local-terminal quick icon

Add an icon `Button` (`SquareTerminal` from lucide) in the `TopTabs.tsx`
right-controls cluster (`TopTabs.tsx:1091-1142`), inserted immediately **before**
`<GlobalSftpTransferCenter />` (line 1095). Styling matches sibling utility
buttons (`h-7 w-7 shrink-0 app-no-drag top-tab-utility-btn`,
`var(--top-tabs-muted...)`). Wrapped in `Tooltip` with i18n
`topTabs.newLocalTerminal`.

- New prop `onCreateLocalTerminal: () => void` on `TopTabs`.
- Thread the prop `App` → `AppView` → `TopTabs`, bound to the existing
  `createLocalTerminalWithCurrentShell`.
- Add `onCreateLocalTerminal` to the `topTabsAreEqual` memo comparison
  (`TopTabs.tsx:1153`).

## Data flow

```
Feature 1 (clone):
  right-click "Copy Tab"
    -> onCopySession = copySessionWithCurrentShell (async)
       -> capture inheritedCwd (lastCwd | getSessionPwd probe | localStartDir)
       -> copySession(id, { localShellType, inheritedCwd })
          -> createCopiedTerminalSessionClone(..., { inheritedCwd })
             -> local: localStartDir = inheritedCwd
             -> ssh:   inject `cd -- <cwd>` on first connect

Feature 2 (split):
  context-menu Split H/V
    -> onSplitSession = splitSessionWithCurrentShell (async)
       -> capture inheritedCwd (same as above)
       -> splitSession(id, direction, { localShellType, inheritedCwd })
          -> createSplitTerminalSessionClone(..., { inheritedCwd }) [same apply]

Feature 3 (local icon):
  TopTabs terminal icon onClick
    -> onCreateLocalTerminal = createLocalTerminalWithCurrentShell
       -> createLocalTerminal({...resolved shell})
```

## Error handling & edge cases

- **Unknown cwd** → `inheritedCwd` undefined → clone behaves exactly as today
  (login dir for SSH, `localStartDir`/`$HOME` for local). No regression.
- **SSH probe failure/timeout** → treated as unknown cwd; no error surfaced to
  the user, clone still opens.
- **Windows local (powershell/cmd)** → `localStartDir` inheritance works; no
  `cd` injection attempted.
- **Serial / telnet / mosh / et** → no cwd inheritance (excluded).
- **Source tab closed between action and updater** → `copySession`/`splitSession`
  already no-op when the source session is gone; capturing cwd beforehand does
  not change that (a stale captured cwd on a vanished source is simply unused).
- **Non-cd startup command conflict** → the inherited `cd` is a one-shot intent
  consumed on first connect and does not replace or suppress a host's configured
  startup command (verify ordering against `suppressHostStartupCommandRef`).

## Testing

Unit tests (node --test + tsx):

- Clone factory applies `inheritedCwd`: local → `localStartDir`; ssh → produces
  the `cd -- <quoted>` intent; serial/win-shell → no `cd` intent.
- cwd capture priority: `lastCwd` wins; empty + ssh → probe; empty + local →
  `localStartDir` fallback; probe error → undefined.
- Generalized restore-cwd/clone-cwd helper: fires without
  `restoreState === "restored-disconnected"` and without the `restoreTerminalCwd`
  flag, while keeping the existing relaunch-restore behavior unchanged.
- `quoteRestoreCwdArgument` reused for quoting (existing coverage).

Manual/verify: clone a local tab in a subdir → new tab opens there; split an SSH
session in a subdir → new pane `cd`s there; click the new tab-bar icon → a local
terminal opens.

i18n: add `topTabs.newLocalTerminal` to `en`, `zh-CN`, `zh-TW` core locales.

## Out of scope (YAGNI)

- No backend cwd probe for local terminals (none exists; OSC 7 suffices).
- No new tab-hover clone button (user chose to reuse the right-click menu).
- No per-pane "new local terminal" toolbar button.
- No changes to the relaunch session-restore behavior itself.

## Key files

- `application/state/terminalConnectionReuse.ts` — clone factories (`inheritedCwd`)
- `application/state/useSessionState.ts` — `copySession`, `splitSession` options
- `application/app/AppHandlers.ts` — `copySessionWith...`, `splitSessionWith...` (async capture)
- `domain/sessionRestore.ts` — generalized cwd-intent helper
- `components/Terminal.tsx` — consume clone cwd intent on first connect
- `components/TopTabs.tsx` — new local-terminal icon + prop + memo
- `application/app/AppView.tsx`, `App.tsx` — thread `onCreateLocalTerminal`
- `application/i18n/locales/{en,zh-CN,zh-TW}/*` — `topTabs.newLocalTerminal`
