import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import type { SessionSnapshot } from '@shared/types'
import { SessionManager, type SessionManagerEvents } from './SessionManager'

// The real one shells out to `$SHELL -lic env`, which is slow and depends on
// whose machine the suite is running on.
vi.mock('../env', () => ({
  resolveUserEnv: async () => ({ SHELL: '/bin/zsh', PATH: '/usr/bin' }),
}))

// The cwd poller runs on a timer, and these tests advance the clock past it.
// Left real, it would run lsof against pids that never existed.
vi.mock('./cwdProbe', () => ({ probeCwds: async () => new Map<number, string>() }))

/**
 * Enough of node-pty to be wired up and then killed. `exit()` is the hook the
 * tests pull: it's what node-pty calls when the process on the other end dies,
 * whether that's the user quitting the agent or Torc killing the pane.
 */
class FakePty {
  static spawned: FakePty[] = []
  readonly pid = FakePty.spawned.length + 1000
  written: string[] = []
  killed = false
  resizedTo?: [number, number]
  private exitHandlers: Array<(e: { exitCode: number; signal?: number }) => void> = []
  /** Set once the pane stops listening, so a dead pty can refuse writes. */
  detached = false

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly cwd: string,
    readonly cols: number,
    readonly rows: number,
  ) {}

  onData() {}
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitHandlers.push(cb)
    return { dispose() {} }
  }
  write(data: string) {
    if (this.detached) throw new Error('write EPIPE')
    this.written.push(data)
  }
  resize(cols: number, rows: number) {
    this.resizedTo = [cols, rows]
  }
  kill() {
    this.killed = true
  }
  exit(exitCode = 0) {
    for (const handler of this.exitHandlers) handler({ exitCode })
  }
}

/** Records what the renderer and the fleet monitor would have been told. */
function recorder() {
  const calls: string[] = []
  const updates: SessionSnapshot[] = []
  const data: string[] = []
  const events: SessionManagerEvents = {
    onData: (_id, chunk) => {
      data.push(chunk)
    },
    onExit: (id) => {
      calls.push(`exit:${id}`)
    },
    onUpdate: (snapshot) => {
      calls.push('update')
      updates.push(snapshot)
    },
    onCreated: () => {
      calls.push('created')
    },
    onClosed: () => {
      calls.push('closed')
    },
  }
  return { events, calls, updates, data }
}

class TestManager extends SessionManager {
  /** Made to fail so the no-shell-to-fall-back-to path can be exercised. */
  spawnThrows = false

  protected spawnPty(
    file: string,
    args: string[],
    cwd: string,
    _env: Record<string, string>,
    cols: number,
    rows: number,
  ): IPty {
    if (this.spawnThrows) throw new Error('no such file')
    const fake = new FakePty(file, args, cwd, cols, rows)
    FakePty.spawned.push(fake)
    return fake as unknown as IPty
  }
}

/** The pty backing a pane right now — the last one spawned. */
const live = () => FakePty.spawned[FakePty.spawned.length - 1]

/** Long enough that the exit reads as a quit rather than a failure to launch. */
const RAN_A_WHILE = 5000

describe('SessionManager agent-exit fallback', () => {
  let rec: ReturnType<typeof recorder>
  let manager: TestManager

  beforeEach(() => {
    vi.useFakeTimers()
    FakePty.spawned = []
    rec = recorder()
    manager = new TestManager(rec.events)
  })

  afterEach(() => {
    manager.disposeAll()
    vi.useRealTimers()
  })

  /** Opens a pane and lets the clock run, so its exit isn't a launch failure. */
  async function openAgent(cwd = '/Users/b/Documents/side/torc') {
    const snapshot = await manager.create({ kind: 'claude', cwd })
    await vi.advanceTimersByTimeAsync(RAN_A_WHILE)
    rec.calls.length = 0
    rec.data.length = 0
    return snapshot
  }

  it('replaces an exited agent with a login shell in the same pane', async () => {
    const opened = await openAgent()
    live().exit(0)
    await vi.advanceTimersByTimeAsync(0)

    const pane = manager.get(opened.id)
    expect(pane).toBeDefined()
    expect(pane!.id).toBe(opened.id)
    expect(pane!.kind).toBe('shell')
    expect(pane!.status).toBe('idle')
    // Same directory, because that's where you were.
    expect(live().cwd).toBe(opened.cwd)
    expect(live().file).toBe('/bin/zsh')
    expect(live().args).toEqual(['-l'])
  })

  it('says why a shell prompt just appeared', async () => {
    await openAgent()
    live().exit(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.data.join('')).toContain('agent exited')

    const second = await openAgent('/Users/b/other')
    FakePty.spawned[FakePty.spawned.length - 1].exit(3)
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.data.join('')).toContain('agent exited with code 3')
    expect(manager.get(second.id)!.kind).toBe('shell')
  })

  it('leaves nothing of the old conversation on the snapshot', async () => {
    const opened = await openAgent()
    // Whatever the monitor had learned about the agent by the time it quit.
    manager.patch(opened.id, {
      aiTitle: 'Refactoring the status reducer',
      currentTool: { name: 'Edit', startedAt: 1 },
      recentTools: [{ name: 'Read', startedAt: 0 }],
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.42,
      needsAttention: true,
    })
    expect(manager.get(opened.id)!.aiTitle).toBe('Refactoring the status reducer')

    live().exit(0)
    await vi.advanceTimersByTimeAsync(0)

    const pane = manager.get(opened.id)!
    // A stale ai-title would have the rail describing a plain shell as a live
    // conversation; a stale session id would replay the finished transcript.
    expect(pane.aiTitle).toBeUndefined()
    expect(pane.claudeSessionId).toBeUndefined()
    expect(pane.currentTool).toBeUndefined()
    expect(pane.recentTools).toEqual([])
    expect(pane.tokens).toBeUndefined()
    expect(pane.costUsd).toBeUndefined()
    expect(pane.needsAttention).toBe(false)
    expect(pane.exitCode).toBeUndefined()
  })

  it('re-registers the pane so the monitor re-matches it by pid', async () => {
    const opened = await openAgent()
    const oldPid = live().pid
    live().exit(0)
    await vi.advanceTimersByTimeAsync(0)

    // Closed before created, or the monitor keeps the dead process's ancestry.
    expect(rec.calls.filter((c) => c === 'closed' || c === 'created')).toEqual([
      'closed',
      'created',
    ])
    expect(manager.describe().find((d) => d.id === opened.id)?.pid).not.toBe(oldPid)
  })

  it('opens the shell at the size the pane was last laid out at', async () => {
    const opened = await openAgent()
    manager.resize(opened.id, 132, 44)
    live().exit(0)
    await vi.advanceTimersByTimeAsync(0)

    expect([live().cols, live().rows]).toEqual([132, 44])
  })

  it('reports the exit as before when there is no shell to fall back to', async () => {
    const opened = await openAgent()
    manager.spawnThrows = true
    live().exit(1)
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.get(opened.id)).toBeUndefined()
    expect(rec.calls).toContain(`exit:${opened.id}`)
    expect(rec.calls).toContain('closed')
    expect(rec.calls).not.toContain('created')
  })
})

describe('SessionManager exits that must not fall back', () => {
  let rec: ReturnType<typeof recorder>
  let manager: TestManager

  beforeEach(() => {
    vi.useFakeTimers()
    FakePty.spawned = []
    rec = recorder()
    manager = new TestManager(rec.events)
  })

  afterEach(() => {
    manager.disposeAll()
    vi.useRealTimers()
  })

  it('closes a shell pane, because its exit really is the end of the pane', async () => {
    const opened = await manager.create({ kind: 'shell', cwd: '/Users/b' })
    await vi.advanceTimersByTimeAsync(RAN_A_WHILE)
    const before = FakePty.spawned.length

    live().exit(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.get(opened.id)).toBeUndefined()
    expect(FakePty.spawned.length).toBe(before)
  })

  it('does not resurrect a pane the user closed', async () => {
    const opened = await manager.create({ kind: 'claude', cwd: '/Users/b' })
    await vi.advanceTimersByTimeAsync(RAN_A_WHILE)
    const before = FakePty.spawned.length

    manager.kill(opened.id)
    live().exit(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.get(opened.id)).toBeUndefined()
    expect(FakePty.spawned.length).toBe(before)
  })

  it('does not resurrect a pane closed while the environment is resolving', async () => {
    const opened = await manager.create({ kind: 'claude', cwd: '/Users/b' })
    await vi.advanceTimersByTimeAsync(RAN_A_WHILE)
    const before = FakePty.spawned.length

    // The exit routes to the fallback, which awaits resolveUserEnv — and ⌘W
    // lands in that gap.
    live().exit(0)
    manager.kill(opened.id)
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.get(opened.id)).toBeUndefined()
    expect(FakePty.spawned.length).toBe(before)
  })

  it('reads an agent that died on launch as an error, not a shell', async () => {
    const opened = await manager.create({ kind: 'claude', cwd: '/Users/b' })
    await vi.advanceTimersByTimeAsync(1500)
    const before = FakePty.spawned.length

    live().exit(1)
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.get(opened.id)).toBeUndefined()
    expect(FakePty.spawned.length).toBe(before)
    const last = rec.updates[rec.updates.length - 1]
    expect(last.status).toBe('error')
    expect(last.exitCode).toBe(1)
    expect(last.needsAttention).toBe(true)
  })

  it('ignores an exit from a pty the pane has already replaced', async () => {
    const opened = await manager.create({ kind: 'claude', cwd: '/Users/b' })
    await vi.advanceTimersByTimeAsync(RAN_A_WHILE)
    const agentPty = live()

    agentPty.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    const shellPty = live()
    expect(shellPty).not.toBe(agentPty)

    // node-pty can deliver a late exit for the process that already went.
    agentPty.exit(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(manager.get(opened.id)).toBeDefined()
    expect(live()).toBe(shellPty)
  })
})

describe('SessionManager.write', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakePty.spawned = []
  })
  afterEach(() => vi.useRealTimers())

  it('drops a keystroke rather than taking down main', async () => {
    const rec = recorder()
    const manager = new TestManager(rec.events)
    const opened = await manager.create({ kind: 'claude', cwd: '/Users/b' })

    // A key pressed in the gap between the old process going and the
    // replacement being wired up.
    live().detached = true
    expect(() => manager.write(opened.id, 'x')).not.toThrow()

    manager.disposeAll()
  })

  it('ignores a write to a pane that no longer exists', () => {
    const manager = new TestManager(recorder().events)
    expect(() => manager.write('never-existed', 'x')).not.toThrow()
  })
})
