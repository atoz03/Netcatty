# Design: StrictMode + eliminate App mega-subscribers

Date: 2026-08-07
Status: Implemented on `cursor/cloud-agent-1786101120448-jga1a` (stacked on `perf/strictmode-mega-subscriber-elimination`)

## Summary

Open React `StrictMode` on every renderer root and remove the App-level
“mega subscriber” that co-hosted vault + session + settings state while
rendering the whole shell. High-churn fields (notes, accent, connection logs,
AI sessions, toast, SFTP hosts) must update only the islands that read them.

## Goals

1. All `root.render` call sites wrap `<StrictMode>` (main, settings, tray,
   terminal-popup).
2. Terminal boot/Cancel are StrictMode-safe: abort + epoch-scoped close before
   async capture; no first-connect race from double mount.
3. `App.tsx` / `AppShell` never call `useVaultState` + `useSessionState` +
   `useSettingsState` in the same component that renders the shell.
4. Dragging custom accent, appending connection logs, editing notes, or
   streaming AI tokens must not rebuild unrelated Host / AppView domains.

## Architecture

Publisher islands own the mega hooks and publish into external stores via
`useSyncExternalStore`. Host islands subscribe to the slices they need and
assemble domain bags field-by-field into `appShellPropsStore`. `AppShell` is
memoized and only re-renders when published bags change by value equality.

| Publisher | Store(s) | Host |
|-----------|----------|------|
| SettingsPublisher | appearanceChromeStore, settingsChromeStore, terminalSettingsStore | ChromeHost (+ theme leaves) |
| VaultPublisher | vaultSnapshotStore, notesStore, connectionLogsStore, shellHistoryStore | VaultHost |
| SessionPublisher | sessionSnapshotStore, aiSessionsStore | TerminalHost |
| (dialogs local UI) | appLocalUiStore | DialogsHost |

## StrictMode invariants

- Terminal boot defers past the synchronous remount (`queueMicrotask`) and
  scopes worker close by `bootEpoch`.
- Never-connected cleanup sync-disposes the owned xterm runtime.
- Vault async init cancels the superseded effect and only the survivor may call
  `setVaultInitialized(true)`.
- Backend start waits for vault hydration so restored panes do not dial with an
  empty keychain.
- One-shot preload subscriptions (terminal popup config) retain `lastPayload`
  across unsubscribe/resubscribe.
- Startup latches (clone-session, PF auto-start, update toast, rendererReady,
  MCP sync) are idempotent under double invoke.

## Accent isolation

Published `currentTerminalTheme` is the **base** catalog theme. Live custom
accent is applied at leaves (`appearanceChromeStore`) and in CSS-var injection,
never baked into the terminal/chrome domain bag on every HSL tick.

## Definition of Done

- [x] App root has no three mega hooks co-rendering the shell
- [x] notes / accent / connectionLogs / whole settings bag stay out of
      cross-shell domain deps
- [x] AI streaming does not re-render sibling panels / unrelated Hosts
- [x] SFTP hosts context is split from pane callbacks
- [x] Toast state updates do not re-render action-only subscribers
- [x] StrictMode enabled; Cancel/boot/double-mount contracts green
- [x] Child memo tests plus parent-shell / Host bag assertions
- [x] No “parent exploded, child pretends OK” (shell subscription is the bar)
- [x] Bugbot loop clean on the delivery PR

## Non-goals

- New third-party state libraries
- Product behavior changes beyond StrictMode-correctness and re-render isolation
- Public API changes to Electron CLI / MCP surfaces

## Plan pointer

Implementation steps live in
`docs/superpowers/plans/2026-08-07-strictmode-mega-subscriber.md`.
