import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { settingsDir } from '../fleet/hooksSettings'
import { transcriptPath } from '../fleet/transcript'

/**
 * Layout survives a restart: which panes were open, in which repos, and which
 * Claude sessions they were running. Agents come back with `--resume`, so a
 * restart costs you a few seconds rather than the whole conversation.
 */
export interface SavedPane {
  kind: 'claude' | 'shell'
  cwd: string
  title: string
  claudeSessionId?: string
  /** Kept, or a restored pane would go back to being called after its folder. */
  renamed?: boolean
  /**
   * Whether `claude --resume` can actually pick this session up. Set by
   * loadState; a pane without it still comes back, just as a fresh agent.
   */
  resumable?: boolean
}

/** One window's worth of layout. A pane belongs to exactly one window. */
export interface SavedWindow {
  panes: SavedPane[]
  activeIndex?: number
}

export interface SavedState {
  version: 2
  theme?: string
  /** One entry per window, in the order the windows were opened. */
  windows: SavedWindow[]
  savedAt: number
}

/** The single-window file, written by every build before multiple windows. */
interface LegacyState {
  version: 1
  theme?: string
  panes: SavedPane[]
  activeIndex?: number
}

const CURRENT_VERSION = 2

function statePath(): string {
  return join(settingsDir(), 'state.json')
}

export function saveState(state: Omit<SavedState, 'version' | 'savedAt'>): void {
  try {
    mkdirSync(settingsDir(), { recursive: true })
    const payload: SavedState = { ...state, version: CURRENT_VERSION, savedAt: Date.now() }
    // Write-then-rename so a crash mid-write can't leave a truncated file that
    // would lose the layout it was meant to protect.
    const tmp = `${statePath()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
    renameSync(tmp, statePath())
  } catch {
    // Persistence is a convenience; never let it break the app.
  }
}

export function loadState(): SavedState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as SavedState | LegacyState
    const windows = readWindows(parsed)
    if (!windows) return undefined

    // `claude --resume` fails on a session with no transcript — which is the
    // normal state for an agent that never took a turn. Keep the pane either
    // way and mark whether resuming is safe: restoring the layout is the point,
    // and a fresh agent in the right repo beats a missing pane or a dead one.
    return {
      version: CURRENT_VERSION,
      theme: parsed.theme,
      savedAt: 'savedAt' in parsed ? parsed.savedAt : 0,
      windows: windows.map((window) => ({
        ...window,
        panes: window.panes.map((pane) => ({
          ...pane,
          resumable:
            pane.kind === 'claude' &&
            Boolean(pane.claudeSessionId) &&
            transcriptPath(pane.cwd, pane.claudeSessionId!) !== undefined,
        })),
      })),
    }
  } catch {
    return undefined
  }
}

/**
 * A file written before Torc had more than one window holds a bare pane list.
 * It becomes a single window rather than being discarded — dropping it would
 * silently lose the layout of anyone upgrading.
 */
function readWindows(parsed: SavedState | LegacyState): SavedWindow[] | undefined {
  if (parsed.version === 1) {
    return Array.isArray(parsed.panes)
      ? [{ panes: parsed.panes, activeIndex: parsed.activeIndex }]
      : undefined
  }
  if (parsed.version !== CURRENT_VERSION || !Array.isArray(parsed.windows)) return undefined
  return parsed.windows.filter((window) => window && Array.isArray(window.panes))
}
