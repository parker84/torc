# Torc — current state and plan of attack

*The one place that says where this project is and what's next. Every item links to a ticket.
Last updated 2026-07-29.*

**If you are picking this repo up, read this file first.** `docs/context-brief.md` explains *why*
Torc exists and what the design is; this file is the only one that tracks *state*.

## Keeping it current

A plan document that goes stale is worse than none, because it gets believed. Two rules:

1. **Closing a ticket means checking its box here, in the same PR.** Not afterwards.
2. **A decision goes in the log below when it's made**, so it stops getting re-litigated. A settled
   question that isn't written down gets re-argued by the next agent that touches the code.

---

## Where we are

Verified 2026-07-29 against the tree, not from intent:

- `npm run typecheck` — clean.
- `npm test` — 56 tests across 8 files, all passing, ~1s. Colocated `.test.ts` beside their source.
- **M0, M1 and M2 have all shipped.** Terminals, splits, themes, ⌘K with all prefix modes, fleet
  monitoring, notifications, session restore, and the packaged build. Seven PRs merged.
- **M3 (cross-agent context sharing) is unbuilt** and parked pending design — #1.

`docs/context-brief.md` still says "M0 in progress". That's a snapshot from 2026-07-26 and it's
wrong; #15 corrects it to point here.

### What's loose right now

Three things sit in the working tree rather than in `main`:

| What | Where | Ticket |
|---|---|---|
| Agent-exit-to-shell fallback, finished but untested | `src/main/pty/SessionManager.ts:165-243` | #11 |
| A diagnostic probe marked "delete me", wired into startup | `src/main/probe.ts`, `src/main/index.ts:106-111` | #12 |
| An orphan PNG codec imported by nothing | `scripts/lib/png.mjs` | #12 |

And two gaps in the safety net:

- **The scenario harness cannot fail.** 23 assertions over real user flows, and `app.quit()` is
  called without an exit code, so all 23 can go red and the process still exits 0 — #13.
- **There is no CI.** No `.github/` at all; seven PRs have merged with nothing checking them — #14.

---

## Plan of attack

### P0 — the visible bug, and clearing the tree

The label bug is what a user actually hits. The other two are the cost of leaving finished and dead
work sitting in the same working tree; they're small and they unblock a clean diff for everything
after.

- [ ] **#8 — Pane labels don't follow `cd`.** `cwd` is captured at spawn and never updated, so four
      separate surfaces keep naming the directory you started in. Shell panes only; agent panes are
      already correct. *In progress — being picked up separately.*
- [ ] **#9 — A new pane should inherit the focused pane's live cwd.** Replaces the `lastCwd` default
      that makes a whole fleet come up in one repo. Depends on #8.
- [ ] **#11 — Land the agent-exit-to-shell fallback, with tests.** Five subtle branch conditions and
      no `SessionManager` test file exists yet.
- [ ] **#12 — Delete the diagnostic probe and the orphan PNG codec.** Its own small PR.

### P1 — so a regression can't land quietly

Everything here is cheap and none of it is a feature. It's the difference between "the tests pass on
my machine when I remember" and a net that actually catches things — which matters more than usual
when agents are opening the PRs.

- [ ] **#13 — The scenario harness can't fail the build.** Return the counts, set `process.exitCode`,
      add `npm run scenarios`. The assertions already exist and are already right; they just can't
      speak. Highest leverage item on this list.
- [ ] **#14 — CI: typecheck and tests on every PR.** One workflow, Ubuntu, skip the `node-pty`
      rebuild. Electron harnesses stay local — a runner has no signed-in `claude`.
- [x] **#15 — A plan-of-attack doc, and a CLAUDE.md that points at it.** This file, `CLAUDE.md`, and
      the stale status section in `docs/context-brief.md` redirected here. Closed by the PR that adds
      this line — which is the upkeep rule working as intended.
- [ ] **#10 — Let a pane be renamed.** The condition attached to the decision below: if the title
      stays stable while the location moves, the title has to be fixable by hand.
- [ ] **#17 — Scrolling back through a pane feels slow.** Speed and ⌥ fast-scroll landed 2026-07-29;
      the ticket stays open for the *sticky* half. `scrollLines()` still moves in whole rows, so a
      gesture is stationary until it crosses ~16px and then jumps — and whether macOS momentum events
      survive our `preventDefault()` is still unmeasured. Wants `src/main/probe.ts`, which #12
      deletes; coordinate the order.

### P2 — the wedge, and getting it into other people's hands

Both of these are scoping tickets before they're build tickets. Neither should be started while P0
work is open, and both want an explicit decision before any code.

- [ ] **#1 — Cross-agent context sharing.** The one thing none of the competitors have built, and
      the reason to be careful with it. Two separable halves: file-collision detection is cheap with
      no open questions and may carry most of the value; the shared context bus has a real unresolved
      risk around one agent's wrong conclusion propagating to four others. Ship the first, let usage
      decide on the second. Sequencing and open questions are in the ticket.
- [ ] **#23 — Define the agent adapter seam.** The blocker for every ticket below it. Monitoring is
      Claude-Code-shaped from `AgentsPoller` down, and a second agent can't be added without either
      forking those files or threading `if (agent === …)` through them. Deliverable is the interface
      plus Claude Code refactored onto it with the existing tests green — that refactor is the proof
      the seam is in the right place. The hard part is that **partial support is the normal case**: an
      agent reporting status but not tokens must render a live card with no cost, never a fabricated
      zero.
- [ ] **#24 — Codex adapter.** Depends on #23.
- [ ] **#25 — OpenCode adapter.** Depends on #23. Worth doing early despite being the least
      established of the four: it's open source, so its state surfaces can be read rather than
      reverse-engineered, and anything missing can be contributed upstream.
- [ ] **#26 — Gemini CLI adapter.** Depends on #23.
- [ ] **#27 — aider adapter.** Depends on #23, and the useful stress test of whether the seam is
      general — aider is a chat loop over a repo, not a tool-call lifecycle, so it's the one most
      likely not to fit. If it can't report state without parsing output, it gets closed won't-fix
      rather than granted an exception to the no-scraping invariant.
- [ ] **#16 — Scope what it takes to ship Torc as a real desktop app.** `npm run dist` already makes
      a working `.app` and `.dmg`; `identity: null` in `electron-builder.yml` is what stands between
      that and something a stranger can open. Signing plus notarization is the known cost (Apple
      Developer Program, hardened runtime, and a real fight between hardened runtime and `node-pty`'s
      native binding). Auto-update, a universal build and a download page are all downstream of the
      one question the ticket has to answer first: is the goal *a few people can install this*, or
      *strangers download this*?

---

## Decisions log

**2026-07-29 — Agent adapters get tickets now, ahead of M3 being decided.** This file previously said
M4 shouldn't have tickets until M3 was settled. That's now overridden for the adapter half of M4
(#23–#27). *Why:* the landing page in `torc-web` names Codex, OpenCode, Gemini CLI and aider as "runs
today · adapter next", which turns them from a backlog idea into a public commitment — and an
untracked public commitment is the thing this document exists to prevent. The rest of M4 (IDE
registration, session replay, natural-language ⌘K, remote panes) still has no tickets and still
shouldn't. *Rejected:* dropping the agent names from the site instead. They're the honest answer to
"will this work with what I run", and the site distinguishes the two support tiers explicitly rather
than implying parity. (#23–#27)

**2026-07-29 — The site states two support tiers, not one.** "Runs today" (any CLI, because the panes
are real PTYs) is kept visibly separate from "full monitoring" (needs that agent's structured surfaces
mapped). *Why:* collapsing them into "supports Codex" is a promise the first launch breaks — the pane
works and the card stays empty, which reads as a bug rather than a roadmap. The adapter interface has
to preserve this distinction at runtime too, which is why partial support is a first-class case in
#23 rather than an error path. (#23, torc-web)

**2026-07-29 — Location follows cwd, the title stays put.** When a shell pane `cd`s elsewhere, the
rail subtitle, Mission Control footer, status bar and title strip follow. The bold title does not.
*Why:* auto-renaming reads more correct but titles then shift under you mid-session, and re-running
`uniqueTitle` across the fleet means `cd`-ing one pane can renumber a different one — which pane gets
the ` 2` is arbitrary. A stable title that can read stale is the better trade, conditional on #10
making it renameable. (#8, #10)

**2026-07-29 — A new pane inherits the focused pane's live cwd.** Not `lastCwd`. *Why:* `lastCwd`
means ⌘T opens where you last *started* something rather than where you *are*; the two diverge the
moment you `cd`, and then the default is simply wrong. Inheriting is also what every other terminal
does. Falls back to `defaultCwd()` with no pane focused. (#9)

**2026-07-26 — Ship file-collision detection before the shared context bus.** *Why:* it's
independently useful, needs no MCP server and no token spend, and it validates the hook plumbing the
bus would build on. Real usage of it is also the cheapest way to learn which shared payload people
actually reach for. (#1)

---

## Milestones, for context

From `docs/context-brief.md`, with status corrected:

| | | |
|---|---|---|
| **M0** | Scaffold, one real terminal, themes, ⌘K | ✅ shipped |
| **M1** | Fleet monitoring — session ids, hook bridge, transcript tailer, poller, attention | ✅ shipped |
| **M2** | Mission Control, full ⌘K, splits, persistence and resume | ✅ shipped |
| **M3** | Cross-agent context sharing | parked on design — #1 |
| **M4** | Register as an IDE for diff review, session replay, natural-language ⌘K, agent adapters, remote panes | adapters ticketed — #23–#27; rest backlog |

The adapter half of M4 is ticketed (#23–#27) because the landing page now names those agents in
public; see the decisions log. Everything else in M4 still has no ticket, and still shouldn't until
M3 is decided.

## Related repos

| Repo | What | Visibility |
|---|---|---|
| [`parker84/torc-web`](https://github.com/parker84/torc-web) | The `torc.sh` landing page and launch waitlist. Next.js on Vercel. Ships the same three themes as the app, and quotes real numbers off `docs/screenshots/` — if those captures are replaced, the stats in its `src/lib/config.ts` move with them. | private |
