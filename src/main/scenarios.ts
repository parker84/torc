import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Walks Torc through the things a person actually does in a session and asserts
 * the result of each, rather than screenshotting and eyeballing. Run with:
 *
 *   TORC_SCENARIOS=/tmp/scenarios npm run dev
 *
 * Every check prints PASS or FAIL with what it expected, so a regression is
 * obvious in the log without opening a single image.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`[scenario] PASS  ${name}`)
  } else {
    failed++
    console.log(`[scenario] FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

export async function runScenarios(win: BrowserWindow, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true })

  const js = async <T>(code: string): Promise<T> =>
    (await win.webContents.executeJavaScript(code, true)) as T
  const state = async () => js<Record<string, unknown>>(`window.__torc.report()`)
  const shot = async (name: string) => {
    const image = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), image.toPNG())
  }

  // ── opening terminals ────────────────────────────────────────────────────
  await js(`window.__torc.store.getState().newSession({ kind: 'shell' })`)
  await delay(2500)
  await js(`window.__torc.store.getState().newSession({ kind: 'shell' })`)
  await delay(2500)
  await js(`window.__torc.store.getState().newSession({ kind: 'shell' })`)
  await delay(2500)

  let s = await state()
  check('three terminals open', s.paneCount === 3, `got ${s.paneCount}`)
  const titles = await js<string[]>(
    `window.__torc.store.getState().panes.map(p => p.title)`,
  )
  check('pane titles are distinct', new Set(titles).size === 3, titles.join(','))

  // ── jumping ──────────────────────────────────────────────────────────────
  const ids = await js<string[]>(`window.__torc.store.getState().panes.map(p => p.id)`)
  await js(`window.__torc.store.getState().focusIndex(0)`)
  await delay(300)
  await js(`window.__torc.store.getState().focusIndex(2)`)
  await delay(300)
  s = await state()
  check('⌘3 focuses the third pane', s.activeId === ids[2], String(s.activeId))

  await js(`window.__torc.store.getState().jumpBack()`)
  await delay(300)
  s = await state()
  check('⌃⇥ returns to the previous pane', s.activeId === ids[0], String(s.activeId))

  await js(`window.__torc.store.getState().jumpBack()`)
  await delay(300)
  s = await state()
  check('⌃⇥ again goes back the other way', s.activeId === ids[2], String(s.activeId))

  await js(`window.__torc.store.getState().cyclePane(1)`)
  await delay(300)
  s = await state()
  check('⌘⇧] wraps past the end', s.activeId === ids[0], String(s.activeId))

  await js(`window.__torc.store.getState().cyclePane(-1)`)
  await delay(300)
  s = await state()
  check('⌘⇧[ wraps backwards', s.activeId === ids[2], String(s.activeId))

  // ── views ────────────────────────────────────────────────────────────────
  await js(`window.__torc.store.getState().setView('mission')`)
  await delay(500)
  check('mission control opens', (await state()).view === 'mission')
  await shot('scenario-mission')
  await js(`window.__torc.store.getState().setView('workspace')`)
  await delay(400)
  check('and closes again', (await state()).view === 'workspace')

  // ── splits ───────────────────────────────────────────────────────────────
  for (const size of [2, 4, 1] as const) {
    await js(`window.__torc.store.getState().setGridSize(${size})`)
    await delay(1200)
    const grid = await js<number>(`window.__torc.store.getState().gridSize`)
    check(`grid size ${size}`, grid === size, `got ${grid}`)
    if (size !== 1) await shot(`scenario-grid-${size}`)
  }

  // Panes must physically shrink, not merely be told to. Hidden panes keep the
  // full-width slot, so a real 2-up puts at least one screen near half width.
  const widths = async () =>
    js<number[]>(
      `[...document.querySelectorAll('.xterm-screen')].map(e => Math.round(e.getBoundingClientRect().width))`,
    )

  await js(`window.__torc.store.getState().setGridSize(1)`)
  await delay(1500)
  const wide = await widths()
  await js(`window.__torc.store.getState().setGridSize(2)`)
  await delay(1800)
  const narrow = await widths()
  const widest = Math.max(...wide, 1)
  check(
    'terminals physically reflow when the grid changes',
    narrow.some((w) => w > 0 && w < widest * 0.6),
    `full=${wide.join('/')} split=${narrow.join('/')}`,
  )
  await js(`window.__torc.store.getState().setGridSize(1)`)
  await delay(800)

  // ── themes ───────────────────────────────────────────────────────────────
  const startTheme = (await state()).theme
  await js(`window.__torc.store.getState().cycleTheme()`)
  await delay(400)
  const midTheme = (await state()).theme
  check('⌥⌘T changes the theme', midTheme !== startTheme, `${startTheme} → ${midTheme}`)
  await js(`window.__torc.store.getState().cycleTheme()`)
  await delay(300)
  await js(`window.__torc.store.getState().cycleTheme()`)
  await delay(400)
  check('cycling three times returns to the start', (await state()).theme === startTheme)

  const applied = await js<string>(`document.documentElement.dataset.theme ?? ''`)
  check('the DOM carries the active theme', applied === startTheme, applied)

  // ── find ─────────────────────────────────────────────────────────────────
  const active = (await state()).activeId as string
  await js(
    `window.__torc.store.getState().sendToPane(${JSON.stringify(active)}, 'echo TORCFINDME_TOKEN')`,
  )
  await delay(2500)
  const found = await js<boolean>(
    `window.__torcSearch.findInPane(${JSON.stringify(active)}, 'TORCFINDME_TOKEN', window.__torc.store.getState().theme, 'next').found`,
  )
  check('⌘F finds text in the scrollback', found === true)
  const missing = await js<boolean>(
    `window.__torcSearch.findInPane(${JSON.stringify(active)}, 'NOTHING_LIKE_THIS_XYZ', window.__torc.store.getState().theme, 'next').found`,
  )
  check('and reports a miss honestly', missing === false)

  // ── closing ──────────────────────────────────────────────────────────────
  const before = (await state()).paneCount as number
  await js(`window.__torc.store.getState().closePane()`)
  await delay(1200)
  s = await state()
  check('⌘W closes a pane', s.paneCount === before - 1, `got ${s.paneCount}`)
  const stillValid = await js<boolean>(
    `(() => { const s = window.__torc.store.getState(); return s.panes.some(p => p.id === s.activeId); })()`,
  )
  check('focus lands on a surviving pane', stillValid === true)

  await js(`window.__torc.store.getState().closePane()`)
  await delay(1000)
  await js(`window.__torc.store.getState().closePane()`)
  await delay(1000)
  s = await state()
  check('closing the last pane empties the fleet', s.paneCount === 0, `got ${s.paneCount}`)
  check('and clears the active pane', s.activeId === null, String(s.activeId))
  await shot('scenario-empty')

  // Opening again after emptying must still work.
  await js(`window.__torc.store.getState().newSession({ kind: 'shell' })`)
  await delay(2500)
  check('a new terminal opens after emptying', (await state()).paneCount === 1)

  // ── following the directory ──────────────────────────────────────────────
  // A pane that cd's somewhere else has to say so: the rail subtitle, the title
  // strip and the Mission Control card all read the pane's cwd, and a fleet of
  // panes all still labelled with the repo they were born in is unreadable.
  const pane = async () => js<{ cwd: string; title: string }>(
    `(() => { const p = window.__torc.store.getState().panes.at(-1); return { cwd: p.cwd, title: p.title }; })()`,
  )
  const born = await pane()
  const wanderer = (await state()).activeId as string
  await js(`window.__torc.store.getState().sendToPane(${JSON.stringify(wanderer)}, 'cd /tmp')`)
  // Longer than one poll interval, plus room for the shell to get there.
  await delay(4000)
  const moved = await pane()
  check(
    'a pane that cd\'s reports its new directory',
    moved.cwd.endsWith('/tmp') && moved.cwd !== born.cwd,
    `${born.cwd} → ${moved.cwd}`,
  )
  check('and relabels itself after it', moved.title === 'tmp', moved.title)

  // The repo you're in is the repo you mean — ⌘T follows the pane you're looking
  // at rather than handing out the folder the first pane happened to open in.
  await js(`window.__torc.store.getState().newSession({ kind: 'shell' })`)
  await delay(2500)
  const opened = await pane()
  check('a new terminal opens where you are now', opened.cwd === moved.cwd, opened.cwd)

  console.log(`[scenario] ${passed} passed, ${failed} failed`)
}
