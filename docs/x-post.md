# Torc — X post drafts

Written 2026-07-26, day one of the build. Facts here are true as of M0: terminals, Cmd-K, three
themes, self-screenshotting QA harness. The monitoring layer (M1) is next, so the drafts below say
"building", not "built".

---

## Option A — single post

> I run 4–5 Claude Code agents at once. Turns out the bottleneck isn't the agents, it's me — cycling
> through terminal tabs to find the one that's been sitting blocked on a permission prompt for ten
> minutes.
>
> So I'm building the terminal I actually want. ⌘K for everything, and you can see the whole fleet.
>
> github.com/parker84/torc

## Option B — shorter, punchier

> Running 5 coding agents in parallel doesn't make you 5x faster. It makes you a very bad scheduler
> for 5 processes that all need your attention at unpredictable times.
>
> Building a terminal that fixes that part. Open source 👇

---

## Option C — thread

**1/**
> I run 4–5 Claude Code agents at once across different repos.
>
> The bottleneck isn't the agents. It's me. I'm a human polling loop, cycling through terminal tabs
> to find out who needs something.

**2/**
> The specific failures:
>
> • agent finishes, sits idle 10 min before I notice
> • agent blocked on a permission prompt, just... waiting
> • can't tell "working" from "stalled" from "done" at a glance
> • two agents editing the same file, neither knows

**3/**
> Every tool in this space is dashboard-first: launch work, leave, come back, review diffs.
>
> I don't want another dashboard. I want a terminal I can live in that happens to know what my
> agents are doing.

**4/**
> The unlock: Claude Code already exposes all of this. No screen scraping needed.
>
> `claude agents --json` → every live session, pid, cwd, busy/idle
> `--session-id` → assign the id yourself, know the transcript path up front
> hooks → instant state transitions
> transcripts → tokens, tool calls, titles

**5/**
> So hooks give you fast state edges, the transcript JSONL gives you detail, and `agents --json`
> reconciles and discovers sessions you didn't even launch.
>
> The terminal only has to handle pixels and keystrokes.

**6/**
> ⌘K does everything, Linear-style. Spawn an agent, jump to one, broadcast a prompt to the whole
> fleet, switch themes.
>
> Because the thing I actually resent about my current terminal is reaching for the mouse.

**7/**
> Three themes, because I spend all day in here:
>
> • Notion — clean white, for daylight
> • SynthWave '84 — the cyberpunk one I've used in VS Code for years
> • Matrix — black + phosphor green, which is genuinely what 5 agents streaming at once feels like

**8/**
> Stretch goal, and the part nobody's built: agents that can see each other. A shared context bus, so
> agent 3 can ask what agent 1 already figured out — plus a warning when two of them are about to
> edit the same file.

**9/**
> Called it Torc. Toronto, and the mechanical sense of torque — the thing that actually turns.
>
> Day one, Apache-2.0, very much unfinished:
> github.com/parker84/torc

---

## Notes for whoever polishes this

- Screenshots worth attaching: the Matrix theme with an agent running, and the ⌘K palette open.
  Both in `docs/screenshots/` once M1 lands.
- Don't claim the monitoring works yet — M0 is terminals + Cmd-K + themes. Tweet 4 describes the
  design, which is verified against the CLI, not shipped behaviour.
- The competitors (Conductor, Crystal→Nimbalyst, Vibe Kanban) are deliberately unnamed. Two of the
  three shut down or deprecated in 2026, so "everyone's dashboard-first" is fair but don't punch down
  by name.
