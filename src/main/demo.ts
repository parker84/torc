import type { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Spins up a real fleet across several repos so the monitoring layer can be
 * seen doing its job — and so screenshots show genuine activity rather than
 * fixtures.
 *
 *   TORC_DEMO=/tmp/demo npm run dev
 *
 * Every agent runs with `--permission-mode plan`, which means read-only tools:
 * plenty of Read/Grep/Bash activity to watch, no chance of an agent editing a
 * repo while nobody's supervising it.
 */
interface DemoAgent {
  repo: string
  prompt: string
}

const AGENTS: DemoAgent[] = [
  {
    repo: 'opendata',
    prompt:
      'Map this repo: list the main entry points and summarize in 5 bullets what each is responsible for.',
  },
  {
    repo: 'made-in-canada-web',
    prompt: 'Find every TODO and FIXME comment in this repo and group them by theme.',
  },
  {
    repo: 'torcrime-web',
    prompt: 'Summarize the data model and where crime data enters the app.',
  },
  {
    repo: 'trace-backend',
    prompt: 'What are the three riskiest pieces of code here and why? Read before you answer.',
  },
  {
    repo: 'daily-brief',
    prompt: 'List the external services this project depends on and where each is configured.',
  },
]

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function capture(win: BrowserWindow, dir: string, name: string): Promise<void> {
  const image = await win.webContents.capturePage()
  writeFileSync(join(dir, `${name}.png`), image.toPNG())
  console.log(`[demo] captured ${name}`)
}

/**
 * Runs a snippet in the renderer, logging rather than throwing: one bad step
 * must not strand the whole run with no screenshots.
 */
async function run(win: BrowserWindow, code: string): Promise<unknown> {
  try {
    return await win.webContents.executeJavaScript(code, true)
  } catch (error) {
    console.log(`[demo] step failed: ${String(error)}`)
    return undefined
  }
}

export async function runDemo(win: BrowserWindow, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  const side = join(homedir(), 'Documents', 'side')
  const available = AGENTS.filter((agent) => existsSync(join(side, agent.repo)))

  console.log(`[demo] launching ${available.length} agents`)

  // Stagger the launches: five Claude Code boots at once thrashes the CPU and
  // makes the first screenshots look artificially slow.
  const ids: string[] = []
  for (const agent of available) {
    const cwd = join(side, agent.repo)
    const id = (await run(
      win,
      `(async () => {
        await window.__torc.store.getState().newSession({
          kind: 'claude',
          cwd: ${JSON.stringify(cwd)},
          permissionMode: 'plan',
        });
        return window.__torc.store.getState().activeId;
      })()`,
    )) as string | undefined
    if (id) ids.push(id)
    else console.log(`[demo] failed to launch ${agent.repo}`)
    await delay(2500)
  }

  // Five Claude Code TUIs booting at once are slow; typing before the prompt
  // box exists silently drops the text, which is how four of five agents ended
  // up idle on the first run.
  await delay(20000)
  await capture(win, outDir, 'demo-01-booted')

  const submit = async (id: string, prompt: string) => {
    // Text first, Enter separately: a single bulk write can be taken for a
    // paste, which doesn't submit.
    await run(win, `window.torc.sessions.write(${JSON.stringify(id)}, ${JSON.stringify(prompt)})`)
    await delay(700)
    await run(win, `window.torc.sessions.write(${JSON.stringify(id)}, '\\r')`)
  }

  for (const [index, agent] of available.entries()) {
    const id = ids[index]
    if (!id) continue
    await submit(id, agent.prompt)
    await delay(1200)
  }

  // Confirm each agent actually started a turn, and nudge any that didn't.
  await delay(12000)
  const report = JSON.parse(
    (await run(win, `JSON.stringify(window.__torc.report())`)) as string,
  ) as { panes: Array<{ title: string; tokens: number }> }

  for (const [index, agent] of available.entries()) {
    const id = ids[index]
    const pane = report.panes[index]
    if (!id || !pane || pane.tokens > 0) continue
    console.log(`[demo] ${agent.repo} never started; resubmitting`)
    await submit(id, agent.prompt)
    await delay(1000)
  }

  console.log('[demo] prompts submitted; letting the fleet work')

  // Capture the fleet mid-flight, in each theme, a few times as work progresses.
  const shots: Array<{ name: string; js?: string; waitMs: number }> = [
    {
      name: 'demo-02-matrix-mission',
      js: `window.__torc.store.getState().setTheme('matrix'); window.__torc.store.getState().setView('mission')`,
      waitMs: 20000,
    },
    { name: 'demo-03-matrix-mission-later', waitMs: 40000 },
    // Plan-mode agents finish by asking permission to leave plan mode, which
    // fires Notification — so the later shots should show amber "needs you".
    { name: 'demo-04-matrix-blocked', waitMs: 50000 },
    {
      name: 'demo-05-matrix-workspace',
      js: `window.__torc.store.getState().setView('workspace')`,
      waitMs: 6000,
    },
    {
      name: 'demo-05-synthwave-mission',
      js: `window.__torc.store.getState().setTheme('synthwave'); window.__torc.store.getState().setView('mission')`,
      waitMs: 20000,
    },
    {
      name: 'demo-06-synthwave-palette',
      js: `window.__torc.store.getState().setView('workspace'); window.__torc.store.getState().setPalette(true)`,
      waitMs: 1200,
    },
    {
      name: 'demo-07-notion-mission',
      js: `window.__torc.store.getState().setPalette(false); window.__torc.store.getState().setTheme('notion'); window.__torc.store.getState().setView('mission')`,
      waitMs: 12000,
    },
  ]

  for (const shot of shots) {
    if (shot.js) await run(win, shot.js)
    await delay(shot.waitMs)
    await capture(win, outDir, shot.name)
    console.log(`[demo] state ${await run(win, `JSON.stringify(window.__torc.report())`)}`)
  }
}
