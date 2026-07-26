import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module reads its directory through hooksSettings.settingsDir, so point
// that at a scratch dir rather than the real ~/.torc.
let dir: string
vi.mock('../fleet/hooksSettings', () => ({ settingsDir: () => dir }))

const { loadState, saveState } = await import('./persist')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'torc-persist-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Creates the transcript file a claude pane needs in order to be restorable. */
function giveTranscript(cwd: string, sessionId: string): void {
  const projects = join(process.env.HOME ?? tmpdir(), '.claude', 'projects')
  const slug = cwd.replace(/\//g, '-')
  mkdirSync(join(projects, slug), { recursive: true })
  writeFileSync(join(projects, slug, `${sessionId}.jsonl`), '')
}

describe('persist', () => {
  it('round-trips a layout', () => {
    saveState({
      theme: 'matrix',
      activeIndex: 1,
      panes: [
        { kind: 'shell', cwd: '/tmp', title: 'tmp' },
        { kind: 'shell', cwd: '/var', title: 'var' },
      ],
    })

    const loaded = loadState()
    expect(loaded?.theme).toBe('matrix')
    expect(loaded?.activeIndex).toBe(1)
    expect(loaded?.panes).toHaveLength(2)
  })

  it('returns undefined when nothing has been saved', () => {
    expect(loadState()).toBeUndefined()
  })

  it('survives a corrupt state file rather than throwing', () => {
    writeFileSync(join(dir, 'state.json'), '{ not json')
    expect(loadState()).toBeUndefined()
  })

  it('ignores a state file from a future version', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 99, panes: [] }))
    expect(loadState()).toBeUndefined()
  })

  it('keeps every pane but only marks the resumable ones', () => {
    // Restoring the layout is the point. An agent whose transcript is gone
    // should still come back — as a fresh agent in the right repo, since
    // `claude --resume` on a missing session would just die.
    const cwd = mkdtempSync(join(tmpdir(), 'torc-repo-'))
    giveTranscript(cwd, 'kept-session')

    saveState({
      panes: [
        { kind: 'claude', cwd, title: 'kept', claudeSessionId: 'kept-session' },
        { kind: 'claude', cwd, title: 'gone', claudeSessionId: 'no-such-session' },
        { kind: 'shell', cwd, title: 'shell' },
      ],
    })

    const loaded = loadState()
    expect(loaded?.panes.map((p) => p.title)).toEqual(['kept', 'gone', 'shell'])
    expect(loaded?.panes.map((p) => p.resumable)).toEqual([true, false, false])
    // Kinds must survive: restoring an agent as a shell loses the agent.
    expect(loaded?.panes.map((p) => p.kind)).toEqual(['claude', 'claude', 'shell'])
    rmSync(cwd, { recursive: true, force: true })
  })

  it('does not leave a temp file behind', () => {
    saveState({ panes: [{ kind: 'shell', cwd: '/tmp', title: 'tmp' }] })
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false)
  })
})
