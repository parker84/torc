import { describe, expect, it } from 'vitest'
import { planLaunch } from './launchArgs'

const SHELL = '/bin/zsh'

describe('planLaunch', () => {
  it('assigns a session id so the transcript path is known up front', () => {
    const plan = planLaunch({ kind: 'claude', cwd: '/Users/b/Documents/side/torc' }, SHELL)

    expect(plan.file).toBe('claude')
    expect(plan.claudeSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(plan.args).toContain('--session-id')
    expect(plan.args[plan.args.indexOf('--session-id') + 1]).toBe(plan.claudeSessionId)
  })

  it('titles a pane after the directory basename by default', () => {
    const plan = planLaunch({ kind: 'claude', cwd: '/Users/b/Documents/side/torc' }, SHELL)
    expect(plan.title).toBe('torc')
    expect(plan.args[plan.args.indexOf('--name') + 1]).toBe('torc')
  })

  it('resumes without minting a new id', () => {
    const existing = '937ec4aa-24e6-4d95-be57-a3bcbb4322b1'
    const plan = planLaunch({ kind: 'claude', cwd: '/tmp/x', resumeSessionId: existing }, SHELL)

    expect(plan.claudeSessionId).toBe(existing)
    expect(plan.args).toContain('--resume')
    // --session-id and --resume together would be contradictory.
    expect(plan.args).not.toContain('--session-id')
  })

  it('passes through model, permission mode and worktree', () => {
    const named = planLaunch(
      {
        kind: 'claude',
        cwd: '/tmp/x',
        model: 'opus',
        permissionMode: 'plan',
        worktree: 'fix-login',
      },
      SHELL,
    )
    expect(named.args).toEqual(expect.arrayContaining(['--model', 'opus']))
    expect(named.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
    expect(named.args).toEqual(expect.arrayContaining(['--worktree', 'fix-login']))

    const auto = planLaunch({ kind: 'claude', cwd: '/tmp/x', worktree: true }, SHELL)
    expect(auto.args).toContain('--worktree')
    expect(auto.args[auto.args.indexOf('--worktree') + 1]).toBeUndefined()
  })

  it('runs a login shell for shell panes and never mints a claude session id', () => {
    const plan = planLaunch({ kind: 'shell', cwd: '/tmp/x' }, SHELL)
    expect(plan.file).toBe(SHELL)
    expect(plan.args).toEqual(['-l'])
    expect(plan.claudeSessionId).toBeUndefined()
  })
})
