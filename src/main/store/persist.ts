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
  /**
   * Whether `claude --resume` can actually pick this session up. Set by
   * loadState; a pane without it still comes back, just as a fresh agent.
   */
  resumable?: boolean
}

export interface SavedState {
  version: 1
  theme?: string
  panes: SavedPane[]
  activeIndex?: number
  savedAt: number
}

const CURRENT_VERSION = 1

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
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as SavedState
    if (parsed.version !== CURRENT_VERSION || !Array.isArray(parsed.panes)) return undefined

    // `claude --resume` fails on a session with no transcript — which is the
    // normal state for an agent that never took a turn. Keep the pane either
    // way and mark whether resuming is safe: restoring the layout is the point,
    // and a fresh agent in the right repo beats a missing pane or a dead one.
    const panes = parsed.panes.map((pane) => ({
      ...pane,
      resumable:
        pane.kind === 'claude' &&
        Boolean(pane.claudeSessionId) &&
        transcriptPath(pane.cwd, pane.claudeSessionId!) !== undefined,
    }))

    return { ...parsed, panes }
  } catch {
    return undefined
  }
}
