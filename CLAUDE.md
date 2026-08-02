# Torc

A fleet console for CLI coding agents — several Claude Code sessions side by side, with a live view
of which one is working and which one is blocked by you. Electron + React 19 + TypeScript, `node-pty`
and xterm.js for real terminals. Not an editor.

## Start here

**[`docs/plan-of-attack.md`](docs/plan-of-attack.md) is the current state and the ordered plan.** Read
it before doing anything. It's the only file that tracks state, every item links to a ticket, and it
carries a decisions log so settled questions stay settled.

Two rules that keep it worth reading:

1. **Closing a ticket means checking its box in the plan, in the same PR.** Not afterwards.
2. **A decision goes in the plan's decisions log when it's made**, with the reasoning and what was
   rejected — otherwise the next agent re-litigates it.

Supporting docs: [`docs/orchestration.md`](docs/orchestration.md) for the orchestrator tier — one lead
with agents beneath it — which is design notes under #34 and nothing built yet,
[`docs/architecture.md`](docs/architecture.md) for how monitoring works,
[`docs/context-brief.md`](docs/context-brief.md) for why the project exists and what the design is.
The context brief is a snapshot from the start of the project; where it and the plan disagree about
status, the plan is right.

## Commands

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest, ~1s
npm run dev           # dev build, hot reloads
npm run dist          # release/Torc.app and a .dmg
npm run icon          # regenerates build/icon.icns — build/ is gitignored, so a
                      # fresh checkout needs this before dist
```

Run `npm run typecheck` and `npm test` before opening a PR. There's no CI yet (#14).

The Electron harnesses drive the renderer through `window.__torc` and capture with
`webContents.capturePage()`, so they work regardless of which window is frontmost. They need a
signed-in `claude` on the machine:

```bash
TORC_SCENARIOS=/tmp/scen npm run dev    # 23 assertions over real user flows
TORC_QA=/tmp/shots npm run dev          # screenshots itself
TORC_DEMO=/tmp/demo npm run dev         # a real fleet across repos, read-only
TORC_DEBUG_HOOKS=1 npm run dev          # log every hook event received
```

`TORC_QA_MODE` selects a QA scenario — `restore`, `split`, `palette`, `shim`, `keys`. Note the
scenario harness currently prints failures but still exits 0 (#13), so read the log.

## Invariants

Break these and things go wrong in ways that are hard to trace:

- **Main owns the truth.** `SessionSnapshot` lives in main; main pushes deltas to the renderer over
  typed IPC. The renderer never writes a snapshot and never touches the filesystem.
- **No TUI scraping, ever.** Agent state comes from Claude Code's structured surfaces: hooks for fast
  state edges, the session JSONL for detail, `claude agents --json` every 2s to reconcile and to
  discover agents started outside Torc. The PTY is only responsible for pixels and keystrokes. If you
  find yourself parsing terminal output for state, the answer is somewhere in
  `docs/architecture.md`.
- **PTY output stays off the hot path.** Chunks are coalesced before crossing IPC.
- **Torc never edits `~/.claude/settings.json`.** Per-session hooks go in via `claude --settings`
  pointing at a generated file under `~/.torc/`. Everything in `~/.torc/` is regenerated on launch and
  safe to delete.
- **A GUI-launched Electron app has a bare `PATH`,** and `claude` lives in `~/.local/bin`. The user's
  real environment is resolved once from `$SHELL -lic env` and reused for every PTY. Without it,
  panes work in `npm run dev` and fail in the packaged app.

## Conventions

- **Comments explain why, not what** — the constraint, the failure mode, or the alternative that was
  rejected. `SessionManager.ts` and `TerminalPane.tsx` are the reference for the register. Don't
  narrate code that speaks for itself.
- **Tests are colocated** — `status.test.ts` beside `status.ts`. Pure logic gets unit tests; anything
  needing a real window or a real pty goes in `src/main/scenarios.ts` as an assertion, not a
  screenshot to eyeball.
- **One PR per change, prose title, imperative mood.** No conventional-commits prefixes — see the
  existing history (`Make ⇧⏎ a newline, close panes from the rail, give agents more rows`). Unrelated
  changes that happen to share a working tree still get separate PRs.
- **Keyboard first.** ⌘K is the control surface; a new capability should be reachable from the palette
  (`src/renderer/cmdk/registry.ts`), not only from a click.
- **Don't add a dependency** without a reason that survives the question "what does this replace".

## Layout

```
src/main/        Electron main — owns all state
  pty/           SessionManager (spawns claude with an assigned --session-id), launchArgs
  fleet/         monitor, bridge (hook HTTP), transcript tailer, agentsPoller, status reducer
  store/         session persistence
  qa.ts scenarios.ts demo.ts   the harnesses above
src/preload/     contextBridge — the only main↔renderer surface
src/renderer/    React — Rail, PaneGrid, TerminalPane, MissionControl, cmdk palette, themes
src/shared/      types.ts — the vocabulary all three share. No node imports.
```
