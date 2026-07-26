import { describe, expect, it } from 'vitest'
import { deriveStatus, estimateCostUsd } from './status'

const alive = { ptyAlive: true, registered: true }

describe('deriveStatus', () => {
  it('reports a clean exit without demanding attention', () => {
    expect(deriveStatus({ ptyAlive: false, exitCode: 0 })).toEqual({
      status: 'exited',
      needsAttention: false,
    })
  })

  it('flags a non-zero exit', () => {
    expect(deriveStatus({ ptyAlive: false, exitCode: 1 })).toEqual({
      status: 'error',
      needsAttention: true,
    })
  })

  it('puts a blocked agent above everything else', () => {
    // Even while the poller still says busy, a pending permission prompt wins.
    expect(deriveStatus({ ...alive, blocked: true, pollStatus: 'busy' })).toEqual({
      status: 'needs-input',
      needsAttention: true,
    })
  })

  it('treats an open tool call as working even before the poller catches up', () => {
    expect(deriveStatus({ ...alive, toolRunning: true })).toEqual({
      status: 'working',
      needsAttention: false,
    })
  })

  it('asks for a look when a turn finished unread', () => {
    expect(deriveStatus({ ...alive, turnCompleteUnread: true })).toEqual({
      status: 'idle',
      needsAttention: true,
    })
  })

  it('prefers working over an unread turn — the agent moved on', () => {
    expect(deriveStatus({ ...alive, turnCompleteUnread: true, pollStatus: 'busy' })).toEqual({
      status: 'working',
      needsAttention: false,
    })
  })

  it('shows a freshly spawned agent as launching until something reports in', () => {
    expect(deriveStatus({ ptyAlive: true, registered: false })).toEqual({
      status: 'launching',
      needsAttention: false,
    })
  })

  it('settles on idle once registered with nothing pending', () => {
    expect(deriveStatus({ ...alive, pollStatus: 'idle' })).toEqual({
      status: 'idle',
      needsAttention: false,
    })
  })
})

describe('estimateCostUsd', () => {
  it('is zero for an agent that has done nothing', () => {
    expect(estimateCostUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0)
  })

  it('weights output far above cache reads', () => {
    const output = estimateCostUsd({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })
    const cached = estimateCostUsd({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 })
    expect(output).toBeGreaterThan(cached * 10)
  })
})
