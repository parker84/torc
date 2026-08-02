# Orchestration — one lead, many agents beneath it

*Design notes and a plan of attack for the orchestrator tier. Nothing here is built. Tracked as a
single scoping ticket, #34, rather than a set of build tickets — the shape needs to settle first.
Written 2026-08-02 against Claude Code v2.1.220.*

Torc's model today is flat: one pane, one pty, one agent, keyed by `claudeSessionId`. The workflow
people keep asking for is not flat — one orchestrator that plans and delegates, several workers
beneath it. This file works out what that costs, what's already free, and where the UX should land.

## What already exists, verified

Claude Code ships **agent teams** as of v2.1.178, gated behind
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. One session is the lead; teammates are independent Claude
instances with their own context windows, a shared task list, and mailboxes they use to message each
other directly. Unlike plain subagents, you can talk to a teammate without going through the lead.

We ran a real two-teammate team and read what landed on disk. It is all structured data, so the
no-scraping invariant holds:

```
~/.claude/projects/<slug>/<leadSessionId>.jsonl        the lead: Agent, TaskCreate, TaskUpdate calls
~/.claude/projects/<slug>/<leadSessionId>/subagents/
    agent-<agentId>.jsonl                             a teammate's full transcript
    agent-<agentId>.meta.json                         {agentType, description, name, spawnDepth}
~/.claude/tasks/<leadSessionId>/<n>.json              {id, subject, activeForm, status, owner,
                                                       blocks, blockedBy}
~/.claude/teams/<leadSessionId>/inboxes/<name>.json   [{from, text, timestamp, read, msg_id}]
```

Four findings, each of which changes a decision:

**A teammate is not a session and not a process.** It is a sidechain identified by
`(leadSessionId, agentId)`. Its transcript lines carry `isSidechain: true` and the *lead's*
`sessionId`, and the lead's own transcript contains zero sidechain lines. So `claudeSessionId` no
longer identifies an agent, which is the single fact the rest of this document follows from.

**`claude agents --json` cannot see teammates at all.** No parent field, no team field — the poller
returns only the lead. `deriveStatus`'s `pollStatus` input is therefore *unavailable* for the whole
sub-tier, and hooks plus the sidechain transcript are the only sources. `SubagentStart` and
`SubagentStop` carry `agent_id`, `agent_type` and `transcript_path`, which is enough for fast state
edges; `TeammateIdle`, `TaskCreated` and `TaskCompleted` exist too.

**Torc's numbers are wrong today, not merely incomplete.** In our run the lead's transcript showed
7,655 output tokens and the teammates spent 4,159 more, in files Torc never opens — a third of the
spend invisible. The tool timeline shows `Agent` and `TaskCreate` where it should show what the
workers actually did.

**The same layout covers ordinary subagents.** A plain Task-tool subagent writes to the identical
`subagents/` path with the same meta file. So this tier lights up for *every* Claude Code session,
not only for teams. That is most of the value, and it is also the main noise risk — a routine session
that fans out five `Explore` agents must not flood the rail.

## What the competitors do

| | Model | What to take |
|---|---|---|
| [Conductor](https://conductor.build) | Deliberately flat — N parallel agents, a git worktree each, no orchestrator tier. Diffs and tests visible per agent. | Little. Torc already has worktrees via `-w`, and flatness is the thing we're trying to move past. |
| [herdr](https://herdr.dev) | A terminal multiplexer with a Unix-socket JSON-RPC API that lets an agent *call the multiplexer* — spawn a pane, spawn an agent, read another pane's output, subscribe to state events. | The API. That is the abstraction layer this whole design turns on, and Torc's hook bridge is already most of one. |

Conductor is the better-funded product and the less interesting architecture. herdr's socket is what
turns a viewer into an orchestrator, and it is the part worth borrowing.

## The decision underneath everything

**The fleet becomes a tree, and a pane stops being the same thing as an agent.**

- A **pane** is a pty. Only leads get one.
- An **agent node** is a monitored unit. Leads and children both. A child has no pty, no
  `pollStatus`, and is read-only.

Every existing invariant survives: no TUI scraping, main owns the truth, PTY output stays off the hot
path, `~/.claude/settings.json` stays untouched. `TranscriptTailer` already does byte-offset
incremental JSONL reads, so pointing it at `subagents/*.jsonl` is a generalization rather than a
rewrite.

This is the same discipline #23 already commits to — *partial support is the normal case* — applied to
a second tier. A child that reports status and tokens but has no poll status and no process must
render as a live node with those fields absent, never with a fabricated zero. That the two tickets
want the same seam is the strongest evidence the seam is in the right place, and #34 should be scoped
alongside #23 rather than after it.

`spawnDepth` is a real field in the meta file, so the tree can be deeper than two levels. Model it as
a tree; render two levels for now; do not hardcode two.

## Two models

**A — observe native teams.** The lead keeps its pane, teammates render as children. Cheap, given the
layout above. It also makes Torc the best available display for agent teams: in-process mode gives
teammates no panes at all, and split-pane mode requires tmux or iTerm2 — the docs explicitly exclude
VS Code, Windows Terminal and Ghostty. Torc is an Electron app full of real PTYs and has already
solved the problem those modes are working around.

**B — Torc as the orchestration substrate.** The herdr lever. The hook bridge is already a
token-guarded HTTP server on `127.0.0.1`; extend it into a control surface an agent can call, so an
orchestrator asks Torc for a worker and gets a **real pane, a real pty and a real session id** — a
full fleet peer, resumable, monitorable by every surface already built, and outliving the lead. This
addresses the sharpest limits of native teams head-on: in-process teammates aren't restored by
`/resume`, can't nest, and die with the lead.

**A first, then B.** A is nearly free, fixes the wrong numbers, and is the cheapest way to learn the
UX. B is the differentiated half — it is what makes Torc an orchestrator rather than a viewer — and
it depends on the same tree prerequisite, so the sequencing is natural rather than a compromise.

## The UX

**The rail gets two levels.** Children indent under their lead. No number key — ⌘1–9 is a promise
about panes and should stay one. A child row carries its name, its `agentType`, a status dot and its
current tool.

The load-bearing rule: **a lead's dot shows the worst state in its subtree.** A blocked teammate
makes the lead read blocked. Without that you expand every node hunting for the one thing waiting on
you, which is the entire job of the app. Children appear while running or blocked and collapse to a
count once finished, which is also the answer to the noise risk above.

**A child does not get a quadrant.** It has no pty, so there is nothing to render as a terminal, and
forcing one into `SLOTS` puts the "terminals are positioned, never re-parented" invariant at risk for
no gain. Clicking a child opens a transcript reader over that pane's geometry, or in a drawer.
Geometry, never structure.

**Mission Control is where the orchestrator actually lives.** Render the shared task list as the
thing it is — a DAG with owners — straight from `tasks/<leadSessionId>/*.json`. `blocks` and
`blockedBy` give the graph; `activeForm` gives a live per-teammate progress string ("Counting
README.md lines") that costs nothing to display. Add subtree token and cost roll-up, and the mailbox
as an ordered who-told-whom feed. No competitor has this view.

**The mailbox is a partial answer to #1.** Cross-agent context sharing is parked pending design, and
the messages agents send each other are already on disk in a documented format — no MCP server, no
token spend, no propagation risk, because reading is not writing. Worth re-reading #1 in that light
before designing the bus.

**Messaging stays read-only in v1.** Writing a teammate's inbox JSON would be the feature everyone
wants and is the same class of risk as editing `settings.json`: it is Claude Code's private state, and
the format has already drifted from its own documentation once (below). The sanctioned routes are the
lead's pty, or model B, where a worker has a pty of its own.

## Phases, once #34 is scoped

Deliberately not tickets yet. The order is the argument; the boundaries will move.

1. **Make the fleet a tree.** `SessionSnapshot` gains parent, agent id and agent type; the status
   reducer learns a subtree roll-up. Prerequisite for everything else.
2. **Tail sidechain transcripts.** Generalize `TranscriptTailer` onto `subagents/agent-*.jsonl` and
   its meta file. Add `SubagentStart`/`SubagentStop` to the hook settings for fast edges. This is the
   phase that fixes the token under-report.
3. **Rail tree, and the child transcript reader.**
4. **The team view in Mission Control** — task DAG, mailbox feed, cost roll-up.
5. **Torc as substrate** — the spawn API over the existing bridge. Wants its own scoping pass.

## Risks

**Agent teams are experimental and the disk shape has already drifted from the docs.** The published
docs describe the team directory as `session-` plus the first eight characters of the session id, and
a `config.json` holding a members array. v2.1.220 wrote the full session UUID and no `config.json` at
all in in-process mode; the roster had to be recovered from the `subagents/*.meta.json` files, which
is more reliable anyway. Treat every field as optional, probe the version, and never let a missing
file break a pane.

**There is still no CI and the scenario harness still cannot fail** (#14, #13). This is the first
feature here with real surface area, and #13 is cheap. It should land first.

## Open questions

These block scoping, not building:

1. **Model A alone, or A as the on-ramp to B?** It decides how much of phase 1 is worth generalizing
   now versus later.
2. **Read-only children in v1, or messaging from Torc?** If messaging, we would rather arrive at it
   through B than by writing Claude Code's mailbox files.
3. **How much of #1 does the mailbox already answer?** Possibly enough to change what the context bus
   needs to be.
