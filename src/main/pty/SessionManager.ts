import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import type { SessionSnapshot, SessionSpec } from '@shared/types'
import { HOOK_URL_ENV } from '@shared/brand'
import { resolveUserEnv } from '../env'
import { planLaunch } from './launchArgs'

// node-pty is a CommonJS native module and main is built as ESM; createRequire
// avoids the named-export interop guesswork.
const require = createRequire(import.meta.url)
const pty = require('node-pty') as typeof import('node-pty')

interface Session {
  snapshot: SessionSnapshot
  proc: IPty
  /** Coalescing buffer — see flush(). */
  pending: string[]
  flushTimer?: NodeJS.Timeout
}

export interface SessionManagerEvents {
  onData(id: string, chunk: string): void
  onExit(id: string, exitCode: number): void
  onUpdate(snapshot: SessionSnapshot): void
  /** Lets the fleet monitor start watching as soon as a pane exists. */
  onCreated?(snapshot: SessionSnapshot): void
  onClosed?(id: string): void
}

/** Injected once the hook bridge is listening. */
export interface AgentLaunchConfig {
  /** Path passed to `claude --settings` so Torc's hooks apply per session. */
  settingsPath?: string
  /** Value exported as $TORC_HOOK_URL in every PTY. */
  hookUrl?: string
}

/** Lightweight view used for process-ancestry matching. */
export interface SessionDescriptor {
  id: string
  kind: SessionSnapshot['kind']
  cwd: string
  pid?: number
}

/** Terminal output arrives in tiny bursts; batching keeps IPC off the hot path. */
const FLUSH_MS = 4

export class SessionManager {
  private sessions = new Map<string, Session>()
  private launchConfig: AgentLaunchConfig = {}

  constructor(private events: SessionManagerEvents) {}

  configureAgents(config: AgentLaunchConfig): void {
    this.launchConfig = config
  }

  async create(spec: SessionSpec): Promise<SessionSnapshot> {
    const env = await resolveUserEnv()
    const shell = env.SHELL || '/bin/zsh'
    const plan = planLaunch(spec, shell)

    // Hooks are injected per session, so the user's ~/.claude/settings.json is
    // never modified.
    if (spec.kind === 'claude' && this.launchConfig.settingsPath) {
      plan.args.push('--settings', this.launchConfig.settingsPath)
    }

    const id = randomUUID()
    const snapshot: SessionSnapshot = {
      id,
      claudeSessionId: plan.claudeSessionId,
      kind: spec.kind,
      cwd: spec.cwd,
      title: this.uniqueTitle(plan.title),
      status: 'launching',
      startedAt: Date.now(),
      needsAttention: false,
      recentTools: [],
      model: spec.model,
    }

    const proc = pty.spawn(plan.file, plan.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: spec.cwd,
      env: {
        ...env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // Claude Code reads this to label itself; harmless for plain shells.
        TERM_PROGRAM: 'Torc',
        // Present in shells too, so a `claude` the user runs by hand still
        // reports back if it picks up Torc's settings file.
        ...(this.launchConfig.hookUrl ? { [HOOK_URL_ENV]: this.launchConfig.hookUrl } : {}),
      },
    })

    const session: Session = { snapshot, proc, pending: [] }
    this.sessions.set(id, session)

    proc.onData((chunk) => this.enqueue(session, chunk))

    proc.onExit(({ exitCode }) => {
      this.flush(session)
      session.snapshot.status = exitCode === 0 ? 'exited' : 'error'
      session.snapshot.exitCode = exitCode
      session.snapshot.needsAttention = exitCode !== 0
      session.snapshot.currentTool = undefined
      this.events.onUpdate({ ...session.snapshot })
      this.events.onExit(id, exitCode)
      this.events.onClosed?.(id)
      this.sessions.delete(id)
    })

    // The real status arrives from FleetMonitor within a second or two; until
    // then the pane reads as launching.
    snapshot.status = spec.kind === 'shell' ? 'idle' : 'launching'
    this.events.onCreated?.({ ...snapshot })
    return { ...snapshot }
  }

  /** Merges monitor-derived fields into a snapshot and notifies the renderer. */
  patch(id: string, partial: Partial<SessionSnapshot>): void {
    const session = this.sessions.get(id)
    if (!session) return
    Object.assign(session.snapshot, partial)
    this.events.onUpdate({ ...session.snapshot })
  }

  describe(): SessionDescriptor[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.snapshot.id,
      kind: s.snapshot.kind,
      cwd: s.snapshot.cwd,
      pid: s.proc.pid,
    }))
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    // node-pty throws on non-positive dimensions, which happens while a pane is
    // still being laid out.
    if (cols < 1 || rows < 1) return
    try {
      session.proc.resize(cols, rows)
    } catch {
      // A process that exited between the check and the call — nothing to do.
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.proc.kill()
    } catch {
      // Already gone.
    }
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => ({ ...s.snapshot }))
  }

  get(id: string): SessionSnapshot | undefined {
    const snapshot = this.sessions.get(id)?.snapshot
    return snapshot ? { ...snapshot } : undefined
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  /**
   * Several panes in one repo all want to be called "torc"; number the repeats
   * so the rail and the palette stay tellable apart.
   */
  private uniqueTitle(base: string): string {
    const taken = new Set([...this.sessions.values()].map((s) => s.snapshot.title))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) {
      const candidate = `${base} ${n}`
      if (!taken.has(candidate)) return candidate
    }
  }

  private enqueue(session: Session, chunk: string): void {
    session.pending.push(chunk)
    if (session.flushTimer) return
    session.flushTimer = setTimeout(() => this.flush(session), FLUSH_MS)
  }

  private flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = undefined
    }
    if (session.pending.length === 0) return
    const payload = session.pending.join('')
    session.pending.length = 0
    this.events.onData(session.snapshot.id, payload)
  }
}
