import type { SessionSnapshot } from '@shared/types'
import type { SessionManager } from '../pty/SessionManager'
import { AgentsPoller, isDescendantOf, processParents, type DiscoveredAgent } from './agentsPoller'
import { HookBridge, type HookEvent } from './bridge'
import { TranscriptTailer, type TranscriptState } from './transcript'
import { deriveStatus, estimateCostUsd } from './status'
import { CodexAppServer, type CodexEvent, type CodexThread } from './codexAppServer'

/**
 * Merges the three monitoring sources into the pane snapshots owned by
 * SessionManager: hook events for instant state edges, the transcript for
 * detail, and `claude agents --json` to reconcile and to discover agents the
 * user started by hand inside a ⌘T shell.
 */
interface PaneState {
  blocked: boolean
  turnCompleteUnread: boolean
  /** A prompt went in and no Stop has come back — see StatusInputs.turnActive. */
  turnActive: boolean
  registered: boolean
  pollStatus?: string
  transcript?: TranscriptState
  /** Claude session id, whether we assigned it or discovered it. */
  claudeSessionId?: string
  /** The claim has been confirmed against the registry at least once. */
  pollSeen: boolean
  /** Consecutive polls in which a confirmed claim was missing. */
  pollMisses: number
  codexThreadId?: string
  codexStatus?: CodexThread['status']
  codexName?: string
  codexModel?: string
  codexBranch?: string
  codexTokens?: SessionSnapshot['tokens']
  codexCurrentTool?: SessionSnapshot['currentTool']
  codexRecentTools: SessionSnapshot['recentTools']
}

/**
 * How many consecutive polls a claim has to be missing from
 * `claude agents --json` before the pane gives it up. One is not enough: the
 * registry is rewritten in place, so a poll landing mid-write can read a live
 * session as gone.
 */
const RELEASE_AFTER_MISSES = 2

export class FleetMonitor {
  private panes = new Map<string, PaneState>()
  private bridge: HookBridge
  private poller: AgentsPoller
  private tailer: TranscriptTailer
  private codex: CodexAppServer

  constructor(private sessions: SessionManager) {
    this.bridge = new HookBridge((event) => this.onHook(event))
    this.poller = new AgentsPoller((agents) => void this.onPoll(agents))
    this.tailer = new TranscriptTailer((paneId, state) => this.onTranscript(paneId, state))
    this.codex = new CodexAppServer((event) => this.onCodex(event))
  }

  async start(): Promise<void> {
    await this.bridge.start()
    try {
      await this.codex.start()
    } catch (error) {
      console.warn('torc: Codex monitoring unavailable', error)
    }
    this.poller.start()
  }

  get codexRemoteUrl(): string | undefined {
    return this.codex.remoteUrl
  }

  get hookUrl(): string {
    return this.bridge.url
  }

  stop(): void {
    this.poller.stop()
    this.tailer.dispose()
    this.bridge.stop()
    this.codex.stop()
  }

  /** Called by SessionManager whenever a pane opens. */
  track(snapshot: SessionSnapshot): void {
    this.panes.set(snapshot.id, {
      blocked: false,
      turnCompleteUnread: false,
      turnActive: false,
      registered: false,
      claudeSessionId: snapshot.claudeSessionId,
      pollSeen: false,
      pollMisses: 0,
      codexThreadId: snapshot.codexThreadId,
      codexRecentTools: [],
    })
    if (snapshot.claudeSessionId) {
      this.tailer.watch(snapshot.id, snapshot.cwd, snapshot.claudeSessionId)
    }
  }

  private onCodex(event: CodexEvent): void {
    if (process.env.TORC_DEBUG_CODEX) console.log(`[codex] ${event.type}`)
    if (event.type === 'thread') {
      this.claimCodexThread(event.thread)
      return
    }
    const entry = [...this.panes.entries()].find(([, pane]) => pane.codexThreadId === event.threadId)
    if (!entry) return
    const [paneId, pane] = entry
    pane.registered = true

    switch (event.type) {
      case 'status':
        pane.codexStatus = event.status
        pane.blocked = Boolean(event.status?.activeFlags?.some((flag) => flag.startsWith('waitingOn')))
        break
      case 'name':
        pane.codexName = event.name
        break
      case 'turn-started':
        pane.turnActive = true
        pane.turnCompleteUnread = false
        pane.blocked = false
        break
      case 'turn-completed':
        pane.turnActive = false
        pane.turnCompleteUnread = true
        if (event.failed) pane.blocked = false
        break
      case 'request':
        pane.blocked = true
        break
      case 'request-resolved':
        pane.blocked = false
        break
      case 'closed':
        pane.codexThreadId = undefined
        pane.codexStatus = undefined
        pane.codexName = undefined
        pane.codexModel = undefined
        pane.codexBranch = undefined
        pane.codexTokens = undefined
        pane.codexCurrentTool = undefined
        pane.codexRecentTools = []
        pane.registered = false
        pane.turnActive = false
        pane.blocked = false
        this.sessions.patch(paneId, {
          codexThreadId: undefined,
          aiTitle: undefined,
          currentTool: undefined,
          recentTools: [],
          tokens: undefined,
        })
        break
      case 'item-started': {
        const tool = this.codexTool(event.item, event.startedAt)
        if (tool) {
          pane.codexCurrentTool = tool
          pane.codexRecentTools = [tool, ...pane.codexRecentTools].slice(0, 12)
        }
        break
      }
      case 'item-completed':
        if (pane.codexCurrentTool && pane.codexCurrentTool.name === this.codexToolName(event.item)) {
          pane.codexCurrentTool.endedAt = event.completedAt
          pane.codexCurrentTool = undefined
        }
        break
      case 'tokens':
        pane.codexTokens = {
          input: event.usage.inputTokens ?? 0,
          output: event.usage.outputTokens ?? 0,
          cacheRead: event.usage.cachedInputTokens ?? 0,
          cacheWrite: event.usage.cacheWriteInputTokens ?? 0,
        }
        break
    }
    this.recompute(paneId)
  }

  private claimCodexThread(thread: CodexThread): void {
    if (!thread?.id || !thread.cwd) return
    if (thread.status?.type === 'notLoaded') return
    let entry = [...this.panes.entries()].find(([, pane]) => pane.codexThreadId === thread.id)
    if (!entry) {
      const candidates = this.sessions
        .describe()
        .filter(
          (snapshot) =>
            (snapshot.kind === 'codex' || snapshot.kind === 'shell') &&
            snapshot.cwd === thread.cwd,
        )
        .filter((snapshot) => !this.panes.get(snapshot.id)?.codexThreadId)
        .sort(
          (a, b) =>
            (this.sessions.get(a.id)?.startedAt ?? 0) -
            (this.sessions.get(b.id)?.startedAt ?? 0),
        )
      const owner = candidates[0]
      if (!owner) return
      const pane = this.panes.get(owner.id)
      if (!pane) return
      pane.codexThreadId = thread.id
      this.sessions.patch(owner.id, { codexThreadId: thread.id })
      entry = [owner.id, pane]
    }
    const [paneId, pane] = entry
    pane.registered = true
    pane.codexStatus = thread.status
    pane.codexName = thread.name || thread.preview
    pane.codexModel = thread.model
    pane.codexBranch = thread.gitInfo?.branch
    pane.blocked = Boolean(thread.status?.activeFlags?.some((flag) => flag.startsWith('waitingOn')))
    pane.turnActive = thread.status?.type === 'active' && !pane.blocked
    this.recompute(paneId)
  }

  private codexToolName(item: Record<string, unknown>): string | undefined {
    if (item.type === 'commandExecution') return 'Bash'
    if (item.type === 'fileChange') return 'Edit'
    if (item.type === 'mcpToolCall') return String(item.tool ?? 'MCP')
    if (item.type === 'dynamicToolCall') return String(item.tool ?? 'Tool')
    if (item.type === 'webSearch') return 'Web Search'
    if (item.type === 'imageGeneration') return 'Image Generation'
    return undefined
  }

  private codexTool(item: Record<string, unknown>, startedAt: number): SessionSnapshot['currentTool'] {
    const name = this.codexToolName(item)
    if (!name) return undefined
    const raw = item.command ?? item.cwd ?? item.server
    const summary = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').slice(0, 64) : undefined
    return { name, summary, startedAt }
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
        // The pane reads as working the instant the prompt goes in, rather than
        // waiting up to a poll for the registry to agree.
        pane.turnActive = true
        break
      case 'Stop':
        // Deliberately does not clear `blocked`: in plan mode the turn ends with
        // a pending approval prompt, and downgrading that to "finished" would
        // lose the very signal the user needs.
        pane.turnCompleteUnread = true
        pane.turnActive = false
        break
      case 'SessionEnd':
        pane.blocked = false
        pane.turnActive = false
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

    // Claim sessions we launched, and reconcile the ones we're already on.
    for (const [paneId, pane] of this.panes) {
      if (!pane.claudeSessionId) continue
      const agent = byId.get(pane.claudeSessionId)
      if (agent) {
        pane.pollStatus = agent.status
        // The registry is the reconciler: a missed Stop hook would otherwise
        // leave a finished pane reading as working for the rest of its life.
        if (agent.status === 'idle') pane.turnActive = false
        pane.registered = true
        pane.pollSeen = true
        pane.pollMisses = 0
        byId.delete(pane.claudeSessionId)
        this.recompute(paneId)
        continue
      }

      // The session we were following is gone. Quitting an agent and starting
      // another in the same shell pane is an ordinary thing to do, and a claim
      // we never let go of means the pane keeps reporting the dead session's
      // last state — usually "idle", while the new agent works.
      if (!pane.pollSeen) continue
      if (++pane.pollMisses < RELEASE_AFTER_MISSES) continue
      this.release(paneId, pane)
    }

    const unclaimed = [...byId.values()]
    if (unclaimed.length === 0) return

    // Anything left may be a `claude` the user typed into a pane themselves, or
    // the replacement for a claim just released. Match by process ancestry so
    // two panes in the same repo can't be confused.
    const openPanes = this.sessions.describe().filter((s) => !this.panes.get(s.id)?.claudeSessionId)
    if (openPanes.length === 0) return

    const parents = await processParents()
    for (const agent of unclaimed) {
      const owner = openPanes.find(
        (pane) => pane.pid !== undefined && isDescendantOf(agent.pid, pane.pid, parents),
      )
      if (!owner) continue
      const pane = this.panes.get(owner.id)
      if (!pane) continue

      pane.claudeSessionId = agent.sessionId
      pane.pollStatus = agent.status
      pane.registered = true
      pane.pollSeen = true
      pane.pollMisses = 0
      this.tailer.watch(owner.id, agent.cwd, agent.sessionId)
      this.sessions.patch(owner.id, { claudeSessionId: agent.sessionId })
      this.recompute(owner.id)
    }
  }

  /**
   * Lets go of a claude session that has left the registry, so the next poll
   * can adopt whatever is in the pane now. Everything below the id described
   * that conversation and not this pane — the same reasoning as
   * `SessionManager.fallBackToShell`, which drops it all when an agent Torc
   * launched quits.
   */
  private release(paneId: string, pane: PaneState): void {
    pane.claudeSessionId = undefined
    pane.pollStatus = undefined
    pane.pollSeen = false
    pane.pollMisses = 0
    pane.blocked = false
    pane.turnCompleteUnread = false
    pane.turnActive = false
    pane.transcript = undefined
    this.tailer.unwatch(paneId)
    this.sessions.patch(paneId, {
      claudeSessionId: undefined,
      aiTitle: undefined,
      currentTool: undefined,
      recentTools: [],
      tokens: undefined,
      costUsd: undefined,
    })
    this.recompute(paneId)
  }

  private recompute(paneId: string): void {
    const pane = this.panes.get(paneId)
    const snapshot = this.sessions.get(paneId)
    if (!pane || !snapshot) return

    const transcript = pane.transcript
    const isCodex = Boolean(pane.codexThreadId)
    const derived = deriveStatus({
      ptyAlive: snapshot.status !== 'exited' && snapshot.status !== 'error',
      exitCode: snapshot.exitCode,
      pollStatus: pane.pollStatus,
      blocked: pane.blocked,
      turnCompleteUnread: pane.turnCompleteUnread,
      toolRunning: Boolean(isCodex ? pane.codexCurrentTool : transcript?.currentTool),
      turnActive: pane.turnActive,
      registered: pane.registered,
    })

    this.sessions.patch(paneId, {
      status: derived.status,
      needsAttention: derived.needsAttention,
      aiTitle: isCodex ? pane.codexName : transcript?.aiTitle,
      model: isCodex ? pane.codexModel ?? snapshot.model : transcript?.model ?? snapshot.model,
      branch: isCodex ? pane.codexBranch : transcript?.branch,
      currentTool: isCodex ? pane.codexCurrentTool : transcript?.currentTool,
      recentTools: isCodex ? pane.codexRecentTools : transcript?.recentTools ?? [],
      tokens: isCodex ? pane.codexTokens : transcript?.tokens,
      // Codex subscription usage does not map reliably to API dollar pricing.
      costUsd: isCodex ? undefined : transcript ? estimateCostUsd(transcript.tokens) : undefined,
    })
  }
}
