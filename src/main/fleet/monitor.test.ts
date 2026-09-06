import { afterEach, describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '@shared/types'
import { FleetMonitor } from './monitor'
import type { DiscoveredAgent } from './agentsPoller'
import type { SessionManager } from '../pty/SessionManager'

/**
 * The monitor's own state is what decides whether a pane reports the agent
 * that's in it or the one that used to be, so these drive `onPoll` directly and
 * read the snapshots back out of a stand-in SessionManager. A real one would
 * mean real ptys for a question that has nothing to do with them.
 *
 * The pids are real: process ancestry is matched against `ps`, so a test pane
 * claims to be this process's parent and the agent claims to be this process —
 * which is a true parent/child pair in the live table.
 */
function fakeSessions(snapshots: SessionSnapshot[]) {
  const byId = new Map(snapshots.map((s) => [s.id, s]))
  return {
    describe: () => [...byId.values()].map((s) => ({ ...s, pid: process.ppid })),
    get: (id: string) => byId.get(id),
    patch: (id: string, partial: Partial<SessionSnapshot>) => {
      Object.assign(byId.get(id)!, partial)
    },
    snapshot: (id: string) => byId.get(id)!,
  }
}

function pane(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'pane-1',
    kind: 'shell',
    cwd: '/repo',
    title: 'repo',
    status: 'idle',
    startedAt: Date.now(),
    statusSince: Date.now(),
    needsAttention: false,
    recentTools: [],
    ...overrides,
  }
}

function agent(sessionId: string, status: string): DiscoveredAgent {
  return {
    pid: process.pid,
    cwd: '/repo',
    kind: 'interactive',
    startedAt: Date.now(),
    sessionId,
    name: sessionId,
    status,
  }
}

let monitor: FleetMonitor | undefined

function start(sessions: ReturnType<typeof fakeSessions>): FleetMonitor {
  monitor = new FleetMonitor(sessions as unknown as SessionManager)
  return monitor
}

/** Neither the poller nor the bridge is started, but the tailer ticks on watch. */
afterEach(() => {
  monitor?.stop()
  monitor = undefined
})

const poll = (m: FleetMonitor, agents: DiscoveredAgent[]) =>
  (m as unknown as { onPoll(a: DiscoveredAgent[]): Promise<void> }).onPoll(agents)

const codex = (m: FleetMonitor, event: object) =>
  (m as unknown as { onCodex(event: object): void }).onCodex(event)

describe('FleetMonitor claims', () => {
  it('adopts a claude the user started in a pane', async () => {
    const sessions = fakeSessions([pane()])
    const monitor = start(sessions)
    monitor.track(sessions.snapshot('pane-1'))

    await poll(monitor, [agent('first', 'busy')])

    expect(sessions.snapshot('pane-1').claudeSessionId).toBe('first')
    expect(sessions.snapshot('pane-1').status).toBe('working')
  })

  it('lets a claim go once its session leaves the registry', async () => {
    const sessions = fakeSessions([pane()])
    const monitor = start(sessions)
    monitor.track(sessions.snapshot('pane-1'))

    await poll(monitor, [agent('first', 'busy')])
    // One empty poll is not enough: the registry is rewritten in place.
    await poll(monitor, [])
    expect(sessions.snapshot('pane-1').claudeSessionId).toBe('first')

    await poll(monitor, [])
    expect(sessions.snapshot('pane-1').claudeSessionId).toBeUndefined()
  })

  it('picks up the next agent in the same pane, and reports its state', async () => {
    // The bug this exists for: quit the agent, run `claude` again, and the pane
    // used to report the dead session's last status — idle — for ever.
    const sessions = fakeSessions([pane()])
    const monitor = start(sessions)
    monitor.track(sessions.snapshot('pane-1'))

    await poll(monitor, [agent('first', 'idle')])
    await poll(monitor, [agent('second', 'busy')])
    await poll(monitor, [agent('second', 'busy')])

    expect(sessions.snapshot('pane-1').claudeSessionId).toBe('second')
    expect(sessions.snapshot('pane-1').status).toBe('working')
  })

  it('drops the finished conversation with the claim', async () => {
    const sessions = fakeSessions([pane()])
    const monitor = start(sessions)
    monitor.track(sessions.snapshot('pane-1'))

    await poll(monitor, [agent('first', 'idle')])
    sessions.patch('pane-1', {
      aiTitle: 'a conversation that ended',
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      costUsd: 1.5,
    })

    await poll(monitor, [])
    await poll(monitor, [])

    const after = sessions.snapshot('pane-1')
    expect(after.aiTitle).toBeUndefined()
    expect(after.tokens).toBeUndefined()
    expect(after.costUsd).toBeUndefined()
  })

  it('keeps an assigned session id that has not registered yet', async () => {
    // A claude Torc launched takes a couple of seconds to appear in the
    // registry. Nothing has gone stale — there is nothing to let go of.
    const sessions = fakeSessions([pane({ kind: 'claude', claudeSessionId: 'assigned' })])
    const monitor = start(sessions)
    monitor.track(sessions.snapshot('pane-1'))

    await poll(monitor, [])
    await poll(monitor, [])
    await poll(monitor, [])

    expect(sessions.snapshot('pane-1').claudeSessionId).toBe('assigned')
  })

  it('holds a pane at working through a long think', async () => {
    const sessions = fakeSessions([pane()])
    const monitor = start(sessions)
    monitor.track(sessions.snapshot('pane-1'))
    await poll(monitor, [agent('first', 'busy')])

    // Claude Code's registry reports a turn as busy from the prompt to the
    // Stop, so a think between two tool calls has to stay working.
    await poll(monitor, [agent('first', 'busy')])
    expect(sessions.snapshot('pane-1').status).toBe('working')

    await poll(monitor, [agent('first', 'idle')])
    expect(sessions.snapshot('pane-1').status).toBe('idle')
  })
})

describe('FleetMonitor Codex adapter', () => {
  it('maps structured thread telemetry onto its pane', () => {
    const sessions = fakeSessions([pane({ kind: 'codex' })])
    const monitor = start(sessions)
    monitor.track(sessions.snapshot('pane-1'))

    codex(monitor, {
      type: 'thread',
      thread: {
        id: 'thread-1',
        cwd: '/repo',
        name: 'Ship Codex monitoring',
        model: 'gpt-test',
        status: { type: 'active', activeFlags: [] },
        gitInfo: { branch: 'feature/codex' },
      },
    })
    codex(monitor, {
      type: 'item-started',
      threadId: 'thread-1',
      item: { type: 'commandExecution', command: 'npm test' },
      startedAt: 100,
    })
    codex(monitor, {
      type: 'tokens',
      threadId: 'thread-1',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 },
    })

    expect(sessions.snapshot('pane-1')).toMatchObject({
      codexThreadId: 'thread-1',
      aiTitle: 'Ship Codex monitoring',
      model: 'gpt-test',
      branch: 'feature/codex',
      status: 'working',
      currentTool: { name: 'Bash', summary: 'npm test' },
      tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0 },
    })
    expect(sessions.snapshot('pane-1').costUsd).toBeUndefined()
  })

  it('surfaces Codex approval waits as needing attention', () => {
    const sessions = fakeSessions([pane({ kind: 'codex' })])
    const monitor = start(sessions)
    monitor.track(sessions.snapshot('pane-1'))
    codex(monitor, {
      type: 'thread',
      thread: { id: 'thread-1', cwd: '/repo', status: { type: 'idle' } },
    })
    codex(monitor, {
      type: 'status',
      threadId: 'thread-1',
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    })

    expect(sessions.snapshot('pane-1')).toMatchObject({
      status: 'needs-input',
      needsAttention: true,
    })
  })
})
