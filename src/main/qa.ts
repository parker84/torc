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
    name: '07-synthwave',
    js: `window.__torc.store.getState().setTheme('synthwave'); window.__torc.store.getState().setView('workspace')`,
    waitMs: 900,
  },
  {
    name: '08-synthwave-mission',
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

export async function runQa(win: BrowserWindow, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  const steps = process.env.TORC_QA_MODE === 'restore' ? RESTORE_STEPS : STEPS

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
}
