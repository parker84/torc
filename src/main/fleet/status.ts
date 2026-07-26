import type { AgentStatus } from '@shared/types'

/**
 * Everything Torc knows about one agent, from all three sources. Kept as a
 * plain input bag so the derivation below stays pure and testable — the
 * priority order between sources is the part most likely to be got wrong.
 */
export interface StatusInputs {
  /** False once the PTY has exited. */
  ptyAlive: boolean
  exitCode?: number
  /** From `claude agents --json`. Absent until the session registers. */
  pollStatus?: 'busy' | 'idle' | string
  /** Notification hook fired and the user hasn't looked at the pane yet. */
  blocked?: boolean
  /** Stop hook fired (turn finished) and the pane hasn't been read since. */
  turnCompleteUnread?: boolean
  /** A tool call is open in the transcript. */
  toolRunning?: boolean
  /** Session has been seen by any source at all. */
  registered?: boolean
}

export interface DerivedStatus {
  status: AgentStatus
  needsAttention: boolean
}

/**
 * Source precedence, most to least authoritative:
 *   1. the PTY exited — nothing else matters
 *   2. a Notification hook — the agent is explicitly waiting on the user
 *   3. busy signals (poll or an open tool call) — it's working
 *   4. a completed turn nobody has read — done, and wants a look
 *   5. otherwise idle
 */
export function deriveStatus(inputs: StatusInputs): DerivedStatus {
  if (!inputs.ptyAlive) {
    const failed = inputs.exitCode !== undefined && inputs.exitCode !== 0
    return { status: failed ? 'error' : 'exited', needsAttention: failed }
  }

  if (inputs.blocked) return { status: 'needs-input', needsAttention: true }

  if (inputs.pollStatus === 'busy' || inputs.toolRunning) {
    return { status: 'working', needsAttention: false }
  }

  if (inputs.turnCompleteUnread) return { status: 'idle', needsAttention: true }

  // Nothing has reported in yet — a freshly spawned agent still booting.
  if (!inputs.registered) return { status: 'launching', needsAttention: false }

  return { status: 'idle', needsAttention: false }
}

/**
 * Rough USD cost. Rates are per million tokens for the default Opus tier and
 * exist to give the fleet view a sense of scale, not to bill anyone.
 */
const RATE_PER_MTOK = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }

export function estimateCostUsd(tokens: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}): number {
  return (
    (tokens.input * RATE_PER_MTOK.input +
      tokens.output * RATE_PER_MTOK.output +
      tokens.cacheWrite * RATE_PER_MTOK.cacheWrite +
      tokens.cacheRead * RATE_PER_MTOK.cacheRead) /
    1_000_000
  )
}
