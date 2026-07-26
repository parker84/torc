import type { SessionSnapshot } from '@shared/types'
import type { SessionManager } from '../pty/SessionManager'
import { AgentsPoller, isDescendantOf, processParents, type DiscoveredAgent } from './agentsPoller'
import { HookBridge, type HookEvent } from './bridge'
import { TranscriptTailer, type TranscriptState } from './transcript'
import { deriveStatus, estimateCostUsd } from './status'

/**
 * Merges the three monitoring sources into the pane snapshots owned by
 * SessionManager: hook events for instant state edges, the transcript for
 * detail, and `claude agents --json` to reconcile and to discover agents the
 * user started by hand inside a ⌘T shell.
 */
interface PaneState {
  blocked: boolean
  turnCompleteUnread: boolean
  registered: boolean
  pollStatus?: string
  transcript?: TranscriptState
  /** Claude session id, whether we assigned it or discovered it. */
  claudeSessionId?: string
}

export class FleetMonitor {
  private panes = new Map<string, PaneState>()
  private bridge: HookBridge
  private poller: AgentsPoller
  private tailer: TranscriptTailer

  constructor(private sessions: SessionManager) {
    this.bridge = new HookBridge((event) => this.onHook(event))
    this.poller = new AgentsPoller((agents) => void this.onPoll(agents))
    this.tailer = new TranscriptTailer((paneId, state) => this.onTranscript(paneId, state))
  }

  async start(): Promise<void> {
    await this.bridge.start()
    this.poller.start()
  }

  get hookUrl(): string {
    return this.bridge.url
  }

  stop(): void {
    this.poller.stop()
    this.tailer.dispose()
    this.bridge.stop()
  }

  /** Called by SessionManager whenever a pane opens. */
  track(snapshot: SessionSnapshot): void {
    this.panes.set(snapshot.id, {
      blocked: false,
      turnCompleteUnread: false,
      registered: false,
      claudeSessionId: snapshot.claudeSessionId,
    })
    if (snapshot.claudeSessionId) {
      this.tailer.watch(snapshot.id, snapshot.cwd, snapshot.claudeSessionId)
    }
  }

  untrack(paneId: string): void {
    this.panes.delete(paneId)
    this.tailer.unwatch(paneId)
  }

  /** The user looked at a pane, so anything "unread" no longer needs attention. */
  markRead(paneId: string): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    if (!pane.blocked && !pane.turnCompleteUnread) return
    pane.blocked = false
    pane.turnCompleteUnread = false
    this.recompute(paneId)
  }

  private onHook(event: HookEvent): void {
    const sessionId = event.session_id
    if (process.env.TORC_DEBUG_HOOKS) {
      console.log(`[hook] ${event.hook_event_name} ${event.tool_name ?? ''} ${sessionId ?? '?'}`)
    }
    if (!sessionId) return

    const entry = [...this.panes.entries()].find(
      ([, pane]) => pane.claudeSessionId === sessionId,
    )
    if (!entry) return
    const [paneId, pane] = entry

    pane.registered = true

    switch (event.hook_event_name) {
      case 'Notification': {
        // Notification covers both "needs permission" and a 60s idle nudge;
        // only the former should shout for attention.
        const message = typeof event.message === 'string' ? event.message.toLowerCase() : ''
        const idleNudge = message.includes('waiting for your input')
        pane.blocked = !idleNudge
        pane.turnCompleteUnread = pane.turnCompleteUnread || idleNudge
        break
      }
      case 'UserPromptSubmit':
      case 'PreToolUse':
        pane.blocked = false
        pane.turnCompleteUnread = false
        break
      case 'Stop':
        // Deliberately does not clear `blocked`: in plan mode the turn ends with
        // a pending approval prompt, and downgrading that to "finished" would
        // lose the very signal the user needs.
        pane.turnCompleteUnread = true
        break
      case 'SessionEnd':
        pane.blocked = false
        break
      default:
        break
    }

    this.recompute(paneId)
  }

  private onTranscript(paneId: string, state: TranscriptState): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    pane.transcript = state
    pane.registered = true
    this.recompute(paneId)
  }

  private async onPoll(agents: DiscoveredAgent[]): Promise<void> {
    const byId = new Map(agents.map((agent) => [agent.sessionId, agent]))

    // Claim sessions we launched.
    for (const [paneId, pane] of this.panes) {
      if (!pane.claudeSessionId) continue
      const agent = byId.get(pane.claudeSessionId)
      if (!agent) continue
      pane.pollStatus = agent.status
      pane.registered = true
      byId.delete(pane.claudeSessionId)
      this.recompute(paneId)
    }

    const unclaimed = [...byId.values()]
    if (unclaimed.length === 0) return

    // Anything left may be a `claude` the user typed into a shell pane. Match by
    // process ancestry so two panes in the same repo can't be confused.
    const shellPanes = this.sessions
      .describe()
      .filter((s) => s.kind === 'shell' && !this.panes.get(s.id)?.claudeSessionId)
    if (shellPanes.length === 0) return

    const parents = await processParents()
    for (const agent of unclaimed) {
      const owner = shellPanes.find(
        (pane) => pane.pid !== undefined && isDescendantOf(agent.pid, pane.pid, parents),
      )
      if (!owner) continue
      const pane = this.panes.get(owner.id)
      if (!pane) continue

      pane.claudeSessionId = agent.sessionId
      pane.pollStatus = agent.status
      pane.registered = true
      this.tailer.watch(owner.id, agent.cwd, agent.sessionId)
      this.sessions.patch(owner.id, { claudeSessionId: agent.sessionId })
      this.recompute(owner.id)
    }
  }

  private recompute(paneId: string): void {
    const pane = this.panes.get(paneId)
    const snapshot = this.sessions.get(paneId)
    if (!pane || !snapshot) return

    const transcript = pane.transcript
    const derived = deriveStatus({
      ptyAlive: snapshot.status !== 'exited' && snapshot.status !== 'error',
      exitCode: snapshot.exitCode,
      pollStatus: pane.pollStatus,
      blocked: pane.blocked,
      turnCompleteUnread: pane.turnCompleteUnread,
      toolRunning: Boolean(transcript?.currentTool),
      registered: pane.registered,
    })

    this.sessions.patch(paneId, {
      status: derived.status,
      needsAttention: derived.needsAttention,
      aiTitle: transcript?.aiTitle,
      model: transcript?.model ?? snapshot.model,
      branch: transcript?.branch,
      currentTool: transcript?.currentTool,
      recentTools: transcript?.recentTools ?? [],
      tokens: transcript?.tokens,
      costUsd: transcript ? estimateCostUsd(transcript.tokens) : undefined,
    })
  }
}
