import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import type { SessionSnapshot, SessionSpec } from '@shared/types'
import { HOOK_URL_ENV } from '@shared/brand'
import { resolveUserEnv } from '../env'
import { probeCwds } from './cwdProbe'
import { planLaunch } from './launchArgs'
import { isAutoTitle, titleFor, uniqueTitle } from './paneTitle'

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
  /** Last size the renderer asked for, so a respawn opens at the right size. */
  cols: number
  rows: number
  /** Set by kill(): the pane is going away, so don't fall back to a shell. */
  closing?: boolean
  /**
   * True while the title is Torc's own guess at a name, which is what lets it
   * follow the pane into a new directory. A title the user typed stays put.
   */
  autoTitle: boolean
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
  /**
   * Directory holding the `claude` shim, prepended to each pane's PATH so a
   * hand-launched agent gets the same hooks as one Torc spawned.
   */
  shimDir?: string
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

/** How often panes are asked where they've got to. See startCwdWatch(). */
const CWD_POLL_MS = 2000

export class SessionManager {
  private sessions = new Map<string, Session>()
  private launchConfig: AgentLaunchConfig = {}
  private cwdTimer?: NodeJS.Timeout
  private cwdProbing = false

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

    const proc = this.spawnPty(plan.file, plan.args, spec.cwd, env, 80, 24)

    const session: Session = {
      snapshot,
      proc,
      pending: [],
      cols: 80,
      rows: 24,
      // A restored or restarted pane comes back with the title we derived last
      // time, so "is this Torc's guess?" is a question about the string, not
      // about who passed it in.
      autoTitle: isAutoTitle(snapshot.title, spec.cwd),
    }
    this.sessions.set(id, session)
    this.wire(session, spec.kind === 'shell')
    this.startCwdWatch()

    // The real status arrives from FleetMonitor within a second or two; until
    // then the pane reads as launching.
    snapshot.status = spec.kind === 'shell' ? 'idle' : 'launching'
    this.events.onCreated?.({ ...snapshot })
    return { ...snapshot }
  }

  /**
   * Protected rather than private so a test can hand back a fake pty: the exit
   * routing below has five conditions that only differ by *which* process died
   * and when, and driving those with real processes is both slow and racy.
   */
  protected spawnPty(
    file: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
  ): IPty {
    return pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...env,
        // The shim goes first so `claude` typed into a shell picks it up.
        ...(this.launchConfig.shimDir
          ? { PATH: `${this.launchConfig.shimDir}:${env.PATH ?? ''}` }
          : {}),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // Claude Code reads this to label itself; harmless for plain shells.
        TERM_PROGRAM: 'Torc',
        // Present in shells too, so a `claude` the user runs by hand still
        // reports back if it picks up Torc's settings file.
        ...(this.launchConfig.hookUrl ? { [HOOK_URL_ENV]: this.launchConfig.hookUrl } : {}),
      },
    })
  }

  /**
   * Hooks a freshly spawned pty up to the pane. Called again on respawn, so
   * everything here has to be safe to repeat.
   */
  private wire(session: Session, isShell: boolean): void {
    const { proc } = session
    const id = session.snapshot.id

    proc.onData((chunk) => this.enqueue(session, chunk))

    // A login shell re-reads .zprofile/.zshrc, which typically prepends
    // ~/.local/bin and so pushes our shim behind the real claude. PATH set at
    // spawn time can't win that, so re-assert it once the rc files have run,
    // then clear so the pane looks untouched.
    if (isShell && this.launchConfig.shimDir) {
      const shimDir = this.launchConfig.shimDir
      setTimeout(() => {
        // Only if this is still the pane's live process — a respawn or a close
        // in the meantime means this write belongs to nothing.
        if (this.sessions.get(id)?.proc !== proc) return
        proc.write(`export PATH="${shimDir}:$PATH"; clear\r`)
      }, 700)
    }

    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(id)?.proc !== proc) return
      this.flush(session)

      // Quitting the agent shouldn't leave a dead pane behind: ⌃C ⌃C out of
      // Claude Code lands you back at a shell prompt in the same directory,
      // which is what it does in any other terminal. Only for panes Torc
      // launched `claude` in directly — a shell pane's exit really is the end
      // of the pane, and an explicit close must not resurrect itself. An agent
      // that died in the first couple of seconds never started: that's a launch
      // failure, and it should read as an error rather than quietly become a
      // shell.
      const ranFor = Date.now() - session.snapshot.startedAt
      if (session.snapshot.kind === 'claude' && !session.closing && ranFor > 2000) {
        void this.fallBackToShell(session, exitCode)
        return
      }

      this.teardown(session, exitCode)
    })
  }

  /**
   * Ends a pane for good: the renderer drops it, the monitor stops watching,
   * and the id is forgotten. Every route out of a pty's exit ends here except
   * the one that puts a shell in the pane's place.
   */
  private teardown(session: Session, exitCode: number): void {
    const id = session.snapshot.id
    session.snapshot.status = exitCode === 0 ? 'exited' : 'error'
    session.snapshot.exitCode = exitCode
    session.snapshot.needsAttention = exitCode !== 0
    session.snapshot.currentTool = undefined
    this.events.onUpdate({ ...session.snapshot })
    this.events.onExit(id, exitCode)
    this.events.onClosed?.(id)
    this.sessions.delete(id)
  }

  /**
   * Replaces an exited agent with a login shell in the same pane, keeping the
   * pane id — and so the scrollback the agent left behind.
   */
  private async fallBackToShell(session: Session, exitCode: number): Promise<void> {
    const id = session.snapshot.id
    const env = await resolveUserEnv()
    // Something else already owns this id; it is not ours to replace.
    if (this.sessions.get(id) !== session) return
    // ⌘W landed while we were resolving the environment. The exit that got us
    // here was this pane's last, so nothing else is coming to close it — do it
    // now, or the pane is orphaned in the map with no process behind it.
    if (session.closing) {
      this.teardown(session, exitCode)
      return
    }

    const shell = env.SHELL || '/bin/zsh'
    let proc: IPty
    try {
      proc = this.spawnPty(shell, ['-l'], session.snapshot.cwd, env, session.cols, session.rows)
    } catch {
      // No shell to fall back to; report the exit as before.
      this.teardown(session, exitCode)
      return
    }

    // A prompt appearing on its own is confusing without a word about why.
    const why = exitCode === 0 ? 'agent exited' : `agent exited with code ${exitCode}`
    this.events.onData(id, `\r\n\x1b[2m— ${why}; back in your shell —\x1b[0m\r\n`)

    session.proc = proc
    session.snapshot.kind = 'shell'
    session.snapshot.status = 'idle'
    session.snapshot.exitCode = undefined
    session.snapshot.needsAttention = false
    session.snapshot.startedAt = Date.now()
    // Everything below belonged to the agent that just quit. Leaving any of it
    // on would have the rail describing a plain shell as a live conversation —
    // and re-watching the finished transcript would replay its whole history.
    // Claude prints its own `claude --resume` line on the way out, which is a
    // better offer than a stale session id nobody can see.
    session.snapshot.claudeSessionId = undefined
    session.snapshot.aiTitle = undefined
    session.snapshot.currentTool = undefined
    session.snapshot.recentTools = []
    session.snapshot.tokens = undefined
    session.snapshot.costUsd = undefined

    // Re-registered rather than patched: the monitor matches panes by process
    // ancestry, and the pid just changed.
    this.events.onClosed?.(id)
    this.wire(session, true)
    this.events.onUpdate({ ...session.snapshot })
    this.events.onCreated?.({ ...session.snapshot })
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
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.proc.write(data)
    } catch {
      // Written into the gap between a process exiting and its replacement
      // being wired up. Dropping the keystroke beats taking down main.
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    // node-pty throws on non-positive dimensions, which happens while a pane is
    // still being laid out.
    if (cols < 1 || rows < 1) return
    // Remembered so a shell that replaces an exited agent opens at pane size.
    session.cols = cols
    session.rows = rows
    try {
      session.proc.resize(cols, rows)
    } catch {
      // A process that exited between the check and the call — nothing to do.
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.closing = true
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
    if (this.cwdTimer) clearInterval(this.cwdTimer)
    this.cwdTimer = undefined
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  /** Numbers repeats against every other pane's title: `torc`, then `torc 2`. */
  private uniqueTitle(base: string, exceptId?: string): string {
    const taken = [...this.sessions.values()]
      .filter((s) => s.snapshot.id !== exceptId)
      .map((s) => s.snapshot.title)
    return uniqueTitle(base, taken)
  }

  /**
   * A pane that `cd`s into another repo is in another repo — and the rail,
   * Mission Control, the title strip and the ⌘K jump list all describe a pane by
   * its cwd and the name derived from it. Nothing in the output stream announces
   * a `cd`, so the working directory has to be polled; see cwdProbe.ts.
   *
   * Started with the first pane rather than in the constructor, so a fleet of
   * none costs nothing.
   */
  private startCwdWatch(): void {
    if (this.cwdTimer) return
    this.cwdTimer = setInterval(() => void this.syncCwds(), CWD_POLL_MS)
    this.cwdTimer.unref?.()
  }

  private async syncCwds(): Promise<void> {
    // A slow probe must not stack up behind itself.
    if (this.cwdProbing || this.sessions.size === 0) return
    this.cwdProbing = true
    try {
      // The pid is captured alongside the session: an agent that exits into a
      // shell gets a new process, and a reading from the old one is worthless.
      const live = [...this.sessions.values()].map((session) => ({
        session,
        pid: session.proc.pid,
      }))
      const cwds = await probeCwds(live.map((entry) => entry.pid))

      for (const { session, pid } of live) {
        if (this.sessions.get(session.snapshot.id) !== session) continue
        if (session.proc.pid !== pid) continue
        const cwd = cwds.get(pid)
        if (!cwd || cwd === session.snapshot.cwd) continue

        session.snapshot.cwd = cwd
        // Claude's own `--name` was fixed at launch and can't be changed from out
        // here; the rail prefers its ai-title anyway once there is one.
        if (session.autoTitle) {
          session.snapshot.title = this.uniqueTitle(titleFor(cwd), session.snapshot.id)
        }
        this.events.onUpdate({ ...session.snapshot })
      }
    } finally {
      this.cwdProbing = false
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
