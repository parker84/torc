# Architecture

```
main process (node)
├─ SessionManager      node-pty; spawns claude with an assigned --session-id
├─ FleetMonitor
│   ├─ HookBridge        HTTP on 127.0.0.1:<ephemeral>, token-guarded  ← hook events
│   ├─ TranscriptTailer  byte-offset incremental reads of the session JSONL
│   ├─ AgentsPoller      `claude agents --json` every 2.5s → reconcile + discover
│   └─ deriveStatus      pure reducer merging all three
        ↕ typed IPC (contextBridge preload)
renderer (React 19 + zustand)
├─ Rail · TerminalPane (xterm.js + WebGL)
├─ MissionControl (⌘0)
└─ ⌘K palette + command registry
```

Main owns the truth and pushes deltas; the renderer never touches the filesystem.

## The monitoring surfaces

The hard part of watching a TUI agent looks like it should be screen-scraping. It isn't — Claude Code
exposes all of it as structured data.

| Surface | What it gives us | Used in |
|---|---|---|
| `claude agents --json` | Every live session: `pid`, `cwd`, `sessionId`, `name`, `status: busy\|idle` — including sessions Torc didn't launch | `fleet/agentsPoller.ts` |
| `claude --session-id <uuid>` | We assign the id at spawn, so the transcript path is known before the agent emits a byte | `pty/launchArgs.ts` |
| `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` | `ai-title`, per-message `usage` tokens, `model`, `tool_use` blocks, `gitBranch`, `permissionMode` | `fleet/transcript.ts` |
| `claude --settings <file>` | Injects Torc's hooks per session, leaving `~/.claude/settings.json` untouched | `fleet/hooksSettings.ts` |
| `claude -w/--worktree` | Isolated checkout per agent | `pty/launchArgs.ts` |

The `<cwd-slug>` is the cwd with every `/` replaced by `-`, so `/Users/x/side` becomes
`-Users-x-side`. A resumed session or a worktree can land under a different slug than the cwd we
spawned with, so the tailer falls back to scanning for the id.

## Status precedence

`deriveStatus` in `fleet/status.ts` is pure and unit-tested, because the ordering between sources is
the part most likely to be got wrong:

1. **The PTY exited** — nothing else matters.
2. **A `Notification` hook** — the agent is explicitly waiting on the user.
3. **Busy signals** — the poller says `busy`, or the transcript has an open tool call.
4. **A completed turn nobody has read** — done, and wants a look.
5. Otherwise **idle**.

"Needs attention" is (2), (4), or a non-zero exit. It drives the amber dot, the Mission Control
sort order and the status bar count.

Two orderings that matter and are easy to get backwards:

- `Stop` does **not** clear `blocked`. In plan mode a turn ends with an approval prompt still
  pending; downgrading that to "finished" would throw away the signal the user needs.
- `working` beats "turn finished unread" — if the agent has moved on, so should the UI.

## Hook transport

Each agent gets one command per event, generated into `~/.torc/hooks.settings.json`:

```
curl -s -m 0.3 -X POST -H 'content-type: application/json' \
  --data-binary @- "$TORC_HOOK_URL" >/dev/null 2>&1 || true
```

`curl` rather than a Node script because process startup is on the agent's hot path (~5ms vs ~40ms),
and `-m 0.3` with `|| true` means a slow or dead Torc can never hang or fail a tool call. The payload
already carries `hook_event_name`, `session_id`, `cwd`, `tool_name` and `tool_input`, so one command
serves every event.

## Two environment details that are load-bearing

**Resolving the login shell.** A GUI-launched Electron app inherits a bare `PATH`, and `claude` lives
in `~/.local/bin` — invisible to the app. `main/env.ts` asks the login shell for its environment once
at startup and reuses it for every PTY. Without this, panes work under `npm run dev` and fail in the
packaged app.

**Scrubbing session markers.** If Torc is launched from inside a Claude Code session — exactly how
you'd try it the first time — `CLAUDE_CODE_CHILD_SESSION` and friends leak into every pane, and that
inherited marker makes Claude skip writing a transcript. Since the transcript is what Torc tails, that
would silently disable monitoring. `env.ts` strips `CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_EFFORT`,
`CLAUDE_PID` and `TORC_*`, keeping genuine preferences like `CLAUDE_CODE_ENABLE_TELEMETRY`.

## Discovering agents you started yourself

`⌘T` opens a plain shell, so the natural workflow is to type `claude` into it. Those sessions appear
in `claude agents --json` without a session id we assigned, so `FleetMonitor.onPoll` claims them by
**process ancestry**: walk the discovered pid's parent chain looking for the pane's PTY pid. Matching
on cwd alone would be ambiguous the moment two panes sit in the same repo.

## Persistence

`store/persist.ts` mirrors the layout to `~/.torc/state.json` (write-then-rename, so a crash can't
leave a truncated file). The renderer subscribes to its own store and saves on a 600ms debounce,
comparing only the fields that affect a restore — a busy fleet updates snapshots several times a
second and none of that churn matters.

On restore, an agent is resumed with `claude --resume` **only if its transcript still exists**.
Resuming a session with no transcript fails, which is the normal state for an agent that never took
a turn — so those panes come back as a fresh agent in the right repo instead. Restoring the layout is
the goal; a missing pane or a pane that dies on arrival are both worse.

`restore()` guards on a module-level flag rather than `panes.length`, because it awaits and React's
StrictMode invokes the mount effect twice — both calls would otherwise see an empty fleet and every
pane would come back doubled.

## Notifications

`notify.ts` fires on the *transition* into needing attention, never repeatedly, and never while the
window is focused — the pane you're already watching shouldn't interrupt you. The dock badge carries
the waiting count and clears on window focus; clicking a notification focuses the window and jumps to
that pane.

## Renderer notes

- **Theme switching** is two layers of CSS custom properties: `--t-*` holds the active theme's raw
  values and swaps on `[data-theme]`; Tailwind's `--color-*` namespace points at those. The
  indirection resolves at runtime, so switching restyles every utility class with no rebuild.
- **PTY output is coalesced** at 4ms in `SessionManager` — terminal output arrives in tiny bursts and
  one IPC message per burst is wasteful.
- **A pane's terminal is created once.** Theme and focus changes are separate effects so switching
  themes never tears down scrollback.
- **The output bus** (`renderer/term/bus.ts`) buffers per session id, because a PTY starts producing
  output before its React component has mounted.
