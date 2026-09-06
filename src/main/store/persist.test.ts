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
      windows: [
        {
          activeIndex: 1,
          panes: [
            { kind: 'shell', cwd: '/tmp', title: 'tmp' },
            { kind: 'shell', cwd: '/var', title: 'var' },
          ],
        },
      ],
    })

    const loaded = loadState()
    expect(loaded?.theme).toBe('matrix')
    expect(loaded?.windows[0].activeIndex).toBe(1)
    expect(loaded?.windows[0].panes).toHaveLength(2)
  })

  it('keeps one window\'s panes out of another\'s', () => {
    // The whole point of the v2 shape: two windows, and neither one restores
    // the other's panes.
    saveState({
      windows: [
        { panes: [{ kind: 'shell', cwd: '/tmp', title: 'tmp' }] },
        { panes: [{ kind: 'shell', cwd: '/var', title: 'var' }], activeIndex: 0 },
      ],
    })

    const loaded = loadState()
    expect(loaded?.windows.map((w) => w.panes.map((p) => p.title))).toEqual([['tmp'], ['var']])
  })

  it('reads a single-window file from an older build as one window', () => {
    // Discarding it would silently lose the layout of anyone upgrading.
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        theme: 'matrix',
        activeIndex: 1,
        panes: [
          { kind: 'shell', cwd: '/tmp', title: 'tmp' },
          { kind: 'shell', cwd: '/var', title: 'var' },
        ],
      }),
    )

    const loaded = loadState()
    expect(loaded?.theme).toBe('matrix')
    expect(loaded?.windows).toHaveLength(1)
    expect(loaded?.windows[0].activeIndex).toBe(1)
    expect(loaded?.windows[0].panes.map((p) => p.title)).toEqual(['tmp', 'var'])
  })

  it('returns undefined when nothing has been saved', () => {
    expect(loadState()).toBeUndefined()
  })

  it('survives a corrupt state file rather than throwing', () => {
    writeFileSync(join(dir, 'state.json'), '{ not json')
    expect(loadState()).toBeUndefined()
  })

  it('ignores a state file from a future version', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 99, windows: [] }))
    expect(loadState()).toBeUndefined()
  })

  it('keeps every pane but only marks the resumable ones', () => {
    // Restoring the layout is the point. An agent whose transcript is gone
    // should still come back — as a fresh agent in the right repo, since
    // `claude --resume` on a missing session would just die.
    const cwd = mkdtempSync(join(tmpdir(), 'torc-repo-'))
    giveTranscript(cwd, 'kept-session')

    saveState({
      windows: [
        {
          panes: [
            { kind: 'claude', cwd, title: 'kept', claudeSessionId: 'kept-session' },
            { kind: 'claude', cwd, title: 'gone', claudeSessionId: 'no-such-session' },
            { kind: 'codex', cwd, title: 'codex', codexThreadId: 'thread-1' },
            { kind: 'shell', cwd, title: 'shell' },
          ],
        },
      ],
    })

    const panes = loadState()?.windows[0].panes
    expect(panes?.map((p) => p.title)).toEqual(['kept', 'gone', 'codex', 'shell'])
    expect(panes?.map((p) => p.resumable)).toEqual([true, false, true, false])
    // Kinds must survive: restoring an agent as a shell loses the agent.
    expect(panes?.map((p) => p.kind)).toEqual(['claude', 'claude', 'codex', 'shell'])
    rmSync(cwd, { recursive: true, force: true })
  })

  it('does not leave a temp file behind', () => {
    saveState({ windows: [{ panes: [{ kind: 'shell', cwd: '/tmp', title: 'tmp' }] }] })
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false)
  })
})
