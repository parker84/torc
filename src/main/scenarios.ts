import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Walks Torc through the things a person actually does in a session and asserts
 * the result of each, rather than screenshotting and eyeballing. Run with:
 *
 *   npm run scenarios
 *
 * Every check prints PASS or FAIL with what it expected, so a regression is
 * obvious in the log without opening a single image — and the counts come back
 * to the caller so a red run can set a non-zero exit code. Printing a failure
 * nobody's exit code reflects is how 23 assertions sat here unable to speak.
 */
export interface ScenarioResult {
  passed: number
  failed: number
}

/**
 * The bits of main the harness can't reach from the renderer. A second window is
 * a main-process object, and "did closing it take its ptys with it" is a question
 * only the SessionManager can answer.
 */
export interface ScenarioDeps {
  windows(): BrowserWindow[]
  liveSessions(): number
  /** How many workspaces the saved layout currently holds. */
  savedWindows(): number
}
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

export async function runScenarios(
  win: BrowserWindow,
  outDir: string,
  deps: ScenarioDeps,
): Promise<ScenarioResult> {
  mkdirSync(outDir, { recursive: true })

  const js = async <T>(code: string): Promise<T> =>
    (await win.webContents.executeJavaScript(code, true)) as T
  const state = async () => js<Record<string, unknown>>(`window.__torc.report()`)
  const shot = async (name: string) => {
    const image = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), image.toPNG())
  }

  // ── a known starting point ───────────────────────────────────────────────
  // Session restore runs on mount, so on a machine with a saved layout the
  // harness would be counting the user's panes as well as its own: three ⌘T's on
  // top of one restored pane is four, and every count, title and wrap assertion
  // after it goes red for a reason that has nothing to do with the code. Restore
  // may still be in flight when we get here, so only a zero that *holds* counts.
  const paneCount = async () => (await state()).paneCount as number
  let empty = false
  for (let attempt = 0; attempt < 10 && !empty; attempt++) {
    await js(`(async () => {
      const store = window.__torc.store
      while (store.getState().panes.length) await store.getState().closePane()
    })()`)
    await delay(600)
    if ((await paneCount()) === 0) {
      await delay(600)
      empty = (await paneCount()) === 0
    }
  }
  // Named, so a failure here reads as "the harness never got a clean slate"
  // rather than surfacing as six mysterious count mismatches further down.
  check('the fleet starts empty', empty, `got ${await paneCount()}`)

  // Closing the panes isn't the whole of it. `restore()` opens each saved pane
  // through newSession, which records `lastCwd` — so a layout saved by the *last*
  // run keeps feeding the directory fallback after its panes are gone, and the
  // cd assertions at the bottom then start from wherever that run happened to
  // finish. Reset it so the run doesn't depend on the one before it.
  await js(`window.__torc.store.setState({ lastCwd: null, recent: [] })`)

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

  // Exercise the browser interaction, not just the store action. Dropping on
  // the lower half of the last row moves the first pane to the end; that order
  // is also what the number shortcuts and persisted layout consume.
  const draggedOrder = await js<string[]>(`(async () => {
    const source = document.querySelector('[data-pane-id=${JSON.stringify(ids[0])}]')
    const target = document.querySelector('[data-pane-id=${JSON.stringify(ids[2])}]')
    if (!source || !target) return []
    const transfer = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }))
    await new Promise(requestAnimationFrame)
    const box = target.getBoundingClientRect()
    const options = { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: box.bottom - 1 }
    target.dispatchEvent(new DragEvent('dragover', options))
    target.dispatchEvent(new DragEvent('drop', options))
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
    await new Promise(requestAnimationFrame)
    return window.__torc.store.getState().panes.map((pane) => pane.id)
  })()`)
  check(
    'dragging a fleet tab changes its order',
    draggedOrder.join(',') === [ids[1], ids[2], ids[0]].join(','),
    draggedOrder.join(','),
  )

  // Leave the rest of this long scenario in its known original order.
  await js(
    `window.__torc.store.getState().reorderPane(${JSON.stringify(ids[0])}, ${JSON.stringify(ids[1])}, 'before')`,
  )

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

  // ── naming a pane yourself ───────────────────────────────────────────────
  // The title staying put while the location moves is only defensible if the
  // title can be fixed by hand — so a rename has to outlast the next cd, and
  // has to be undoable without knowing what the pane was called before.
  const paneById = async (id: string) =>
    js<{ cwd: string; title: string; renamed?: boolean }>(
      `(() => { const p = window.__torc.store.getState().panes.find((p) => p.id === ${JSON.stringify(id)}); return { cwd: p.cwd, title: p.title, renamed: p.renamed }; })()`,
    )
  await js(
    `window.__torc.store.getState().renamePane(${JSON.stringify(wanderer)}, 'the deploy box')`,
  )
  await delay(400)
  const named = await paneById(wanderer)
  check('a pane takes the name you give it', named.title === 'the deploy box', named.title)

  await js(`window.__torc.store.getState().sendToPane(${JSON.stringify(wanderer)}, 'cd /usr')`)
  await delay(4000)
  const stillNamed = await paneById(wanderer)
  check(
    'and keeps it when the pane cds somewhere else',
    stillNamed.title === 'the deploy box' && stillNamed.cwd.endsWith('/usr'),
    `${stillNamed.title} in ${stillNamed.cwd}`,
  )

  await js(`window.__torc.store.getState().renamePane(${JSON.stringify(wanderer)}, '   ')`)
  await delay(400)
  const unnamed = await paneById(wanderer)
  check(
    'an emptied name hands the pane back to Torc',
    unnamed.title === 'usr' && !unnamed.renamed,
    unnamed.title,
  )

  // The pointer route to the same thing: ⋮ opens the pane menu, Rename opens the
  // editor in the rail.
  // Each click is followed by a beat: React commits the state change after the
  // handler returns, so querying in the same expression sees the old DOM.
  await js(`document.querySelector('[data-testid="pane-menu-button"]').click()`)
  await delay(300)
  const menuOpened = await js<boolean>(
    `Boolean(document.querySelector('[data-testid="pane-menu"]'))`,
  )
  check('the ⋮ button opens the pane menu', menuOpened === true)
  await shot('scenario-pane-menu')

  const clicked = await js<boolean>(`(() => {
    const items = [...document.querySelectorAll('[data-testid="pane-menu"] [role="menuitem"]')]
    const rename = items.find((i) => i.textContent.startsWith('Rename'))
    if (!rename) return false
    rename.click()
    return true
  })()`)
  await delay(300)
  const editing = await js<boolean>(`Boolean(document.querySelector('aside input'))`)
  check('and Rename opens the name editor in the rail', clicked === true && editing === true)

  await js(`window.__torc.store.getState().cancelRename()`)

  // ── a second window ─────────────────────────────────────────────────────
  // A window is a workspace: it owns its panes and shows nobody else's. The
  // assertions that matter are the boundary ones — a pane opened over there must
  // not appear over here, and closing the window must take its ptys with it,
  // because a pty with no window is a `claude` nobody can see or type into.
  const paneCountHere = await paneCount()
  const sessionsBefore = deps.liveSessions()

  await js(`window.torc.newWindow('shell')`)
  await delay(3000)
  const second = deps.windows().find((w) => w !== win)
  check('⌘N opens a second window', deps.windows().length === 2 && Boolean(second))
  if (!second) {
    console.log(`[scenario] ${passed} passed, ${failed} failed`)
    return { passed, failed }
  }

  const secondReport = async () =>
    (await second.webContents.executeJavaScript(`window.__torc.report()`, true)) as {
      paneCount: number
    }
  check(
    'the new window opens with one pane of its own',
    (await secondReport()).paneCount === 1,
    String((await secondReport()).paneCount),
  )
  check(
    'and the first window is untouched by it',
    (await paneCount()) === paneCountHere,
    `${await paneCount()} vs ${paneCountHere}`,
  )
  check(
    'main knows about both windows worth of panes',
    deps.liveSessions() === sessionsBefore + 1,
    `${deps.liveSessions()} vs ${sessionsBefore + 1}`,
  )
  await shot('scenario-second-window')

  // The layout has to know about it, or the second workspace is gone on relaunch.
  check(
    'the saved layout gains a workspace',
    deps.savedWindows() === 2,
    `${deps.savedWindows()} workspaces saved`,
  )

  second.close()
  await delay(2000)
  check('closing a window closes it', deps.windows().length === 1, String(deps.windows().length))
  check(
    'and takes its panes with it',
    deps.liveSessions() === sessionsBefore,
    `${deps.liveSessions()} still running, expected ${sessionsBefore}`,
  )
  check(
    'while leaving the other window alone',
    (await paneCount()) === paneCountHere,
    `${await paneCount()} vs ${paneCountHere}`,
  )
  // The counterpart to the check above, and the one that can quietly eat a
  // layout: a window the user closed must not come back, but quitting closes
  // every window and must not be read the same way. Only the first half is
  // assertable from in here — the second is why the registry asks whether the
  // app is on its way out before it writes.
  check(
    'and forgets that workspace, so it does not come back',
    deps.savedWindows() === 1,
    `${deps.savedWindows()} workspaces saved`,
  )

  console.log(`[scenario] ${passed} passed, ${failed} failed`)
  return { passed, failed }
}
