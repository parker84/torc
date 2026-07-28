import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Dev-only screenshot harness. `webContents.capturePage()` grabs the renderer's
 * own output, so it works regardless of which window is frontmost or which
 * Space is showing — unlike `screencapture`, which needs the app raised and
 * grabs whatever else is on screen.
 *
 *   TORC_QA=/tmp/shots npm run dev
 *   TORC_QA=/tmp/shots TORC_QA_EXIT=1 npm run dev   # capture then quit
 *
 * Steps drive the renderer through window.__torc, which store.ts exposes in dev.
 */
interface Step {
  name: string
  js?: string
  /** How long to settle before capturing — PTY output needs longer than UI state. */
  waitMs?: number
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const STEPS: Step[] = [
  // Force a known theme so runs are comparable regardless of what's persisted.
  { name: '01-empty', js: `window.__torc.store.getState().setTheme('notion')`, waitMs: 500 },
  {
    name: '02-terminal',
    js: `window.__torc.store.getState().newSession({ kind: 'shell' })`,
    waitMs: 2500,
  },
  {
    name: '03-agent',
    js: `window.__torc.store.getState().newSession({ kind: 'claude' })`,
    waitMs: 9000,
  },
  { name: '04-palette', js: `window.__torc.store.getState().setPalette(true)`, waitMs: 700 },
  {
    name: '05-palette-query',
    js: `window.__torc.store.getState().setPaletteQuery('agent')`,
    waitMs: 500,
  },
  {
    name: '06-mission-control',
    js: `window.__torc.store.getState().setPalette(false); window.__torc.store.getState().setView('mission')`,
    waitMs: 700,
  },
  {
    name: '07-cyberpunk',
    js: `window.__torc.store.getState().setTheme('cyberpunk'); window.__torc.store.getState().setView('workspace')`,
    waitMs: 900,
  },
  {
    name: '08-cyberpunk-mission',
    js: `window.__torc.store.getState().setView('mission')`,
    waitMs: 700,
  },
  {
    name: '09-matrix',
    js: `window.__torc.store.getState().setTheme('matrix'); window.__torc.store.getState().setView('workspace')`,
    waitMs: 900,
  },
  { name: '10-matrix-palette', js: `window.__torc.store.getState().setPalette(true)`, waitMs: 700 },
]

/**
 * Restore mode opens nothing and just waits: the panes should come back from
 * ~/.torc/state.json on their own, which is the thing being checked.
 */
const RESTORE_STEPS: Step[] = [
  { name: 'restore-01-early', waitMs: 6000 },
  { name: 'restore-02-settled', waitMs: 14000 },
]

/**
 * Splits and notifications. The notification path can only be exercised with the
 * window unfocused, which is why it blurs first — otherwise notify.ts correctly
 * stays quiet and the check would prove nothing.
 */
const SPLIT_STEPS: Step[] = [
  {
    name: 'split-01-two-terminals',
    js: `(async () => {
      const store = window.__torc.store.getState();
      await store.newSession({ kind: 'shell' });
      await store.newSession({ kind: 'shell' });
      await store.newSession({ kind: 'claude' });
      window.__torc.store.getState().setTheme('cyberpunk');
    })()`,
    waitMs: 12000,
  },
  {
    name: 'split-02-two-up',
    js: `window.__torc.store.getState().setGridSize(2)`,
    waitMs: 2500,
  },
  {
    name: 'split-03-four-up',
    js: `window.__torc.store.getState().setGridSize(4)`,
    waitMs: 2500,
  },
  {
    name: 'split-04a-palette-default',
    js: `window.__torc.store.getState().setPalette(true)`,
    waitMs: 1200,
  },
  {
    name: 'split-04-broadcast-palette',
    js: `window.__torc.store.getState().setPalette(true); window.__torc.store.getState().setPaletteQuery('!what repo is this?')`,
    waitMs: 1500,
  },
  {
    name: 'split-05-back-to-one',
    js: `window.__torc.store.getState().setPalette(false); window.__torc.store.getState().setGridSize(1)`,
    waitMs: 2000,
  },
]

/**
 * Proves the point of the claude shim: a `claude` typed by hand into a plain
 * shell pane must end up monitored exactly like one Torc launched — same hooks,
 * same status, same transcript.
 */
const SHIM_STEPS: Step[] = [
  {
    name: 'shim-01-shell',
    js: `window.__torc.store.getState().newSession({ kind: 'shell' })`,
    waitMs: 3000,
  },
  {
    name: 'shim-02-typed-claude',
    js: `(() => {
      const s = window.__torc.store.getState();
      s.sendToPane(s.activeId, 'claude');
    })()`,
    waitMs: 15000,
  },
  {
    name: 'shim-03-prompted',
    js: `(() => {
      const s = window.__torc.store.getState();
      s.sendToPane(s.activeId, 'list the files in this directory');
    })()`,
    waitMs: 25000,
  },
]

/**
 * Checks that app-level chords still work while a terminal has keyboard focus —
 * xterm attaches its own keydown handler, and if it consumes ⌘-combos the app
 * never sees them.
 */
async function checkKeys(win: BrowserWindow): Promise<void> {
  const { Menu } = await import('electron')
  const view = () =>
    win.webContents.executeJavaScript(`window.__torc.store.getState().view`, true)

  const items = (Menu.getApplicationMenu()?.items ?? [])
    .flatMap((item) => item.submenu?.items ?? [])
    .filter((item) => item.accelerator)
    .map((item) => `${item.label}=${item.accelerator}`)
  console.log(`[keys] registered: ${items.join(' | ')}`)

  // Focus the terminal the way a user would, then fire the chords at it.
  await win.webContents.executeJavaScript(
    `document.querySelector('.xterm-helper-textarea')?.focus(); document.activeElement?.className`,
    true,
  )
  const focused = await win.webContents.executeJavaScript(
    `document.activeElement?.className ?? 'none'`,
    true,
  )
  console.log(`[keys] focused element: ${focused}`)

  console.log(`[keys] view before: ${await view()}`)

  // ⌘⏎ is the primary binding, so test it from a focused terminal specifically.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['meta'] })
  await delay(800)
  console.log(`[keys] view after cmd+enter: ${await view()}`)

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['meta'] })
  await delay(800)
  console.log(`[keys] view after cmd+enter again (expect workspace): ${await view()}`)

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['meta'] })
  await delay(600)
  console.log(`[keys] view after cmd+0: ${await view()}`)

  console.log(
    `[keys] focus while in mission: ${await win.webContents.executeJavaScript(
      `document.activeElement?.className ?? 'none'`,
      true,
    )}`,
  )

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape', modifiers: [] })
  await delay(600)
  console.log(`[keys] view after injected esc: ${await view()}`)

  // A dispatched DOM event tests the handler itself, separating an app bug from
  // a quirk of how sendInputEvent is delivered.
  await win.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    true,
  )
  await delay(400)
  console.log(`[keys] view after dispatched esc: ${await view()}`)
}

export async function runQa(win: BrowserWindow, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  const mode = process.env.TORC_QA_MODE
  const steps =
    mode === 'restore'
      ? RESTORE_STEPS
      : mode === 'split'
        ? SPLIT_STEPS
        : mode === 'shim'
          ? SHIM_STEPS
          : mode === 'keys'
            ? [
                {
                  name: 'keys-01-agent',
                  js: `window.__torc.store.getState().newSession({ kind: 'claude' })`,
                  waitMs: 12000,
                },
              ]
            : STEPS

  for (const step of steps) {
    if (step.js) {
      try {
        await win.webContents.executeJavaScript(step.js, true)
      } catch (error) {
        console.log(`[qa] ${step.name} FAILED: ${String(error)}`)
        continue
      }
    }
    await delay(step.waitMs ?? 600)
    const image = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${step.name}.png`), image.toPNG())
    console.log(`[qa] captured ${step.name}`)
  }

  try {
    const report = await win.webContents.executeJavaScript(
      `JSON.stringify(window.__torc.report())`,
      true,
    )
    console.log(`[qa] report ${report}`)
  } catch (error) {
    console.log(`[qa] report failed: ${String(error)}`)
  }

  if (mode === 'split') await checkNotification(win)
  if (mode === 'keys') await checkKeys(win)
}

/**
 * Proves the notification path rather than assuming it: blur the window, flip a
 * real pane into needing attention through the same code the monitor uses, and
 * confirm macOS accepted the notification.
 */
async function checkNotification(win: BrowserWindow): Promise<void> {
  const { Notification } = await import('electron')
  console.log(`[qa] notifications supported: ${Notification.isSupported()}`)

  win.blur()
  await delay(1200)
  console.log(`[qa] window focused after blur: ${win.isFocused()}`)

  const { updateAttention } = await import('./notify')
  const probe = () => [
    {
      id: 'qa-notification-probe',
      kind: 'claude' as const,
      cwd: process.cwd(),
      title: 'notification probe',
      status: 'needs-input' as const,
      startedAt: Date.now(),
      needsAttention: true,
      recentTools: [],
    },
  ]

  const first = updateAttention(probe(), win, (id) =>
    console.log(`[qa] notification click would focus ${id}`),
  )
  // Notifications fire on the transition, so a repeat of the same state must
  // stay silent — otherwise a busy agent would nag once per snapshot.
  const second = updateAttention(probe(), win, () => {})
  console.log(`[qa] notifications shown: first=${first} repeat=${second} (expect 1 and 0)`)
  await delay(1500)
}
