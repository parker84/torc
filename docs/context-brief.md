# Torc — context brief

*A fleet console for CLI coding agents. Written 2026-07-26 as a pasteable summary of motivation,
scope, inspiration and technical design.*

---

## The one-liner

Torc is a terminal-first workspace for running many CLI coding agents at once — see what every agent
is doing, know instantly which one is blocked on you, and drive the whole thing from a Cmd-K palette.

## The motivation (the actual frustration)

I run several Claude Code sessions in parallel — one per repo, sometimes several on the same repo.
Today that happens in Warp, and two things break down:

**1. The terminal is not a control surface.** There's no Cmd-K. Changing anything about the
environment — splitting a pane, switching a theme, jumping to a session — means reaching for the
mouse or hunting through menus. Every modern tool I like has taught me to expect that one keystroke
opens everything; a terminal is the one place I still can't do that.

**2. I have no idea what my agents are doing.** This is the real pain. With four or five agents
running, the only way to know their state is to cycle through tabs and read. So:

- An agent finishes and sits idle for ten minutes before I notice.
- An agent is blocked on a permission prompt and I don't know, so it just... waits.
- I can't tell at a glance which agent is actually working versus stalled versus done.
- Cost and token usage are invisible until I go looking.

The failure mode is that **I become the bottleneck**, and I'm a bad one — I poll manually, at random
intervals, and miss things. Parallel agents should mean more throughput; instead the coordination
overhead eats the gains.

**3. Agents work blind to each other.** Two agents on the same repo can edit the same file with no
idea the other exists. Context one agent worked hard to build up is unavailable to its siblings, so
the second agent re-derives it from scratch. This is the stretch goal, but it's the one that
genuinely doesn't exist anywhere yet.

## What we're building

Deliberately **not** a VS Code competitor. Editing stays in VS Code/Cursor. Torc is the missing layer
*above* the terminal:

1. **Multi-pane agent terminals** — real PTYs, so any CLI agent works (Claude Code, Codex, plain
   shells). You work inside it, not beside it.
2. **A live fleet monitor** — every agent's status, current tool call, elapsed time, tokens/cost,
   branch, and a "needs you" flag that fires the moment an agent asks for permission. Mission
   Control view sorts by who needs attention.
3. **Cmd-K for everything** — spawn an agent, jump to one, send a slash command, broadcast a prompt
   to all of them, switch themes, split panes.
4. **Cross-agent context sharing** (stretch) — a shared context bus every agent can read and write,
   plus collision detection when two agents touch the same file.
5. **Three themes worth looking at** — the terminal is where I spend my day.

## Where the inspiration comes from

- **Linear** — for Cmd-K. Linear proved a command palette can *be* the interface rather than a
  shortcut to it: keyboard-first, fuzzy, context-aware, and fast enough that you stop using the
  mouse. That's the model for Torc's palette, including prefix modes (`@` to jump to an agent, `/`
  to send a slash command, `!` to broadcast to the fleet).
- **Notion** — for the default light theme. Warm white (`#ffffff` / `#f7f6f3`), soft grey borders,
  near-black text (`#37352f`), one confident blue accent. Most dev tools assume you want dark;
  sometimes I want to work in daylight and not feel like I'm in a bunker.
- **SynthWave '84 / cyberpunk VS Code themes** — for the dark theme. Deep purple-black (`#1a1425`),
  hot magenta (`#f92aad`), cyan (`#36f9f6`), mint (`#72f1b8`), purple selection. This is the theme
  I've actually been using in VS Code for years.
- **The Matrix** — for the third theme. True black, phosphor green (`#00ff41`), monospace
  everywhere. Watching several autonomous agents stream output at once genuinely feels like this, so
  the theme is a bit of a joke that also happens to be the right aesthetic.
- **Warp** — for terminal quality and the bar on feel. It's what I use now; it's good, it just has
  no Cmd-K and no concept of a fleet.
- **F1 pit wall** — for the mental model, and the name. A pit wall is a row of engineers watching
  live telemetry from several cars at once, deciding which one to call in. That's exactly the job.
  (A *torc* is also the mechanical sense of turning — what actually drives the thing.)

## What already exists, and why there's still room

Three products occupy this space, and it's churning:

| Product | What it is | Status |
|---|---|---|
| **Conductor** | Mac app, parallel Claude Code + Codex in git worktrees, dashboard + diff review | Active — closest competitor |
| **Crystal** (Stravu) | MIT Electron app, parallel sessions in worktrees | Deprecated Feb 2026 → paid successor Nimbalyst |
| **Vibe Kanban** | Web kanban over multiple agents (Rust + TS) | Bloop shut down April 2026; community OSS since |

All three are **dashboard-first**: you launch work, leave, come back, review diffs. None of them is a
terminal you'd want to live in. So the wedge is specific:

1. **Terminal-first, not dashboard-first** — the fleet view is a layer over real panes, not a
   replacement for them.
2. **Cmd-K as the control surface** — every competitor is mouse-and-panel driven.
3. **Cross-agent context sharing** — nobody does this.
4. **A terminal that's actually nice to look at.**

---

## Technical design

### The key insight: Claude Code already exposes everything we need

The hard part of monitoring a TUI agent looks like it should be screen-scraping the terminal. It
isn't — Claude Code has structured surfaces for all of it. Verified against the installed CLI:

| Surface | What it gives us |
|---|---|
| `claude agents --json` | Live registry of **every** session — `pid`, `cwd`, `sessionId`, `name`, `status: busy\|idle`, `startedAt`. Includes sessions Torc didn't launch. |
| `claude --session-id <uuid>` | We assign the UUID at spawn, so we know the transcript path before the agent says a word. |
| `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` | The full transcript. Contains `ai-title` (Claude's own generated title for the conversation — perfect card labels), per-message `usage` (input/output/cache tokens → cost), `model`, `tool_use` blocks, `gitBranch`, `permissionMode`. |
| `claude --settings <file>` | Injects hooks **per session**, without touching the user's global `~/.claude/settings.json`. |
| `claude --mcp-config <file>` | Injects an MCP server into every agent — the transport for context sharing. |
| `claude -w/--worktree` | Isolated git worktree per agent, built in. |
| `~/.claude/ide/<port>.lock` | Documented IDE handshake — Torc can register as an "IDE" and receive diffs natively. |

**So: no TUI scraping anywhere.** Hooks give fast state transitions, the JSONL gives rich detail,
`agents --json` reconciles and discovers. The PTY is only responsible for pixels and keystrokes.

### Architecture

```
main process (node)
├─ SessionManager      node-pty; spawns claude with an assigned --session-id
├─ Bridge              HTTP on 127.0.0.1:<ephemeral>, token-guarded  ← hook events
├─ TranscriptTailer    byte-offset incremental reads of the session JSONL
├─ AgentsPoller        `claude agents --json` every 2s → reconcile + discover
└─ StatusReducer       merges all three into one AgentSession per agent
        ↕ typed IPC (contextBridge preload)
renderer (React 19 + zustand)
├─ Rail · PaneGrid · TerminalPane (xterm.js + WebGL)
├─ MissionControl (⇧⌘M) · Inspector (⌘I)
└─ Cmd-K palette + command registry
```

Main owns the truth and pushes deltas; the renderer never touches the filesystem.

### Stack

Electron + electron-vite + React 19 + TypeScript + Tailwind v4, `node-pty` for PTYs, `xterm.js` with
the WebGL renderer, zustand for state, vitest for tests.

Electron over Tauri specifically because `node-pty` + `xterm.js` is the proven combination (VS Code,
Hyper, Cursor all ship it) and high-frequency PTY output doesn't have to cross a Rust↔JS IPC
boundary. The cost is bundle size and idle RAM, which is the right trade for a tool I keep open all
day.

### Status model

`launching → idle → working → needs-input → working → idle → exited | error`

Three sources, merged:

- **Hooks** are the authoritative edges: `UserPromptSubmit`/`PreToolUse` → working, `PostToolUse` →
  tool finished, `Notification` → **needs-input**, `Stop` → turn complete, `SessionEnd` → exited.
- **`claude agents --json`** reconciles every 2s, catching missed events and discovering sessions
  started outside Torc.
- **The transcript** supplies detail only: title, tool arguments, tokens, cost, files touched.

**"Needs attention"** — the thing that fixes the core frustration — is `needs-input`, *or* turn
complete and unread, *or* a nonzero exit. It drives a badge in the rail, a dock badge, a native
notification, and `⇧⌘A` ("jump to the next agent that needs me").

### The hook bridge

Each agent gets one hook command per event, injected via a generated settings file:

```
curl -s -m 0.3 -X POST -H 'content-type: application/json' \
  --data-binary @- "$TORC_HOOK_URL" >/dev/null 2>&1 || true
```

`curl` rather than a Node script because startup cost matters on a hot path (~5ms vs ~40ms), and the
`-m 0.3` + `|| true` means a dead or slow Torc can never hang or break an agent. The hook payload
already carries `hook_event_name`, `session_id`, `cwd`, `tool_name` and `tool_input`, so one command
handles every event type.

### A detail that mattered more than expected

A GUI-launched Electron app inherits a bare `PATH`, and `claude` lives in `~/.local/bin` — so it's
simply invisible to the app. Torc resolves the user's real login-shell environment once at startup
(`$SHELL -lic env`) and reuses it for every PTY. Without this, panes work in `npm run dev` and fail
in the packaged app.

### Context sharing (the stretch goal, made cheap)

Because `--mcp-config` can inject an MCP server into every agent, context sharing doesn't need any
prompt hacking. A local `torc-mcp` stdio server backed by SQLite exposes `fleet_status`,
`fleet_note_post`, `fleet_note_read` and `fleet_ask` — so an agent can ask what its siblings are
doing, leave notes for them, or ask one a direct question. Separately, a `PreToolUse` hook on
Edit/Write records the target path, which gives **file-collision detection**: the UI warns (or the
hook outright blocks) when two agents are about to touch the same file.

### Roadmap

- **M0 — Scaffold + one real terminal.** Electron/Vite/React/Tailwind, node-pty + xterm WebGL, all
  three themes, Cmd-K palette. *Done when `claude` runs inside Torc and the themes look right.*
- **M1 — Fleet + monitoring.** Assigned session IDs, hook bridge, transcript tailer, agents poller,
  status reducer, rail with live status, attention notifications. *Done when four agents run side by
  side and I get pinged the moment one asks for permission.*
- **M2 — Mission Control + full Cmd-K.** Card grid with tools/tokens/cost sorted by attention, all
  palette prefix modes, splits, session persistence and resume. *Done when it beats Warp.*
- **M3 — Context sharing.** `torc-mcp` server, shared notes, cross-agent questions, file-collision
  detection.
- **M4 — Backlog.** Register as an IDE for native diff review, session replay, natural-language
  Cmd-K, adapters for Codex/Gemini/aider, remote/SSH panes.

### Status

**Tracked in [plan-of-attack.md](plan-of-attack.md), not here.** This document is a snapshot of
intent from 2026-07-26 and is deliberately left that way; the plan is the living one. As of
2026-07-29, M0 through M2 have shipped and M3 is parked pending the design questions in issue #1.

For the record, what "right now" meant on the day this was written: M0 in progress. Electron 43 +
React 19.2 + Tailwind 4.3 scaffolded, `node-pty` rebuilt against the Electron ABI,
main/preload/renderer wired with typed IPC, all three themes defined, PTY output coalesced at 4ms to
keep IPC off the hot path, Cmd-K registry and fuzzy matcher in.

Repo: `github.com/parker84/torc` (Apache-2.0).
