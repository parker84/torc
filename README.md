# Torc

A fleet console for CLI coding agents. Run several Claude Code sessions side by side, see at a glance
which one is working and which one is blocked on you, and drive all of it from ⌘K.

Torc is **not** an editor. Keep editing in VS Code or Cursor. Torc is the layer above the terminal
that the multi-agent workflow is missing.

## Why

Running four or five agents in parallel doesn't make you four or five times faster — it makes you a
bad scheduler for four or five processes that each need your attention at unpredictable moments. One
finishes and sits idle for ten minutes. One is stuck on a permission prompt. You find out by cycling
through terminal tabs.

## What works today

- **Real terminals.** `node-pty` + xterm.js with the WebGL renderer, so any CLI works: `claude`,
  `codex`, plain `zsh`.
- **Live fleet monitoring.** Every agent's status, current tool call, git branch, token count and
  rough cost — and an amber **needs you** flag the moment an agent asks for permission.
- **Mission Control** (`⌘0`) — every agent as a card, sorted so whoever needs you is first.
- **⌘K for everything** — spawn, jump, switch themes, with `@` to jump straight to an agent.
- **Three themes** — Notion (light), Synthwave (cyberpunk), Matrix.

Monitoring reads Claude Code's own structured surfaces rather than scraping the terminal: hooks for
instant state changes, the session transcript for detail, and `claude agents --json` to reconcile and
to discover agents you started by hand. See [docs/architecture.md](docs/architecture.md).

## Running it

```bash
npm install          # rebuilds node-pty against Electron
npm run icon         # generates build/icon.icns (no image deps needed)
npm run dev
```

| Key | Action |
|---|---|
| `⌘T` | New terminal (a login shell — run `claude` yourself and Torc will pick it up) |
| `⇧⌘T` | New agent (Claude Code) |
| `⌘K` | Command palette |
| `⌘0` | Mission Control |
| `⌘⇧[` / `⌘⇧]` | Previous / next agent |
| `⌘1`–`⌘9` | Jump to agent |
| `⌃⌘T` | Cycle theme |
| `⌘W` | Close pane |

`npm run dist` produces a real `Torc.app` (the dev build reports itself as "Electron" in the menu
bar, because macOS reads that from Electron's own signed bundle).

## Development

```bash
npm run typecheck
npm test                                  # vitest
TORC_QA=/tmp/shots npm run dev            # screenshots itself, 10 steps
TORC_DEMO=/tmp/demo npm run dev           # launches a real fleet across repos, read-only
TORC_DEBUG_HOOKS=1 npm run dev            # log every hook event received
```

The QA and demo harnesses drive the renderer through `window.__torc` and capture with
`webContents.capturePage()`, which works regardless of which window is frontmost.

## Status

Early. Terminals, Cmd-K, themes and the monitoring layer work. Not yet built: split panes, session
persistence across restarts, cross-agent context sharing, and adapters that give non-Claude agents
the same monitoring depth.

Apache-2.0.
